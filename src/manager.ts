/**
 * `AgentManager`: the public entrypoint.
 *
 * The split the whole design rests on: `resolve()` reads (network + cache) and
 * returns a plan; everything else acts on that plan. Nothing touches a target
 * until `install()`, `sync()`, `add()`, or `remove()` is called, and none of
 * them run skill code. agent-outfitter places files and merges config, and the
 * agent runtime executes whatever it finds under its own sandbox.
 */

import { join, resolve as resolvePath } from "node:path";

import { DEFAULT_CONCURRENCY, mapLimit } from "./concurrency.js";
import {
  HashMismatchError,
  ManifestError,
  SkillNotFoundError,
  TargetError,
} from "./errors.js";
import { hashString, hashTree } from "./hash.js";
import { isDirectory, listFiles, pathExists, readTextFile } from "./fsutil.js";
import {
  emptyLockfile,
  lockSourceToPrimitiveSource,
  readLockfile,
  primitiveSourceToLockSource,
  writeLockfile,
  type Lockfile,
  type LockInstruction,
  type LockMcp,
  type LockSkill,
  type LockTarget,
} from "./lockfile.js";
import { lockfilePath as lockfilePathFor } from "./lockfile.js";
import { isSourceEntry, loadManifest, writeManifest, type LoadedManifest } from "./manifest.js";
import { readRegion } from "./primitives/instruction.js";
import { normalizeInstructionEntries } from "./primitives/skill.js";
import { defaultCacheDir } from "./paths.js";
import { resolvePolicy } from "./policy.js";
import { mcpConfigHash, normalizeMcpServer } from "./primitives/mcp.js";
import { describeSource, normalizeRef, parseRefString } from "./refs.js";
import { resolveGraph, topologicalOrder } from "./resolver.js";
import { selectProvider, type SourceProvider } from "./sources/index.js";
import { resolveTarget } from "./targets/index.js";
import { checkTree } from "./verify.js";
import type {
  AuthResolver,
  InstallResult,
  InstructionRefEntry,
  InstalledPrimitive,
  Manifest,
  ManifestSourceEntry,
  NamedMcpServer,
  NormalizedRef,
  ResolvedInstruction,
  ResolvedMcpServer,
  ResolvedPolicy,
  ResolvedSkill,
  Resolution,
  OutfitterEvent,
  PrimitiveRef,
  AgentTarget,
  OutfitterWarning,
  TargetContext,
  TrustPolicy,
  VerifyIssue,
  VerifyReport,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public option shapes
// ---------------------------------------------------------------------------

export interface AgentManagerConfig {
  /** Working root: where the manifest and lockfile live. Default `process.cwd()`. */
  root?: string;
  /** Manifest path or an inline manifest. Default: probe `<root>/outfitter.config.*`. */
  manifest?: string | Manifest;
  /** Targets to install into. Overridable per call. */
  targets?: (AgentTarget | string)[];
  /** Extra source providers. Built-ins (git, local) are always available. */
  sources?: SourceProvider[];
  /** Resolves tokens for private sources by host/owner. */
  auth?: AuthResolver;
  /** Tarball/tree cache dir. Default: the OS cache dir. */
  cacheDir?: string;
  /** Trust and verification policy. Merged over the manifest's own policy. */
  policy?: TrustPolicy;
  /** Structured progress and audit events. */
  onEvent?: (event: OutfitterEvent) => void;
  /** Max parallel source fetches. Default 6. */
  concurrency?: number;
}

export interface ResolveInput {
  /** Extra refs to resolve alongside the manifest's sources. */
  refs?: PrimitiveRef[];
  /** Extra MCP servers, treated as manifest-declared (trusted). */
  mcp?: NamedMcpServer[];
  /** Extra instruction fragments, treated as manifest-declared (trusted). */
  instructions?: (string | InstructionRefEntry)[];
  targets?: (AgentTarget | string)[];
  policy?: TrustPolicy;
  /** Resolve only `refs`, `mcp`, and `instructions`, ignoring the manifest. */
  ignoreManifest?: boolean;
}

export interface InstallInput extends ResolveInput {
  /** Reuse a plan from a previous `resolve()` instead of resolving again. */
  resolution?: Resolution;
  /** Plan and verify, but write nothing. */
  dryRun?: boolean;
  /** Install only these skills (and their dependencies). */
  only?: string[];
  /** Re-materialize even when the installed hash already matches. */
  force?: boolean;
  /** Remove skills present in the lockfile but no longer resolved. Default false. */
  prune?: boolean;
}

export interface AddOptions {
  targets?: (AgentTarget | string)[];
  /** Skill names or globs to select from the ref. */
  select?: string | string[];
  /** Write the ref into the manifest. Default true when the manifest is writable. */
  save?: boolean;
  dryRun?: boolean;
}

export interface SyncOptions {
  targets?: (AgentTarget | string)[];
  dryRun?: boolean;
  force?: boolean;
}

export interface ListOptions {
  targets?: (AgentTarget | string)[];
  /** Include lockfile entries whose files are missing from the target. */
  includeMissing?: boolean;
}

export interface RemoveOptions {
  targets?: (AgentTarget | string)[];
  /** Leave the manifest untouched. Default false. */
  keepManifest?: boolean;
  dryRun?: boolean;
}

export interface VerifyOptions {
  targets?: (AgentTarget | string)[];
  /** Also re-run the hidden-Unicode scan over installed files. Default true. */
  scan?: boolean;
}

export interface AgentManager {
  resolve(input?: ResolveInput): Promise<Resolution>;
  install(input?: InstallInput): Promise<InstallResult>;
  add(ref: PrimitiveRef, opts?: AddOptions): Promise<InstallResult>;
  sync(opts?: SyncOptions): Promise<InstallResult>;
  list(opts?: ListOptions): Promise<InstalledPrimitive[]>;
  remove(name: string, opts?: RemoveOptions): Promise<void>;
  verify(opts?: VerifyOptions): Promise<VerifyReport>;
  /** Absolute path of the lockfile this manager reads and writes. */
  readonly lockfilePath: string;
  /** Absolute working root. */
  readonly root: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const createAgentManager = (config: AgentManagerConfig = {}): AgentManager =>
  new AgentManagerImpl(config);

class AgentManagerImpl implements AgentManager {
  readonly root: string;
  readonly lockfilePath: string;

  private readonly config: AgentManagerConfig;
  private readonly cacheDir: string;
  private readonly providers: SourceProvider[];
  private manifestCache?: LoadedManifest;

  constructor(config: AgentManagerConfig) {
    this.config = config;
    this.root = resolvePath(config.root ?? process.cwd());
    this.cacheDir = config.cacheDir ? resolvePath(config.cacheDir) : defaultCacheDir();
    this.providers = config.sources ?? [];
    this.lockfilePath = lockfilePathFor(this.root);
  }

  // -- shared plumbing ------------------------------------------------------

  private emit(event: OutfitterEvent): void {
    this.config.onEvent?.(event);
  }

  private async manifest(): Promise<LoadedManifest> {
    this.manifestCache ??= await loadManifest({
      root: this.root,
      ...(this.config.manifest !== undefined ? { manifest: this.config.manifest } : {}),
    });
    return this.manifestCache;
  }

  private context(warnings: OutfitterWarning[]): TargetContext {
    return {
      root: this.root,
      cacheDir: this.cacheDir,
      emit: (event) => this.emit(event),
      warn: (warning) => {
        warnings.push(warning);
        this.emit({ type: "warning", warning });
      },
    };
  }

  private async policyFor(override?: TrustPolicy): Promise<ResolvedPolicy> {
    const { manifest } = await this.manifest();
    return resolvePolicy(manifest.policy, this.config.policy, override);
  }

  private async targetsFor(override?: (AgentTarget | string)[]): Promise<AgentTarget[]> {
    const { manifest } = await this.manifest();
    const chosen = override ?? this.config.targets ?? manifest.targets;
    if (!chosen || chosen.length === 0) {
      throw new TargetError(
        `No install targets configured. Pass "targets" to createAgentManager(), to the call ` +
          `itself, or declare them in the manifest, for example ` +
          `codexTarget({ codexHome }) or claudeTarget({ dir }).`,
      );
    }
    const targets = chosen.map(resolveTarget);
    const seen = new Set<string>();
    for (const target of targets) {
      if (seen.has(target.name)) {
        throw new TargetError(
          `Two targets share the name "${target.name}". Give one an explicit "name" so their ` +
            `lockfile entries stay distinct.`,
          { name: target.name },
        );
      }
      seen.add(target.name);
    }
    return targets;
  }

  /** Manifest sources + inline refs, normalized. */
  private async refsFor(input: ResolveInput): Promise<NormalizedRef[]> {
    const { manifest } = await this.manifest();
    const refs: NormalizedRef[] = [];

    if (!input.ignoreManifest) {
      for (const entry of manifest.sources ?? []) {
        refs.push(this.normalizeManifestSource(entry));
      }
    }
    for (const ref of input.refs ?? []) {
      refs.push(normalizeRef(ref, { root: this.root }));
    }
    return refs;
  }

  private normalizeManifestSource(entry: string | ManifestSourceEntry): NormalizedRef {
    if (!isSourceEntry(entry)) {
      return normalizeRef(entry, { root: this.root });
    }
    const { source } = parseRefString(entry.ref, {
      root: this.root,
      ...(entry.auth ? { auth: entry.auth } : {}),
    });
    const normalized: NormalizedRef = { source };
    if (entry.select) {
      normalized.select = Array.isArray(entry.select) ? entry.select : [entry.select];
    }
    if (entry.skillsRoot) normalized.skillsRoot = entry.skillsRoot;
    return normalized;
  }

  // -- resolve --------------------------------------------------------------

  async resolve(input: ResolveInput = {}): Promise<Resolution> {
    const { manifest } = await this.manifest();
    const refs = await this.refsFor(input);
    const mcp = [...(input.ignoreManifest ? [] : (manifest.mcp ?? [])), ...(input.mcp ?? [])];
    const instructions = normalizeInstructionEntries([
      ...(input.ignoreManifest ? [] : (manifest.instructions ?? [])),
      ...(input.instructions ?? []),
    ]);

    return resolveGraph({
      refs,
      mcp,
      instructions,
      policy: await this.policyFor(input.policy),
      cacheDir: this.cacheDir,
      root: this.root,
      providers: this.providers,
      ...(this.config.auth ? { auth: this.config.auth } : {}),
      emit: (event) => this.emit(event),
      concurrency: this.config.concurrency ?? DEFAULT_CONCURRENCY,
    });
  }

  // -- install --------------------------------------------------------------

  async install(input: InstallInput = {}): Promise<InstallResult> {
    const resolution = input.resolution ?? (await this.resolve(input));
    const targets = await this.targetsFor(input.targets);
    const policy = await this.policyFor(input.policy);
    const previous = (await readLockfile(this.root)) ?? emptyLockfile();

    const selected = selectWithDependencies(resolution, input.only);
    this.assertNoTampering(resolution, previous, selected, policy);

    return this.materialize({
      resolution,
      selected,
      targets,
      previous,
      dryRun: input.dryRun === true,
      force: input.force === true,
      prune: input.prune === true,
      /** An `only` install is additive: untouched lock entries must survive. */
      preserveUnselected: input.only !== undefined && input.only.length > 0,
    });
  }

  /**
   * Refuse a tree whose bytes changed while its commit did not.
   *
   * An upgrade (new commit -> new hash) is expected and simply updates the
   * lockfile. The *same* commit hashing differently means the bytes behind an
   * immutable identifier moved, which is the signature of a tampered mirror.
   */
  private assertNoTampering(
    resolution: Resolution,
    previous: Lockfile,
    selected: Set<string>,
    policy: ResolvedPolicy,
  ): void {
    if (policy.requireLockHashMatch === false) return;
    for (const name of selected) {
      const skill = resolution.skills.get(name);
      const locked = previous.skills[name];
      if (!skill || !locked || !locked.commit || locked.commit !== skill.commit) continue;
      if (locked.contentHash !== skill.contentHash) {
        throw new HashMismatchError(name, locked.contentHash, skill.contentHash, {
          commit: skill.commit,
          reason: "same commit, different content",
        });
      }
    }
  }

  /** The shared write path behind `install()` and `sync()`. */
  private async materialize(args: {
    resolution: Resolution;
    selected: Set<string>;
    targets: AgentTarget[];
    previous: Lockfile;
    dryRun: boolean;
    force: boolean;
    prune: boolean;
    preserveUnselected: boolean;
  }): Promise<InstallResult> {
    const { resolution, selected, targets, previous, dryRun } = args;
    const warnings: OutfitterWarning[] = [...resolution.warnings];
    const ctx = this.context(warnings);

    const installed: InstalledPrimitive[] = [];
    const skipped: InstalledPrimitive[] = [];

    const order = resolution.order.filter((name) => selected.has(name));

    // Dependency order is a property of the skill sequence, not of the targets,
    // so each skill is written to every target before moving to the next.
    for (const name of order) {
      const skill = resolution.skills.get(name);
      if (!skill) continue;

      for (const target of targets) {
        const existing = args.force
          ? undefined
          : await target.currentHash?.(name, ctx).catch(() => undefined);

        if (!args.force && existing === skill.contentHash) {
          const dir = await target.resolveDir("skill", ctx);
          const entry = installedEntry(skill, target.name, join(dir, name));
          skipped.push(entry);
          ctx.emit({ type: "skill:skipped", name, target: target.name, path: entry.path });
          continue;
        }

        if (dryRun) {
          const dir = await target.resolveDir("skill", ctx);
          installed.push(installedEntry(skill, target.name, join(dir, name)));
          continue;
        }

        const output = await target.materialize({ skill, stagedDir: skill.stagedDir, ctx });
        const entry = installedEntry(skill, target.name, output.path, output.skillId);
        installed.push(entry);
        ctx.emit({ type: "skill:materialized", name, target: target.name, path: output.path });
      }
    }

    const trustedMcp = [...resolution.mcp.values()].filter((server) => server.trusted);
    const mcpPaths = new Map<string, string>();
    const mcpWritten = new Map<string, string[]>();

    for (const target of targets) {
      if (!target.writeMcpServers) {
        if (trustedMcp.length > 0) {
          ctx.warn({
            code: "target-config",
            subject: target.name,
            message:
              `Target "${target.name}" cannot configure MCP servers, so ` +
              `${trustedMcp.map((s) => s.name).join(", ")} were not registered for it.`,
          });
        }
        continue;
      }
      const previouslyManaged = previous.targets[target.name]?.mcp ?? [];
      if (dryRun) {
        mcpWritten.set(target.name, trustedMcp.map((s) => s.name));
        continue;
      }
      const result = await target.writeMcpServers({
        servers: trustedMcp,
        previouslyManaged,
        ctx,
      });
      mcpPaths.set(target.name, result.path);
      mcpWritten.set(target.name, result.written);
      for (const name of result.written) {
        ctx.emit({ type: "mcp:configured", name, target: target.name, path: result.path });
      }
    }

    // A partial (`only`) install says nothing about the skills it did not
    // touch, so it must never treat them as orphaned.
    const trustedInstructions = [...resolution.instructions.values()].filter((i) => i.trusted);
    const instructionPaths = new Map<string, string>();
    const instructionsWritten = new Map<string, string[]>();

    for (const target of targets) {
      if (!target.writeInstructions) {
        if (trustedInstructions.length > 0) {
          ctx.warn({
            code: "target-config",
            subject: target.name,
            message:
              `Target "${target.name}" cannot merge instruction fragments, so ` +
              `${trustedInstructions.map((i) => i.name).join(", ")} were not written for it.`,
          });
        }
        continue;
      }
      const previouslyManaged = previous.targets[target.name]?.instructions ?? [];
      if (dryRun) {
        instructionsWritten.set(
          target.name,
          trustedInstructions.map((i) => i.name),
        );
        for (const instruction of trustedInstructions) {
          installed.push(
            installedInstructionEntry(
              instruction,
              target.name,
              await target.resolveDir("instruction", ctx),
            ),
          );
        }
        continue;
      }
      const result = await target.writeInstructions({
        instructions: trustedInstructions,
        previouslyManaged,
        ctx,
      });
      instructionPaths.set(target.name, result.path);
      instructionsWritten.set(target.name, result.written);
      for (const name of result.written) {
        const instruction = resolution.instructions.get(name);
        if (instruction) {
          installed.push(installedInstructionEntry(instruction, target.name, result.path));
        }
        ctx.emit({ type: "instruction:written", name, target: target.name, path: result.path });
      }
    }

    const orphans = args.preserveUnselected
      ? []
      : Object.keys(previous.skills).filter((name) => !resolution.skills.has(name));
    if (orphans.length > 0) {
      if (args.prune && !dryRun) {
        for (const target of targets) {
          for (const name of orphans) {
            await target.unmaterialize?.(name, ctx);
            const path = previous.targets[target.name]?.skills[name];
            if (path) ctx.emit({ type: "skill:removed", name, target: target.name, path });
          }
        }
      } else {
        ctx.warn({
          code: "manifest",
          message:
            `${orphans.join(", ")} ${orphans.length === 1 ? "is" : "are"} still installed but no ` +
            `longer resolved from the manifest. Files were left in place. Call remove(), or ` +
            `install({ prune: true }), to delete them.`,
          detail: { orphans },
        });
      }
    }

    const next = this.buildLockfile({
      resolution,
      selected,
      targets,
      previous,
      installed,
      skipped,
      mcpPaths,
      mcpWritten,
      instructionPaths,
      instructionsWritten,
      preserveUnselected: args.preserveUnselected,
      // Orphans that were only warned about are still on disk, so they stay in
      // the lockfile: it records what is installed, not what was last resolved.
      carryForward: args.prune && !dryRun ? [] : orphans,
    });

    let lockfileOut = this.lockfilePath;
    if (!dryRun) {
      lockfileOut = await writeLockfile(this.root, next);
      this.emit({ type: "lockfile:written", path: lockfileOut });
    }

    this.emit({ type: "install:done", installed: installed.length, skipped: skipped.length });

    return {
      installed,
      skipped,
      mcp: trustedMcp,
      instructions: trustedInstructions,
      warnings,
      lockfilePath: lockfileOut,
      dryRun,
    };
  }

  private buildLockfile(args: {
    resolution: Resolution;
    selected: Set<string>;
    targets: AgentTarget[];
    previous: Lockfile;
    installed: InstalledPrimitive[];
    skipped: InstalledPrimitive[];
    mcpPaths: Map<string, string>;
    mcpWritten: Map<string, string[]>;
    instructionPaths: Map<string, string>;
    instructionsWritten: Map<string, string[]>;
    preserveUnselected: boolean;
    carryForward: string[];
  }): Lockfile {
    const next = emptyLockfile();

    if (args.preserveUnselected) {
      next.skills = { ...args.previous.skills };
      next.mcp = { ...args.previous.mcp };
      next.targets = structuredClone(args.previous.targets);
    } else {
      for (const name of args.carryForward) {
        const entry = args.previous.skills[name];
        if (!entry) continue;
        next.skills[name] = entry;
        for (const [targetName, targetEntry] of Object.entries(args.previous.targets)) {
          const path = targetEntry.skills[name];
          if (!path) continue;
          const carried = (next.targets[targetName] ??= {
            skills: {},
            mcp: [],
            instructions: [],
          });
          carried.skills[name] = path;
          const id = targetEntry.skillIds?.[name];
          if (id) (carried.skillIds ??= {})[name] = id;
        }
      }
    }

    for (const name of args.selected) {
      const skill = args.resolution.skills.get(name);
      if (!skill) continue;
      next.skills[name] = toLockSkill(skill);
    }

    for (const server of args.resolution.mcp.values()) {
      if (!server.trusted) continue;
      next.mcp[server.name] = toLockMcp(server);
    }

    for (const instruction of args.resolution.instructions.values()) {
      if (!instruction.trusted) continue;
      next.instructions[instruction.name] = toLockInstruction(instruction);
    }

    for (const target of args.targets) {
      const entry: LockTarget = next.targets[target.name] ?? {
        skills: {},
        mcp: [],
        instructions: [],
      };
      const skillIds: Record<string, string> = { ...entry.skillIds };

      for (const record of [...args.installed, ...args.skipped]) {
        if (record.target !== target.name) continue;
        entry.skills[record.name] = record.path;
        if (record.skillId) skillIds[record.name] = record.skillId;
      }
      if (Object.keys(skillIds).length > 0) entry.skillIds = skillIds;

      const written = args.mcpWritten.get(target.name);
      if (written) entry.mcp = written;
      const path = args.mcpPaths.get(target.name);
      // Only record a config path once something was actually written there.
      if (path && written && written.length > 0) entry.mcpConfigPath = path;

      const instructionsFor = args.instructionsWritten.get(target.name);
      if (instructionsFor) entry.instructions = instructionsFor;
      const instructionPath = args.instructionPaths.get(target.name);
      if (instructionPath && instructionsFor && instructionsFor.length > 0) {
        entry.instructionPath = instructionPath;
      }

      // Drop skills that are gone from the graph unless this was a partial install.
      if (!args.preserveUnselected) {
        for (const name of Object.keys(entry.skills)) {
          if (!next.skills[name]) delete entry.skills[name];
        }
      }

      next.targets[target.name] = entry;
    }

    return next;
  }

  // -- add ------------------------------------------------------------------

  async add(ref: PrimitiveRef, opts: AddOptions = {}): Promise<InstallResult> {
    const structured: PrimitiveRef =
      typeof ref === "string" && opts.select !== undefined
        ? { source: parseRefString(ref, { root: this.root }).source, select: opts.select }
        : ref;

    // Resolve the new ref alone to learn which skills it contributes.
    const preview = await this.resolve({ refs: [structured], ignoreManifest: true });
    const names = [...preview.skills.keys()];
    if (names.length === 0) {
      throw new SkillNotFoundError(
        `${typeof ref === "string" ? ref : describeSource(ref.source)} resolved to no skills.`,
      );
    }

    const loaded = await this.manifest();
    const shouldSave = opts.save ?? loaded.writable;
    if (shouldSave) {
      if (!loaded.path || !loaded.writable) {
        throw new ManifestError(
          `Cannot save to the manifest: ${loaded.path ? `${loaded.path} is not machine-editable` : "no outfitter.config.yaml or .json was found"}. ` +
            `Pass save: false to install without recording it.`,
          { path: loaded.path },
        );
      }
      const entry = toManifestEntry(structured, opts.select);
      const sources = [...(loaded.manifest.sources ?? [])];
      const already = sources.some((s) => sameManifestSource(s, entry));
      if (!already) {
        sources.push(entry);
        const updated: Manifest = { ...loaded.manifest, sources };
        if (!opts.dryRun) await writeManifest(loaded.path, updated);
        this.manifestCache = { ...loaded, manifest: updated };
      }
    }

    return this.install({
      refs: [structured],
      only: names,
      ...(opts.targets ? { targets: opts.targets } : {}),
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
    });
  }

  // -- sync -----------------------------------------------------------------

  /**
   * Deterministic reinstall strictly from the lockfile. The CI entrypoint.
   *
   * The manifest is not consulted: every skill is re-fetched at its pinned
   * commit and its tree re-hashed. Any difference from the recorded hash is a
   * hard failure, because at a fixed commit there is nothing legitimate that
   * could have changed.
   */
  async sync(opts: SyncOptions = {}): Promise<InstallResult> {
    const lock = await readLockfile(this.root);
    if (!lock) {
      throw new ManifestError(
        `No ${this.lockfilePath} to sync from. Run install() once and commit the lockfile.`,
        { path: this.lockfilePath },
      );
    }

    const targets = await this.targetsFor(opts.targets);
    const policy = await this.policyFor();
    const resolution = await this.resolveFromLockfile(lock, policy);

    return this.materialize({
      resolution,
      selected: new Set(resolution.skills.keys()),
      targets,
      previous: lock,
      dryRun: opts.dryRun === true,
      force: opts.force === true,
      prune: false,
      preserveUnselected: false,
    });
  }

  private async resolveFromLockfile(
    lock: Lockfile,
    policy: ResolvedPolicy,
  ): Promise<Resolution> {
    const warnings: OutfitterWarning[] = [];
    const skills = new Map<string, ResolvedSkill>();
    const entries = Object.entries(lock.skills);

    const staged = await mapLimit(
      entries,
      this.config.concurrency ?? DEFAULT_CONCURRENCY,
      async ([name, entry]) => {
        const source = lockSourceToPrimitiveSource(entry.source);
        const subdir = source.type === "git" ? source.subdir : undefined;
        const provider = selectProvider(source, this.providers);
        const token = await this.tokenForLockedSource(source);
        const treeRoot = await provider.materializeTree(source, entry.commit, {
          cacheDir: this.cacheDir,
          onRetry: (info) => this.emit({ type: "source:retry", source, ...info }),
          ...(token ? { token } : {}),
        });
        // The lockfile's subdir is relative to the repo root; a local source
        // already points at the skill folder itself.
        const dir =
          source.type === "local"
            ? source.path
            : subdir
              ? resolvePath(treeRoot, subdir)
              : treeRoot;
        return { name, entry, source, dir, subdir };
      },
    );

    for (const { name, entry, source, dir, subdir } of staged) {
      if (!(await isDirectory(dir))) {
        throw new SkillNotFoundError(
          `Locked skill "${name}" is missing from ${describeSource(source)} at ` +
            `${entry.commit.slice(0, 7)} (expected ${subdir ?? "the repo root"}).`,
          { name, commit: entry.commit },
        );
      }
      const files = await listFiles(dir);
      const { contentHash } = await hashTree(dir, files);
      this.emit({ type: "skill:fetched", name, commit: entry.commit, stagedDir: dir });

      if (contentHash !== entry.contentHash && policy.requireLockHashMatch !== false) {
        throw new HashMismatchError(name, entry.contentHash, contentHash, {
          commit: entry.commit,
        });
      }
      this.emit({ type: "skill:verified", name, contentHash });

      const check = await checkTree(name, dir, files, policy);
      for (const warning of check.warnings) {
        warnings.push(warning);
        this.emit({ type: "warning", warning });
      }

      skills.set(name, {
        name,
        description: "",
        meta: {},
        files,
        dependencies: { skills: [], mcp: [], instructions: [], unsupported: [] },
        source,
        ref: entry.ref,
        commit: entry.commit,
        subdir: subdir ?? "",
        contentHash,
        stagedDir: dir,
        dependsOn: entry.dependencies.filter((dep) => dep in lock.skills),
        mcpDependencies: entry.mcp,
        transitive: entry.transitive,
      });
    }

    const mcp = new Map<string, ResolvedMcpServer>();
    for (const [name, entry] of Object.entries(lock.mcp)) {
      mcp.set(name, fromLockMcp(name, entry));
    }

    // Instruction fragments are re-read from their pinned commit and re-hashed,
    // the same reproducibility guarantee skills get.
    const instructions = new Map<string, ResolvedInstruction>();
    for (const [name, entry] of Object.entries(lock.instructions)) {
      const source = lockSourceToPrimitiveSource(entry.source);
      const provider = selectProvider(source, this.providers);
      const token = await this.tokenForLockedSource(source);
      const treeRoot = await provider.materializeTree(source, entry.commit, {
        cacheDir: this.cacheDir,
        onRetry: (info) => this.emit({ type: "source:retry", source, ...info }),
        ...(token ? { token } : {}),
      });
      // `subdir` is relative to the tree root for git, and to the configured
      // path for local. An empty subdir means the base already is the file.
      const base = source.type === "local" ? source.path : treeRoot;
      const file = entry.subdir ? resolvePath(base, entry.subdir) : base;
      const content = await readTextFile(file);
      const contentHash = hashString(content);
      if (contentHash !== entry.contentHash && policy.requireLockHashMatch !== false) {
        throw new HashMismatchError(name, entry.contentHash, contentHash, {
          commit: entry.commit,
          primitive: "instruction",
        });
      }
      instructions.set(name, {
        name,
        content,
        source,
        ref: entry.ref,
        commit: entry.commit,
        subdir: entry.subdir,
        contentHash,
        declaredBy: entry.declaredBy,
        trusted: entry.trusted,
      });
    }

    return {
      order: topologicalOrder(skills),
      skills,
      mcp,
      instructions,
      warnings,
      unsupported: [],
    };
  }

  private async tokenForLockedSource(
    source: ReturnType<typeof lockSourceToPrimitiveSource>,
  ): Promise<string | undefined> {
    if (source.type !== "git" || !this.config.auth) return undefined;
    const { sourceHost, sourceOwner } = await import("./refs.js");
    return this.config.auth(sourceHost(source) ?? "", sourceOwner(source) ?? "");
  }

  // -- list -----------------------------------------------------------------

  async list(opts: ListOptions = {}): Promise<InstalledPrimitive[]> {
    const lock = await readLockfile(this.root);
    if (!lock) return [];

    const warnings: OutfitterWarning[] = [];
    const ctx = this.context(warnings);
    const targets = await this.targetsForList(opts.targets, lock);
    const out: InstalledPrimitive[] = [];

    for (const target of targets) {
      const targetEntry = lock.targets[target.name];
      for (const [name, entry] of Object.entries(lock.skills)) {
        const recorded = targetEntry?.skills[name];
        const present = recorded ? await pathExists(recorded) : false;
        const skillId = targetEntry?.skillIds?.[name];
        // Upload-style targets have no path to stat; the recorded id is proof.
        if (!present && !skillId && !opts.includeMissing) continue;
        out.push({
          name,
          kind: "skill",
          target: target.name,
          path: recorded ?? join(await target.resolveDir("skill", ctx), name),
          source: lockSourceToPrimitiveSource(entry.source),
          ref: entry.ref,
          commit: entry.commit,
          contentHash: entry.contentHash,
          ...(skillId ? { skillId } : {}),
        });
      }
    }

    return out.sort((a, b) =>
      a.name === b.name ? a.target.localeCompare(b.target) : a.name.localeCompare(b.name),
    );
  }

  /** For read-only calls, fall back to whatever the lockfile recorded. */
  private async targetsForList(
    override: (AgentTarget | string)[] | undefined,
    lock: Lockfile,
  ): Promise<AgentTarget[]> {
    try {
      return await this.targetsFor(override);
    } catch (error) {
      if (override) throw error;
      const names = Object.keys(lock.targets);
      if (names.length === 0) throw error;
      return names.map((name) => stubTarget(name, lock));
    }
  }

  // -- remove ---------------------------------------------------------------

  async remove(name: string, opts: RemoveOptions = {}): Promise<void> {
    const lock = (await readLockfile(this.root)) ?? emptyLockfile();
    const warnings: OutfitterWarning[] = [];
    const ctx = this.context(warnings);
    const targets = await this.targetsForList(opts.targets, lock);

    // `name` may address an instruction fragment rather than a skill.
    if (!lock.skills[name] && lock.instructions[name]) {
      if (!opts.dryRun) {
        for (const target of targets) {
          await target.removeInstructions?.([name], ctx);
          const path = lock.targets[target.name]?.instructionPath;
          if (path) {
            this.emit({ type: "instruction:removed", name, target: target.name, path });
          }
        }
      }
      delete lock.instructions[name];
      for (const entry of Object.values(lock.targets)) {
        entry.instructions = entry.instructions.filter((f) => f !== name);
      }
      if (!opts.dryRun) await writeLockfile(this.root, lock);
      if (!opts.keepManifest) await this.removeFromManifest(name, ctx, opts.dryRun === true);
      return;
    }

    const dependents = Object.entries(lock.skills)
      .filter(([other, entry]) => other !== name && entry.dependencies.includes(name))
      .map(([other]) => other);
    if (dependents.length > 0) {
      ctx.warn({
        code: "manifest",
        subject: name,
        message:
          `"${name}" is a dependency of ${dependents.join(", ")}. Removing it may break them; ` +
          `the next install() will pull it back in.`,
        detail: { dependents },
      });
    }

    if (!opts.dryRun) {
      for (const target of targets) {
        const path = lock.targets[target.name]?.skills[name];
        await target.unmaterialize?.(name, ctx);
        if (path) this.emit({ type: "skill:removed", name, target: target.name, path });
      }
    }

    // Drop MCP servers that only this skill pulled in.
    const orphanedMcp = Object.entries(lock.mcp)
      .filter(([, entry]) => entry.declaredBy === name)
      .map(([server]) => server);
    if (orphanedMcp.length > 0 && !opts.dryRun) {
      for (const target of targets) {
        await target.removeMcpServers?.(orphanedMcp, ctx);
      }
    }

    // Same rule for instructions: drop only the fragments this skill introduced.
    const orphanedInstructions = Object.entries(lock.instructions)
      .filter(([, entry]) => entry.declaredBy === name)
      .map(([fragment]) => fragment);
    if (orphanedInstructions.length > 0 && !opts.dryRun) {
      for (const target of targets) {
        await target.removeInstructions?.(orphanedInstructions, ctx);
        const path = lock.targets[target.name]?.instructionPath;
        for (const fragment of orphanedInstructions) {
          if (path) {
            this.emit({
              type: "instruction:removed",
              name: fragment,
              target: target.name,
              path,
            });
          }
        }
      }
    }

    delete lock.skills[name];
    for (const server of orphanedMcp) delete lock.mcp[server];
    for (const fragment of orphanedInstructions) delete lock.instructions[fragment];
    for (const entry of Object.values(lock.targets)) {
      delete entry.skills[name];
      if (entry.skillIds) delete entry.skillIds[name];
      entry.mcp = entry.mcp.filter((server) => !orphanedMcp.includes(server));
      entry.instructions = entry.instructions.filter((f) => !orphanedInstructions.includes(f));
    }

    if (!opts.dryRun) await writeLockfile(this.root, lock);

    if (opts.keepManifest) return;
    await this.removeFromManifest(name, ctx, opts.dryRun === true);
  }

  private async removeFromManifest(
    name: string,
    ctx: TargetContext,
    dryRun: boolean,
  ): Promise<void> {
    const loaded = await this.manifest();
    if (!loaded.path) return;
    if (!loaded.writable) {
      ctx.warn({
        code: "manifest",
        subject: name,
        message:
          `Removed "${name}" from the lockfile and targets, but ${loaded.path} is a TypeScript ` +
          `config and cannot be edited automatically. Delete the source entry by hand or the ` +
          `next install() will reinstall it.`,
        detail: { path: loaded.path },
      });
      return;
    }

    const sources = loaded.manifest.sources ?? [];
    const nextSources: (string | ManifestSourceEntry)[] = [];
    let changed = false;

    for (const entry of sources) {
      const ref = isSourceEntry(entry) ? entry.ref : entry;
      const select = isSourceEntry(entry) ? entry.select : undefined;

      if (select !== undefined) {
        const list = Array.isArray(select) ? select : [select];
        const remaining = list.filter((s) => s !== name);
        if (remaining.length !== list.length) {
          changed = true;
          // An entry that existed only to select this skill goes away entirely.
          if (remaining.length > 0) {
            nextSources.push({ ...(entry as ManifestSourceEntry), select: remaining });
          }
          continue;
        }
      } else if (refTargetsSkill(ref, name)) {
        changed = true;
        continue;
      }
      nextSources.push(entry);
    }

    if (!changed) {
      ctx.warn({
        code: "manifest",
        subject: name,
        message:
          `No manifest source names "${name}" explicitly; it comes from a source that installs ` +
          `everything it finds. The next install() will reinstall it unless you narrow that ` +
          `source's "select".`,
      });
      return;
    }

    const updated: Manifest = { ...loaded.manifest, sources: nextSources };
    if (!dryRun) await writeManifest(loaded.path, updated);
    this.manifestCache = { ...loaded, manifest: updated };
  }

  // -- verify ---------------------------------------------------------------

  async verify(opts: VerifyOptions = {}): Promise<VerifyReport> {
    const lock = await readLockfile(this.root);
    if (!lock) {
      return {
        ok: false,
        checked: 0,
        issues: [
          {
            kind: "missing",
            name: "<lockfile>",
            path: this.lockfilePath,
            message: `No ${this.lockfilePath}. Run install() first.`,
          },
        ],
      };
    }

    const policy = await this.policyFor();
    const targets = await this.targetsForList(opts.targets, lock);
    const issues: VerifyIssue[] = [];
    let checked = 0;

    for (const target of targets) {
      const targetEntry = lock.targets[target.name];
      for (const [name, entry] of Object.entries(lock.skills)) {
        const path = targetEntry?.skills[name];
        if (!path) continue;
        // Upload-style targets expose no readable tree; the id is all we have.
        if (targetEntry?.skillIds?.[name] && !(await pathExists(path))) continue;

        checked += 1;

        if (!(await isDirectory(path))) {
          issues.push({
            kind: "missing",
            name,
            target: target.name,
            path,
            message: `Skill "${name}" is recorded in the lockfile but missing from ${path}.`,
          });
          continue;
        }

        const files = await listFiles(path);
        const { contentHash } = await hashTree(path, files);
        if (contentHash !== entry.contentHash) {
          issues.push({
            kind: "hash-mismatch",
            primitive: "skill",
            name,
            target: target.name,
            path,
            expected: entry.contentHash,
            actual: contentHash,
            message:
              `Installed files for "${name}" in ${target.name} no longer match the lockfile. ` +
              `Something edited them in place; sync() will restore the pinned tree.`,
          });
        }

        const extraneous = files.filter((f) => !entry.files.includes(f));
        for (const file of extraneous) {
          issues.push({
            kind: "extraneous",
            name,
            target: target.name,
            path: `${path}/${file}`,
            message: `"${file}" is present in ${target.name}'s copy of "${name}" but not in the lockfile.`,
          });
        }

        if (opts.scan !== false) {
          const check = await checkTree(name, path, files, {
            ...policy,
            // Report, never throw: verify() answers a question, it does not gate.
            scripts: policy.scripts === "deny" ? "warn" : policy.scripts,
            scan: policy.scan === "deny" ? "warn" : policy.scan,
          });
          for (const finding of check.hiddenUnicode) {
            issues.push({
              kind: "hidden-unicode",
              name,
              target: target.name,
              path: `${path}/${finding.file}`,
              message: `${finding.codePoint} (${finding.label}) at ${finding.file}:${finding.line}:${finding.column}.`,
            });
          }
          // Scripts are only an *issue* under a deny policy. Under "warn" their
          // presence is expected information, not drift, and must not make an
          // otherwise-clean tree fail verification.
          if (check.scripts.length > 0 && policy.scripts === "deny") {
            issues.push({
              kind: "scripts",
              name,
              target: target.name,
              path,
              message: `"${name}" bundles executable scripts: ${check.scripts.join(", ")}.`,
            });
          }
        }
      }
    }

    // An instruction fragment's proof is the managed region in the target file:
    // present, and hashing to what the lockfile pinned.
    for (const target of targets) {
      const targetEntry = lock.targets[target.name];
      const path = targetEntry?.instructionPath;
      if (!path) continue;
      const document = await readTextFile(path).catch(() => undefined);
      for (const name of targetEntry.instructions) {
        const locked = lock.instructions[name];
        if (!locked) continue;
        checked += 1;
        const region = document === undefined ? undefined : readRegion(document, name);
        if (region === undefined) {
          issues.push({
            kind: "missing",
            primitive: "instruction",
            name,
            target: target.name,
            path,
            message:
              `Instruction fragment "${name}" is recorded in the lockfile but its managed ` +
              `region is absent from ${path}.`,
          });
          continue;
        }
        const actual = hashString(`${region}\n`);
        const trimmed = hashString(region);
        if (actual !== locked.contentHash && trimmed !== locked.contentHash) {
          issues.push({
            kind: "instruction-drift",
            primitive: "instruction",
            name,
            target: target.name,
            path,
            expected: locked.contentHash,
            actual: trimmed,
            message:
              `The managed region for "${name}" in ${path} was edited in place. sync() will ` +
              `restore the pinned fragment.`,
          });
        }
      }
    }

    for (const [name, entry] of Object.entries(lock.mcp)) {
      const expected = mcpConfigHash(fromLockMcp(name, entry).server);
      if (expected !== entry.configHash) {
        issues.push({
          kind: "hash-mismatch",
          name,
          expected: entry.configHash,
          actual: expected,
          message: `Lockfile entry for MCP server "${name}" is internally inconsistent.`,
        });
      }
    }

    return { ok: issues.length === 0, checked, issues };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Expand an `only` filter to include everything those skills depend on. */
const selectWithDependencies = (
  resolution: Resolution,
  only: string[] | undefined,
): Set<string> => {
  if (!only || only.length === 0) return new Set(resolution.skills.keys());

  const missing = only.filter((name) => !resolution.skills.has(name));
  if (missing.length > 0) {
    throw new SkillNotFoundError(
      `Cannot install [${missing.join(", ")}]: not present in the resolved graph. ` +
        `Resolved: ${[...resolution.skills.keys()].join(", ") || "(none)"}.`,
      { missing },
    );
  }

  const selected = new Set<string>();
  const visit = (name: string): void => {
    if (selected.has(name)) return;
    selected.add(name);
    for (const dep of resolution.skills.get(name)?.dependsOn ?? []) visit(dep);
  };
  for (const name of only) visit(name);
  return selected;
};

const installedEntry = (
  skill: ResolvedSkill,
  target: string,
  path: string,
  skillId?: string,
): InstalledPrimitive => ({
  name: skill.name,
  kind: "skill",
  target,
  path,
  source: skill.source,
  ref: skill.ref,
  commit: skill.commit,
  contentHash: skill.contentHash,
  ...(skillId ? { skillId } : {}),
});

const installedInstructionEntry = (
  instruction: ResolvedInstruction,
  target: string,
  path: string,
): InstalledPrimitive => ({
  name: instruction.name,
  kind: "instruction",
  target,
  path,
  source: instruction.source,
  ref: instruction.ref,
  commit: instruction.commit,
  contentHash: instruction.contentHash,
});

const toLockSkill = (skill: ResolvedSkill): LockSkill => ({
  source: primitiveSourceToLockSource(skill.source),
  ref: skill.ref,
  commit: skill.commit,
  contentHash: skill.contentHash,
  files: skill.files,
  dependencies: [...skill.dependsOn].sort(),
  mcp: [...skill.mcpDependencies].sort(),
  transitive: skill.transitive,
});

const toLockMcp = (server: ResolvedMcpServer): LockMcp => ({
  ...normalizeMcpServer(server.server),
  declaredBy: server.declaredBy,
  trusted: server.trusted,
  configHash: server.configHash,
});

const toLockInstruction = (instruction: ResolvedInstruction): LockInstruction => ({
  source: primitiveSourceToLockSource(instruction.source),
  ref: instruction.ref,
  commit: instruction.commit,
  subdir: instruction.subdir,
  contentHash: instruction.contentHash,
  declaredBy: instruction.declaredBy,
  trusted: instruction.trusted,
});

const fromLockMcp = (name: string, entry: LockMcp): ResolvedMcpServer => {
  const server =
    entry.transport === "stdio"
      ? ({
          transport: "stdio" as const,
          command: entry.command ?? "",
          ...(entry.args ? { args: entry.args } : {}),
          ...(entry.envVars ? { envVars: entry.envVars } : {}),
          ...(entry.cwd ? { cwd: entry.cwd } : {}),
        } as const)
      : ({
          transport: "http" as const,
          url: entry.url ?? "",
          ...(entry.auth ? { auth: entry.auth } : {}),
          ...(entry.headers ? { headers: entry.headers } : {}),
        } as const);
  return {
    name,
    server: normalizeMcpServer(server),
    declaredBy: entry.declaredBy,
    trusted: entry.trusted,
    configHash: entry.configHash,
  };
};

/**
 * A read-only stand-in for a target named in the lockfile but not configured on
 * this manager, so `list()`/`verify()` still work without target construction.
 */
const stubTarget = (name: string, lock: Lockfile): AgentTarget => ({
  name,
  supports: [],
  resolveDir: (kind) =>
    (kind === "instruction"
      ? lock.targets[name]?.instructionPath
      : lock.targets[name]?.mcpConfigPath) ?? "",
  materialize: () => {
    throw new TargetError(
      `Target "${name}" is recorded in the lockfile but is not configured on this manager, ` +
        `so it cannot be written to. Pass it via "targets".`,
      { name },
    );
  },
});

const toManifestEntry = (
  ref: PrimitiveRef,
  select: string | string[] | undefined,
): string | ManifestSourceEntry => {
  // Always store `select` as a list: a one-element list reads the same as a
  // bare string but keeps the diff a single added line when it grows.
  const asList = (value: string | string[] | undefined): string[] | undefined =>
    value === undefined ? undefined : Array.isArray(value) ? value : [value];

  if (typeof ref === "string") {
    const list = asList(select);
    return list === undefined ? ref : { ref, select: list };
  }
  const source = ref.source;
  const refString =
    source.type === "local"
      ? `local:${source.path}`
      : `git:${source.url}${source.ref ? `#${source.ref}` : ""}`;
  const chosen = asList(select ?? ref.select);
  return chosen === undefined ? refString : { ref: refString, select: chosen };
};

const sameManifestSource = (
  a: string | ManifestSourceEntry,
  b: string | ManifestSourceEntry,
): boolean => {
  const refA = isSourceEntry(a) ? a.ref : a;
  const refB = isSourceEntry(b) ? b.ref : b;
  if (refA !== refB) return false;
  const selA = isSourceEntry(a) ? a.select : undefined;
  const selB = isSourceEntry(b) ? b.select : undefined;
  return JSON.stringify(selA ?? null) === JSON.stringify(selB ?? null);
};

/** Whether a bare ref points at a single skill folder of this name. */
const refTargetsSkill = (ref: string, name: string): boolean => {
  const withoutFragment = ref.split("#")[0] ?? ref;
  return (withoutFragment.split("/").filter(Boolean).pop() ?? "") === name;
};
