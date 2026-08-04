/**
 * Source fetching: pin a ref to an exact commit, then materialize the repo tree
 * into a content-addressed cache.
 *
 * No `git` binary is required. Commits are resolved through each host's REST
 * API, falling back to git's smart-HTTP ref-advertisement endpoint (which every
 * git server speaks over plain HTTP). Trees arrive as tarballs via `giget`.
 */

import { join } from "node:path";

import { downloadTemplate, type TemplateInfo, type TemplateProvider } from "giget";

import { AuthError, SourceResolutionError } from "./errors.js";
import { ensureDir, listFiles, pathExists, removeDir, writeFileAtomic } from "./fsutil.js";
import { describeSource, normalizeGitUrl, providerForSource, sourceRepoPath } from "./refs.js";
import type { PrimitiveSource } from "./types.js";

const SHA_RE = /^[0-9a-f]{40}$/i;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface FetchContext {
  cacheDir: string;
  /** Token for this source, already resolved. Never logged. */
  token?: string;
  timeoutMs?: number;
  /** Reuse an already-extracted tree without revalidating. Default true. */
  useCache?: boolean;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const authHeaders = (token: string | undefined): Record<string, string> =>
  token ? { authorization: `Bearer ${token}` } : {};

const httpGet = async (
  url: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "user-agent": "agent-outfitter", ...init.headers },
      signal: controller.signal,
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
};

const isAuthFailure = (status: number): boolean => status === 401 || status === 403;

/**
 * Outcome of one commit-resolution attempt.
 *
 * An auth failure is reported rather than thrown so a later attempt still runs:
 * plenty of hosts gate their REST API while serving the git endpoint
 * anonymously, and vice versa. Only when every attempt has failed does the
 * caller decide whether the right error is "denied" or "not found".
 */
interface ResolveAttempt {
  commit?: string;
  authFailed?: boolean;
}

// ---------------------------------------------------------------------------
// Commit resolution
// ---------------------------------------------------------------------------

const gitlabProjectPath = (source: PrimitiveSource): string =>
  encodeURIComponent(sourceRepoPath(source) ?? "");

const apiCommitUrl = (source: PrimitiveSource & { type: "git" }): string | undefined => {
  const provider = providerForSource(source);
  const repoPath = sourceRepoPath(source);
  if (!repoPath) return undefined;
  const ref = source.ref ?? "HEAD";
  const origin = new URL(normalizeGitUrl(source.url)).origin;

  switch (provider) {
    case "github":
      return `https://api.github.com/repos/${repoPath}/commits/${encodeURIComponent(ref)}`;
    case "gitlab":
      return `${origin}/api/v4/projects/${gitlabProjectPath(source)}/repository/commits/${encodeURIComponent(ref)}`;
    case "bitbucket":
      return `https://api.bitbucket.org/2.0/repositories/${repoPath}/commit/${encodeURIComponent(ref)}`;
    default:
      return undefined;
  }
};

const commitFromApi = async (
  source: PrimitiveSource & { type: "git" },
  ctx: FetchContext,
): Promise<ResolveAttempt> => {
  const url = apiCommitUrl(source);
  if (!url) return {};

  const provider = providerForSource(source);
  const headers: Record<string, string> = { ...authHeaders(ctx.token) };
  if (provider === "github") headers.accept = "application/vnd.github.sha";

  let response: Response;
  try {
    response = await httpGet(url, { headers, ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}) });
  } catch {
    return {}; // Network hiccup — let the smart-HTTP fallback try.
  }
  if (isAuthFailure(response.status)) return { authFailed: true };
  if (!response.ok) return {};

  if (provider === "github") {
    const sha = (await response.text()).trim();
    return SHA_RE.test(sha) ? { commit: sha } : {};
  }
  const body = (await response.json().catch(() => undefined)) as
    | { id?: string; hash?: string }
    | undefined;
  const sha = body?.id ?? body?.hash;
  return typeof sha === "string" && sha.length >= 7 ? { commit: sha } : {};
};

/** Parse git's pkt-line framing into its payload lines. */
export const parsePktLines = (payload: string): string[] => {
  const lines: string[] = [];
  let i = 0;
  while (i + 4 <= payload.length) {
    const lengthHex = payload.slice(i, i + 4);
    const length = Number.parseInt(lengthHex, 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      i += 4; // flush-pkt
      continue;
    }
    if (length < 4 || i + length > payload.length) break;
    lines.push(payload.slice(i + 4, i + length).replace(/\n$/, ""));
    i += length;
  }
  return lines;
};

/** Ref-name -> SHA map from a smart-HTTP ref advertisement. */
export const parseRefAdvertisement = (payload: string): Map<string, string> => {
  const refs = new Map<string, string>();
  for (const line of parsePktLines(payload)) {
    if (line.startsWith("#")) continue;
    const [head] = line.split("\0");
    const match = /^([0-9a-f]{40})\s+(\S+)$/.exec((head ?? "").trim());
    if (match) refs.set(match[2]!, match[1]!);
  }
  return refs;
};

/**
 * Pick the commit for `ref` from an advertisement.
 *
 * An annotated tag advertises both the tag object (`refs/tags/x`) and the
 * commit it points at (`refs/tags/x^{}`); the peeled entry is what we want.
 */
export const selectRefCommit = (refs: Map<string, string>, ref: string | undefined): string | undefined => {
  if (!ref) return refs.get("HEAD") ?? refs.get("refs/heads/main") ?? refs.get("refs/heads/master");
  return (
    refs.get(`refs/tags/${ref}^{}`) ??
    refs.get(`refs/heads/${ref}`) ??
    refs.get(`refs/tags/${ref}`) ??
    refs.get(ref) ??
    refs.get(`refs/${ref}`)
  );
};

const commitFromSmartHttp = async (
  source: PrimitiveSource & { type: "git" },
  ctx: FetchContext,
): Promise<ResolveAttempt> => {
  const url = `${normalizeGitUrl(source.url)}/info/refs?service=git-upload-pack`;
  let response: Response;
  try {
    response = await httpGet(url, {
      headers: { ...authHeaders(ctx.token), accept: "*/*" },
      ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}),
    });
  } catch {
    return {};
  }
  if (isAuthFailure(response.status)) return { authFailed: true };
  if (!response.ok) return {};
  const commit = selectRefCommit(parseRefAdvertisement(await response.text()), source.ref);
  return commit ? { commit } : {};
};

/**
 * Resolve a branch/tag to the exact commit SHA recorded in the lockfile.
 *
 * Doing this at resolve time is what makes `sync()` reproducible: a tag that
 * later moves does not change what a locked install fetches.
 */
export const resolveCommit = async (source: PrimitiveSource, ctx: FetchContext): Promise<string> => {
  if (source.type === "local") return "";
  // A full SHA is already immutable; asking the host to confirm it wastes a
  // round trip and would fail for a commit not reachable from any ref.
  if (source.ref && SHA_RE.test(source.ref)) return source.ref.toLowerCase();

  const fromApi = await commitFromApi(source, ctx);
  if (fromApi.commit) return fromApi.commit;

  const fromGit = await commitFromSmartHttp(source, ctx);
  if (fromGit.commit) return fromGit.commit;

  const target = source.ref ? `ref "${source.ref}"` : "the default branch";
  if (fromApi.authFailed || fromGit.authFailed) {
    throw new AuthError(
      `Access denied resolving ${target} for ${describeSource(source)}. Provide a token via ` +
        `the source's "auth" field or the manager's "auth" resolver.`,
      { source: describeSource(source), ref: source.ref },
    );
  }
  throw new SourceResolutionError(
    `Could not resolve ${target} for ${describeSource(source)} to a commit. The repository may ` +
      `be unreachable, or the ref may not exist.`,
    { source: describeSource(source), ref: source.ref },
  );
};

// ---------------------------------------------------------------------------
// Tree fetching
// ---------------------------------------------------------------------------

const tarballUrl = (source: PrimitiveSource & { type: "git" }, commit: string): string => {
  const provider = providerForSource(source);
  const repoPath = sourceRepoPath(source);
  const origin = new URL(normalizeGitUrl(source.url)).origin;

  switch (provider) {
    case "github": {
      // Honors GitHub Enterprise via the source URL's own origin.
      const api = origin === "https://github.com" ? "https://api.github.com" : `${origin}/api/v3`;
      return `${api}/repos/${repoPath}/tarball/${commit}`;
    }
    case "gitlab":
      return `${origin}/api/v4/projects/${gitlabProjectPath(source)}/repository/archive.tar.gz?sha=${commit}`;
    case "bitbucket":
      return `${origin}/${repoPath}/get/${commit}.tar.gz`;
    case "sourcehut":
      return `${origin}/${repoPath}/archive/${commit}.tar.gz`;
    default:
      // Self-hosted. GitLab and Gitea/Forgejo cover nearly all of what is left,
      // and both accept this path shape.
      return `${origin}/${repoPath}/archive/${commit}.tar.gz`;
  }
};

/** Where an extracted repo tree lives. Keyed by commit, so it is immutable. */
export const repoCachePath = (
  cacheDir: string,
  source: PrimitiveSource,
  commit: string,
): string => {
  if (source.type === "local") return source.path;
  const url = new URL(normalizeGitUrl(source.url));
  const repoPath = (sourceRepoPath(source) ?? "repo").replace(/[^\w./-]/g, "-");
  return join(cacheDir, "repos", url.hostname, ...repoPath.split("/"), commit);
};

/**
 * Marker for a completed extraction, kept *beside* the tree rather than inside
 * it — a repo root can itself be a skill folder, and the marker must never end
 * up in a skill's file list or content hash.
 */
const cacheSentinelPath = (dest: string): string => `${dest}.complete`;

/**
 * Fetch a repo tree at `commit` into the cache and return its root.
 *
 * The cache is content-addressed by commit, so a hit needs no revalidation. A
 * partially extracted tree left by an interrupted run has no sentinel and is
 * discarded rather than reused.
 */
export const fetchRepoTree = async (
  source: PrimitiveSource,
  commit: string,
  ctx: FetchContext,
): Promise<string> => {
  if (source.type === "local") {
    if (!(await pathExists(source.path))) {
      throw new SourceResolutionError(`Local source path ${source.path} does not exist.`, {
        path: source.path,
      });
    }
    return source.path;
  }

  const dest = repoCachePath(ctx.cacheDir, source, commit);
  const sentinel = cacheSentinelPath(dest);

  if (ctx.useCache !== false && (await pathExists(sentinel))) return dest;

  await removeDir(dest);
  await ensureDir(dest);

  const info: TemplateInfo = {
    name: `${new URL(normalizeGitUrl(source.url)).hostname}-${sourceRepoPath(source) ?? "repo"}`
      .replace(/[^\da-z-]/gi, "-")
      .toLowerCase(),
    version: commit,
    tar: tarballUrl(source, commit),
    headers: {
      ...authHeaders(ctx.token),
      ...(providerForSource(source) === "github"
        ? { accept: "application/vnd.github+json" }
        : {}),
    },
  };
  const provider: TemplateProvider = () => info;

  try {
    await downloadTemplate("outfitter:tree", {
      providers: { outfitter: provider },
      registry: false,
      dir: dest,
      force: true,
      ...(ctx.token ? { auth: ctx.token } : {}),
    });
  } catch (error) {
    await removeDir(dest);
    const message = (error as Error).message;
    if (/\b(401|403)\b/.test(message)) {
      throw new AuthError(
        `Access denied fetching ${describeSource(source)} at ${commit.slice(0, 7)}. ` +
          `Check the token supplied for this source.`,
        { commit },
      );
    }
    throw new SourceResolutionError(
      `Failed to fetch ${describeSource(source)} at ${commit.slice(0, 7)}: ${message}`,
      { commit, source: describeSource(source) },
    );
  }

  await writeFileAtomic(sentinel, `${commit}\n`);
  return dest;
};

export const listTreeFiles = async (root: string): Promise<string[]> => listFiles(root);
