/**
 * Ref grammar: `<provider>:<owner>/<repo>[/<subdir>][#<ref>]`
 *
 * Mirrors giget, extended with `local:` and raw git URLs. Providers:
 * `github` (`gh`), `gitlab`, `bitbucket`, `sourcehut`, `git`, `local` (`file`).
 */

import { isAbsolute, resolve as resolvePath } from "node:path";

import { SourceResolutionError } from "./errors.js";
import type {
  AuthRef,
  GitProvider,
  NormalizedRef,
  SkillRef,
  SkillSource,
  StructuredSkillRef,
} from "./types.js";

const PROVIDER_ALIASES: Record<string, GitProvider | "local"> = {
  github: "github",
  gh: "github",
  gitlab: "gitlab",
  bitbucket: "bitbucket",
  bb: "bitbucket",
  sourcehut: "sourcehut",
  sh: "sourcehut",
  git: "git",
  local: "local",
  file: "local",
};

const PROVIDER_HOSTS: Record<Exclude<GitProvider, "git">, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  sourcehut: "git.sr.ht",
};

const KNOWN_HOST_PROVIDERS: Record<string, GitProvider> = {
  "github.com": "github",
  "www.github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
  "git.sr.ht": "sourcehut",
};

const isUrlLike = (value: string): boolean =>
  /^(https?:\/\/|ssh:\/\/|git@|git\+)/.test(value);

/** Normalize `git@host:owner/repo.git` and `git+https://…` to an https URL. */
export const normalizeGitUrl = (raw: string): string => {
  let url = raw.replace(/^git\+/, "");
  const scp = /^git@([^:]+):(.+)$/.exec(url);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  if (url.startsWith("ssh://git@")) url = `https://${url.slice("ssh://git@".length)}`;
  if (!url.endsWith(".git") && !url.includes("?")) url = `${url.replace(/\/$/, "")}.git`;
  return url;
};

/** Host of a git source, or `undefined` for local sources / unparseable URLs. */
export const sourceHost = (source: SkillSource): string | undefined => {
  if (source.type !== "git") return undefined;
  try {
    return new URL(normalizeGitUrl(source.url)).hostname;
  } catch {
    return undefined;
  }
};

/** `owner` segment of a git source path, or `undefined`. */
export const sourceOwner = (source: SkillSource): string | undefined => {
  if (source.type !== "git") return undefined;
  try {
    const { pathname } = new URL(normalizeGitUrl(source.url));
    const segments = pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    return segments.length >= 2 ? segments[0] : undefined;
  } catch {
    return undefined;
  }
};

/** `owner/repo` for a git source (subgroups collapse into the owner segment). */
export const sourceRepoPath = (source: SkillSource): string | undefined => {
  if (source.type !== "git") return undefined;
  try {
    const { pathname } = new URL(normalizeGitUrl(source.url));
    return pathname.replace(/^\//, "").replace(/\.git$/, "");
  } catch {
    return undefined;
  }
};

export const providerForSource = (source: SkillSource): GitProvider => {
  if (source.type !== "git") return "git";
  if (source.provider) return source.provider;
  const host = sourceHost(source);
  return (host ? KNOWN_HOST_PROVIDERS[host] : undefined) ?? "git";
};

/**
 * Parse a ref string into a source.
 *
 * `root` anchors relative `local:` paths; defaults to the process cwd.
 */
export const parseRefString = (
  input: string,
  options: { root?: string; auth?: AuthRef } = {},
): { source: SkillSource } => {
  const raw = input.trim();
  if (raw.length === 0) throw new SourceResolutionError("Empty source ref.");

  const root = options.root ?? process.cwd();

  // Bare filesystem paths are a convenience: "./skills", "/abs/path", "../x".
  if (raw.startsWith(".") || isAbsolute(raw)) {
    return { source: { type: "local", path: resolvePath(root, raw) } };
  }

  const colon = raw.indexOf(":");
  const scheme = colon === -1 ? "" : raw.slice(0, colon).toLowerCase();
  const provider = PROVIDER_ALIASES[scheme];

  // A bare URL with no skillsmith scheme (`https://github.com/...`).
  if (!provider && isUrlLike(raw)) {
    return { source: gitSourceFromUrl(raw, options.auth) };
  }

  if (!provider) {
    throw new SourceResolutionError(
      `Unrecognized source ref "${input}". Expected "<provider>:<owner>/<repo>[/<subdir>][#<ref>]" ` +
        `with provider one of ${Object.keys(PROVIDER_ALIASES).join(", ")}, or a git URL.`,
      { ref: input },
    );
  }

  const rest = raw.slice(colon + 1);

  if (provider === "local") {
    const [pathPart] = splitRef(rest);
    if (pathPart.length === 0) {
      throw new SourceResolutionError(`Local source ref "${input}" has no path.`, { ref: input });
    }
    return { source: { type: "local", path: resolvePath(root, pathPart) } };
  }

  if (provider === "git") {
    // `git:https://host/owner/repo.git#ref` — the rest is a URL, possibly with a fragment.
    const [urlPart, gitRef] = splitRef(rest);
    const source = gitSourceFromUrl(urlPart, options.auth);
    if (gitRef) source.ref = gitRef;
    return { source };
  }

  const [pathPart, gitRef] = splitRef(rest);
  const segments = pathPart.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) {
    throw new SourceResolutionError(
      `Source ref "${input}" is missing an owner or repo (expected "${scheme}:owner/repo[/subdir]").`,
      { ref: input },
    );
  }
  const [owner, repo, ...subdirSegments] = segments as [string, string, ...string[]];
  const host = PROVIDER_HOSTS[provider];
  const source: SkillSource = {
    type: "git",
    url: `https://${host}/${owner}/${repo}.git`,
    provider,
  };
  if (subdirSegments.length > 0) source.subdir = subdirSegments.join("/");
  if (gitRef) source.ref = gitRef;
  if (options.auth) source.auth = options.auth;
  return { source };
};

const splitRef = (value: string): [string, string | undefined] => {
  const hash = value.lastIndexOf("#");
  if (hash === -1) return [value, undefined];
  const ref = value.slice(hash + 1);
  return [value.slice(0, hash), ref.length > 0 ? ref : undefined];
};

const gitSourceFromUrl = (rawUrl: string, auth?: AuthRef): SkillSource & { type: "git" } => {
  const [urlPart, gitRef] = splitRef(rawUrl);
  const url = normalizeGitUrl(urlPart);
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new SourceResolutionError(`Could not parse git URL "${rawUrl}".`, { ref: rawUrl });
  }
  const source: SkillSource & { type: "git" } = {
    type: "git",
    url,
    provider: KNOWN_HOST_PROVIDERS[host] ?? "git",
  };
  if (gitRef) source.ref = gitRef;
  if (auth) source.auth = auth;
  return source;
};

const toArray = (value: string | string[] | undefined): string[] | undefined => {
  if (value === undefined) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  return arr.length > 0 ? arr : undefined;
};

/** Turn any accepted ref shape into the resolver's `NormalizedRef`. */
export const normalizeRef = (ref: SkillRef, options: { root?: string } = {}): NormalizedRef => {
  if (typeof ref === "string") {
    const { source } = parseRefString(ref, options);
    return { source };
  }
  const structured = ref as StructuredSkillRef;
  const normalized: NormalizedRef = { source: structured.source };
  const select = toArray(structured.select);
  if (select) normalized.select = select;
  if (structured.skillsRoot) normalized.skillsRoot = structured.skillsRoot;
  return normalized;
};

/** Stable identity for a source, used for cache keys and dedupe. */
export const sourceKey = (source: SkillSource): string => {
  if (source.type === "local") return `local:${source.path}`;
  return `git:${normalizeGitUrl(source.url)}#${source.ref ?? "HEAD"}`;
};

/** Human-readable source label — never contains a token. */
export const describeSource = (source: SkillSource): string => {
  if (source.type === "local") return `local:${source.path}`;
  const repo = sourceRepoPath(source) ?? source.url;
  const sub = source.subdir ? `/${source.subdir}` : "";
  const ref = source.ref ? `#${source.ref}` : "";
  return `${providerForSource(source)}:${repo}${sub}${ref}`;
};
