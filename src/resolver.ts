/**
 * Resolution: manifest/refs -> transitive primitive graph + install plan.
 *
 * Network reads only. Nothing outside the cache directory is written, which is
 * what makes `resolve()` safe to call for dry runs, diffing, and policy checks.
 *
 * The walk is breadth-first over sources. Each wave lists a source's skills
 * from frontmatter alone, hashes the trees it selected, and enqueues whatever
 * those skills declare — further skills, MCP servers, instruction fragments, and
 * (recorded but not installed) the remaining primitive kinds.
 */

import { DEFAULT_CONCURRENCY, mapLimit } from "./concurrency.js";
import { discoverSkills } from "./discover.js";
import { CycleError, PolicyViolationError } from "./errors.js";
import { hashString, hashTree } from "./hash.js";
import { listFiles } from "./fsutil.js";
import { assertSourceAllowed, decideInstructionTrust, decideMcpTrust } from "./policy.js";
import { discoverInstructions, resolveInstruction } from "./primitives/instruction.js";
import { resolveMcpServer } from "./primitives/mcp.js";
import { describeSource, normalizeRef, sourceHost, sourceKey, sourceOwner } from "./refs.js";
import { selectProvider, type SourceProvider } from "./sources/index.js";
import { checkTree, scanTextForHiddenUnicode } from "./verify.js";
import type {
  AuthResolver,
  EventSink,
  InstructionRefEntry,
  NamedMcpServer,
  NormalizedRef,
  Primitive,
  ResolvedInstruction,
  ResolvedMcpServer,
  ResolvedPolicy,
  ResolvedSkill,
  Resolution,
  PrimitiveRef,
  PrimitiveSource,
  OutfitterWarning,
} from "./types.js";

export interface ResolverOptions {
  refs: NormalizedRef[];
  mcp: NamedMcpServer[];
  instructions: InstructionRefEntry[];
  policy: ResolvedPolicy;
  cacheDir: string;
  root: string;
  providers: SourceProvider[];
  auth?: AuthResolver;
  emit: EventSink;
  concurrency?: number;
}

interface QueueItem {
  ref: NormalizedRef;
  /** `"manifest"` for a root ref, otherwise the skill that declared it. */
  declaredBy: string;
  transitive: boolean;
}

export const resolveGraph = async (options: ResolverOptions): Promise<Resolution> => {
  const {
    refs,
    policy,
    cacheDir,
    providers,
    auth,
    emit,
    concurrency = DEFAULT_CONCURRENCY,
  } = options;

  const warnings: OutfitterWarning[] = [];
  const warn = (warning: OutfitterWarning): void => {
    warnings.push(warning);
    emit({ type: "warning", warning });
  };

  const skills = new Map<string, ResolvedSkill>();
  const mcp = new Map<string, ResolvedMcpServer>();
  const instructions = new Map<string, ResolvedInstruction>();
  const unsupported: Primitive[] = [];

  // Memoized per source so a monorepo referenced by ten skills is fetched once.
  const revisions = new Map<string, Promise<string>>();
  const trees = new Map<string, Promise<string>>();
  const visitedRefs = new Set<string>();

  emit({ type: "resolve:start", refs: refs.length });

  // Manifest-declared MCP servers are trusted by definition.
  for (const entry of options.mcp) {
    addMcp(mcp, resolveMcpServer(entry, "manifest", true), warn);
  }

  const tokenFor = async (source: PrimitiveSource): Promise<string | undefined> => {
    if (source.type !== "git") return undefined;
    if (source.auth) {
      if ("token" in source.auth) return source.auth.token;
      const value = process.env[source.auth.env];
      if (value) return value;
    }
    if (auth) {
      return auth(sourceHost(source) ?? "", sourceOwner(source) ?? "");
    }
    return undefined;
  };

  const materialize = async (ref: NormalizedRef): Promise<{ tree: string; revision: string }> => {
    const provider = selectProvider(ref.source, providers);
    const key = sourceKey(ref.source);

    const onRetry = (info: {
      attempt: number;
      of: number;
      delayMs: number;
      reason: string;
    }): void => {
      emit({ type: "source:retry", source: ref.source, ...info });
    };

    let revisionPromise = revisions.get(key);
    if (!revisionPromise) {
      revisionPromise = (async () => {
        const token = await tokenFor(ref.source);
        return provider.resolveRevision(ref.source, {
          cacheDir,
          onRetry,
          ...(token ? { token } : {}),
        });
      })();
      revisions.set(key, revisionPromise);
    }
    const revision = await revisionPromise;

    const treeKey = `${key}@${revision}`;
    let treePromise = trees.get(treeKey);
    if (!treePromise) {
      treePromise = (async () => {
        const token = await tokenFor(ref.source);
        return provider.materializeTree(ref.source, revision, {
          cacheDir,
          onRetry,
          ...(token ? { token } : {}),
        });
      })();
      trees.set(treeKey, treePromise);
    }
    return { tree: await treePromise, revision };
  };

  const hashInstructionContent = (content: string): string => hashString(content);

  /**
   * Resolve instruction fragments for one entry.
   *
   * Fragments are scanned for hidden Unicode whenever the policy is on, because
   * unlike a skill's supporting files this text goes straight into the agent's
   * standing context — the highest-value place to hide an invisible directive.
   */
  const resolveInstructionEntry = async (
    entry: InstructionRefEntry,
    declaredBy: string,
  ): Promise<void> => {
    const decision = decideInstructionTrust(entry.name ?? entry.ref, declaredBy, policy);
    if (!decision.trusted) {
      if (decision.warning) warn(decision.warning);
      return;
    }

    const normalized = normalizeRef(entry.ref, { root: options.root });
    assertSourceAllowed(normalized.source, policy);
    const origin = describeSource(normalized.source);
    const { tree, revision } = await materialize(normalized);
    const subdir = normalized.source.type === "git" ? (normalized.source.subdir ?? "") : "";
    const base =
      normalized.source.type === "local"
        ? "" // a local ref already points at the file or directory
        : subdir;

    const found = await discoverInstructions(
      normalized.source.type === "local" ? normalized.source.path : tree,
      base,
      entry,
      origin,
    );

    for (const fragment of found) {
      const existing = instructions.get(fragment.name);
      if (existing) {
        if (existing.contentHash !== hashInstructionContent(fragment.content)) {
          warn({
            code: "instruction-conflict",
            subject: fragment.name,
            message:
              `Instruction fragment "${fragment.name}" is declared twice with different content ` +
              `(by "${existing.declaredBy}" and "${declaredBy}"). Keeping the ` +
              `${existing.declaredBy === "manifest" ? "manifest" : `"${existing.declaredBy}"`} version.`,
            detail: { kept: existing.declaredBy, ignored: declaredBy },
          });
        }
        continue;
      }

      if (policy.scan !== "off") {
        const findings = scanTextForHiddenUnicode(
          fragment.content,
          fragment.subdir || fragment.name,
        );
        if (findings.length > 0) {
          const summary = findings
            .slice(0, 5)
            .map((f) => `${f.file}:${f.line}:${f.column} ${f.codePoint} (${f.label})`)
            .join(", ");
          if (policy.scan === "deny") {
            throw new PolicyViolationError(
              `Instruction fragment "${fragment.name}" contains hidden Unicode characters and ` +
                `policy.scan is "deny": ${summary}`,
              { name: fragment.name, findings },
            );
          }
          warn({
            code: "hidden-unicode",
            subject: fragment.name,
            message:
              `Instruction fragment "${fragment.name}" contains ${findings.length} hidden ` +
              `Unicode character(s) — this text is spliced into the agent's context: ${summary}`,
            detail: { findings },
          });
        }
      }

      instructions.set(
        fragment.name,
        resolveInstruction(fragment, {
          source: normalized.source,
          ref: normalized.source.type === "git" ? (normalized.source.ref ?? "") : "",
          commit: revision,
          declaredBy,
          trusted: true,
        }),
      );
    }
  };

  // Manifest-declared instruction fragments, resolved before the skill walk so a
  // skill that names the same fragment loses the conflict to the operator.
  for (const entry of options.instructions) {
    await resolveInstructionEntry(entry, "manifest");
  }

  let queue: QueueItem[] = refs.map((ref) => ({
    ref,
    declaredBy: "manifest",
    transitive: false,
  }));

  while (queue.length > 0) {
    const wave = queue.filter((item) => {
      const key = `${sourceKey(item.ref.source)}|${item.ref.source.type === "git" ? (item.ref.source.subdir ?? "") : ""}|${(item.ref.select ?? []).join(",")}|${item.ref.skillsRoot ?? ""}`;
      if (visitedRefs.has(key)) return false;
      visitedRefs.add(key);
      return true;
    });
    queue = [];
    if (wave.length === 0) break;

    const waveResults = await mapLimit(wave, concurrency, async (item) => {
      assertSourceAllowed(item.ref.source, policy);
      const origin = describeSource(item.ref.source);
      const { tree, revision } = await materialize(item.ref);
      const discovered = await discoverSkills(tree, item.ref, origin);
      emit({
        type: "source:listed",
        source: item.ref.source,
        skills: discovered.map((d) => d.name),
      });
      return { item, origin, tree, revision, discovered };
    });

    for (const { item, origin, revision, discovered } of waveResults) {
      for (const found of discovered) {
        const existing = skills.get(found.name);
        if (existing) {
          // `stagedDir` is the exact folder the bytes came from — for git it
          // includes the commit, for local it is the folder itself — so it is a
          // sound identity test for "is this the same skill or a collision?".
          if (existing.stagedDir !== found.dir) {
            warn({
              code: "duplicate-skill",
              subject: found.name,
              message:
                `Skill "${found.name}" is provided by both ${describeSource(existing.source)} ` +
                `and ${origin}. Keeping the first. Namespace the skills or narrow "select" ` +
                `to make the choice explicit.`,
              detail: { kept: describeSource(existing.source), ignored: origin },
            });
          }
          continue;
        }

        const files = await listFiles(found.dir);
        const { contentHash } = await hashTree(found.dir, files);
        emit({ type: "skill:fetched", name: found.name, commit: revision, stagedDir: found.dir });

        const check = await checkTree(found.name, found.dir, files, policy);
        for (const w of check.warnings) warn(w);
        emit({ type: "skill:verified", name: found.name, contentHash });

        // Git sources pin the skill's subdir within the repo; local sources
        // record the skill folder itself, so nothing has to be re-derived when
        // the lockfile is replayed.
        const source: PrimitiveSource =
          item.ref.source.type === "git"
            ? { ...item.ref.source, subdir: found.subdir }
            : { type: "local", path: found.dir };
        // A token supplied inline must not survive into the resolution graph.
        if (source.type === "git" && source.auth && "token" in source.auth) delete source.auth;

        const dependsOn: string[] = [];
        const mcpDependencies: string[] = [];

        for (const depRef of found.dependencies.skills) {
          queue.push({
            ref: normalizeDependencyRef(depRef, found.dir),
            declaredBy: found.name,
            transitive: true,
          });
        }

        for (const server of found.dependencies.mcp) {
          const decision = decideMcpTrust(server.name, server, found.name, policy);
          if (!decision.trusted) {
            if (decision.warning) warn(decision.warning);
            continue;
          }
          const resolved = resolveMcpServer(server, found.name, true);
          addMcp(mcp, resolved, warn);
          mcpDependencies.push(server.name);
        }

        for (const entry of found.dependencies.instructions) {
          await resolveInstructionEntry(entry, found.name);
        }

        for (const primitive of found.dependencies.unsupported) {
          unsupported.push(primitive);
          warn({
            code: "not-implemented",
            subject: primitive.name,
            message:
              `Skill "${found.name}" depends on a ${primitive.kind} ("${primitive.name}"). ` +
              `agent-outfitter records ${primitive.kind} primitives but does not install them yet.`,
            detail: { kind: primitive.kind, declaredBy: found.name },
          });
        }

        skills.set(found.name, {
          name: found.name,
          description: found.description,
          meta: found.meta,
          files,
          dependencies: found.dependencies,
          source,
          ref: item.ref.source.type === "git" ? (item.ref.source.ref ?? "") : "",
          commit: revision,
          subdir: found.subdir,
          contentHash,
          stagedDir: found.dir,
          dependsOn,
          mcpDependencies,
          transitive: item.transitive,
        });
      }
    }
  }

  // Dependency edges are wired after the closure so that a dependency declared
  // before its provider was visited still resolves.
  linkDependencies(skills, warn);

  const order = topologicalOrder(skills);

  emit({
    type: "resolve:done",
    skills: skills.size,
    mcp: mcp.size,
    instructions: instructions.size,
    warnings: warnings.length,
  });

  return { order, skills, mcp, instructions, warnings, unsupported };
};

/**
 * Resolve a dependency ref declared inside a skill.
 *
 * Relative `local:` paths anchor to the declaring skill's own folder, the same
 * way a relative path in any other file does — so a sibling skill is `../name`.
 */
const normalizeDependencyRef = (ref: PrimitiveRef, declaringSkillDir: string): NormalizedRef =>
  normalizeRef(ref, { root: declaringSkillDir });

const addMcp = (
  map: Map<string, ResolvedMcpServer>,
  server: ResolvedMcpServer,
  warn: (w: OutfitterWarning) => void,
): void => {
  const existing = map.get(server.name);
  if (!existing) {
    map.set(server.name, server);
    return;
  }
  if (existing.configHash === server.configHash) return;

  // A manifest declaration is the operator's explicit choice; it wins.
  const manifestWins = existing.declaredBy === "manifest";
  warn({
    code: "mcp-conflict",
    subject: server.name,
    message:
      `MCP server "${server.name}" is declared twice with different configuration ` +
      `(by "${existing.declaredBy}" and "${server.declaredBy}"). Keeping the ` +
      `${manifestWins ? "manifest" : `"${existing.declaredBy}"`} definition.`,
    detail: { kept: existing.declaredBy, ignored: server.declaredBy },
  });
  if (!manifestWins && server.declaredBy === "manifest") map.set(server.name, server);
};

/** Populate `dependsOn` with the resolved names of each skill's skill deps. */
const linkDependencies = (
  skills: Map<string, ResolvedSkill>,
  warn: (w: OutfitterWarning) => void,
): void => {
  // Index by subdir basename as well as name: a dependency ref points at a
  // folder, while the graph is keyed by the declared skill name.
  const bySubdir = new Map<string, string>();
  for (const skill of skills.values()) {
    const leaf = skill.subdir.split("/").pop();
    if (leaf) bySubdir.set(leaf, skill.name);
  }

  for (const skill of skills.values()) {
    for (const dep of skill.dependencies.skills) {
      const wanted = dependencyTargetNames(dep);
      const match = wanted.find((n) => skills.has(n)) ?? wanted.map((n) => bySubdir.get(n)).find(Boolean);
      if (!match) {
        warn({
          code: "source",
          subject: skill.name,
          message:
            `Could not link dependency ${JSON.stringify(wanted[0] ?? dep)} declared by ` +
            `"${skill.name}" to a resolved skill. It was fetched but its name did not match; ` +
            `install order for it is not guaranteed.`,
          detail: { declaredBy: skill.name },
        });
        continue;
      }
      if (match !== skill.name && !skill.dependsOn.includes(match)) skill.dependsOn.push(match);
    }
  }
};

/** Candidate skill names a dependency ref could refer to (last path segment first). */
const dependencyTargetNames = (ref: PrimitiveRef): string[] => {
  if (typeof ref === "string") {
    const withoutRef = ref.split("#")[0] ?? ref;
    const leaf = withoutRef.split("/").filter(Boolean).pop();
    return leaf ? [leaf] : [];
  }
  const select = ref.select;
  if (typeof select === "string") return [select];
  if (Array.isArray(select)) return select;
  const source = ref.source;
  const path = source.type === "git" ? (source.subdir ?? source.url) : source.path;
  const leaf = path.split("/").filter(Boolean).pop();
  return leaf ? [leaf] : [];
};

/**
 * Dependency-first ordering with cycle detection.
 *
 * Iterative DFS keeps a deep graph from blowing the stack and lets the error
 * report the actual cycle rather than just its existence.
 */
export const topologicalOrder = (skills: Map<string, ResolvedSkill>): string[] => {
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (name: string, path: string[]): void => {
    const current = state.get(name);
    if (current === "done") return;
    if (current === "visiting") {
      const start = path.indexOf(name);
      throw new CycleError([...path.slice(start === -1 ? 0 : start), name]);
    }
    state.set(name, "visiting");
    const skill = skills.get(name);
    if (skill) {
      for (const dep of [...skill.dependsOn].sort()) visit(dep, [...path, name]);
    }
    state.set(name, "done");
    order.push(name);
  };

  for (const name of [...skills.keys()].sort()) visit(name, []);
  return order;
};
