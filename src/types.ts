/**
 * Core domain types for agent-outfitter.
 *
 * Everything the public API accepts or returns is declared here so consumers get
 * one import surface and the internals share a single vocabulary.
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** How to obtain a token for a private source. Never holds a secret in a manifest. */
export type AuthRef = { env: string } | { token: string };

/**
 * Resolves a token for a given host/owner pair. Returning `undefined` means
 * "anonymous": the fetch proceeds without an `Authorization` header.
 */
export type AuthResolver = (
  host: string,
  owner: string,
) => string | undefined | Promise<string | undefined>;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Git hosting providers with a known tarball endpoint. */
export type GitProvider = "github" | "gitlab" | "bitbucket" | "sourcehut" | "git";

export type PrimitiveSource =
  | {
      type: "git";
      /** Canonical clone URL, e.g. `https://github.com/acme/agent-skills.git`. */
      url: string;
      /** Branch, tag, or commit. Defaults to the repo's default branch. */
      ref?: string;
      /** Path within the repo to treat as the source root. */
      subdir?: string;
      /** Which tarball endpoint to use. Inferred from `url` when omitted. */
      provider?: GitProvider;
      auth?: AuthRef;
    }
  | { type: "local"; path: string };

/**
 * A ref string (`"github:acme/agent-skills/skills/pdf#v1.4.0"`) or its
 * structured equivalent.
 */
export type PrimitiveRef = string | StructuredPrimitiveRef;

export interface StructuredPrimitiveRef {
  source: PrimitiveSource;
  /** Skill folder name(s) or glob(s) within the source. Omit = every skill found. */
  select?: string | string[];
  /**
   * Directory within the source that holds skill folders. When omitted,
   * agent-outfitter probes the source root, then `skills/`, then `.agents/skills/`.
   */
  skillsRoot?: string;
}

/** Post-normalization form used throughout the resolver. */
export interface NormalizedRef {
  source: PrimitiveSource;
  select?: string[];
  skillsRoot?: string;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type PrimitiveKind =
  | "skill"
  | "mcp"
  | "plugin"
  | "agent"
  | "prompt"
  | "instruction"
  | "hook"
  | "bundle"
  | "settings";

/**
 * The general unit of install. `skill`, `mcp`, `instruction`, `bundle`, and
 * `settings` install today.
 */
export type Primitive =
  | { kind: "skill"; name: string }
  | { kind: "mcp"; name: string; server: McpServer }
  | { kind: "plugin"; name: string }
  | { kind: "agent"; name: string }
  | { kind: "prompt"; name: string }
  | { kind: "instruction"; name: string }
  | { kind: "hook"; name: string }
  | { kind: "bundle"; name: string }
  | { kind: "settings"; name: string };

export type McpServer =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      /** Names of environment variables to pass through. Never values. */
      envVars?: string[];
      cwd?: string;
    }
  | {
      transport: "http";
      url: string;
      /** Name of the env var holding the bearer token. Never the token itself. */
      auth?: { bearerEnv?: string };
      headers?: Record<string, string>;
    };

export type NamedMcpServer = McpServer & { name: string };

/** An MCP server after resolution, carrying provenance and trust state. */
export interface ResolvedMcpServer {
  name: string;
  server: McpServer;
  /** `"manifest"` for a root declaration, otherwise the skill that pulled it in. */
  declaredBy: string;
  /** False when a transitive server was dropped by policy. */
  trusted: boolean;
  configHash: string;
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

/**
 * A named fragment of agent instructions: the `AGENTS.md` / `CLAUDE.md` layer.
 *
 * Unlike a skill, an instruction is not a folder the harness discovers; it is
 * text merged into a file the harness always reads. So it is stored as content
 * rather than as a path, and each target decides which file it belongs in.
 */
export interface Instruction {
  name: string;
  /** The fragment body, verbatim, without any wrapper markers. */
  content: string;
}

export interface ResolvedInstruction extends Instruction {
  source: PrimitiveSource;
  ref: string;
  commit: string;
  /** Path within the repo to the fragment file. */
  subdir: string;
  contentHash: string;
  /** `"manifest"` for a root declaration, otherwise the skill that pulled it in. */
  declaredBy: string;
  /** False when a transitive fragment was dropped by policy. */
  trusted: boolean;
}

/** A manifest or frontmatter reference to instruction fragments. */
export interface InstructionRefEntry {
  ref: string;
  /** Override the derived name. Only valid when the ref points at one file. */
  name?: string;
  /** Filename globs, when the ref points at a directory of fragments. */
  select?: string | string[];
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

/**
 * A subtree copied verbatim from a source to a declared destination.
 *
 * Skills are *discovered*: agent-outfitter probes for `SKILL.md` folders and the
 * skill's own name decides where it lands. A bundle has no marker file and no
 * frontmatter, which is the point: it is how a committed-harness framework
 * (engine scripts, knowledge bases, stage protocols) installs, and those files
 * announce nothing about themselves. So a bundle must be **declared**, with
 * explicit source-to-destination mappings, and it cannot participate in `select:`
 * globbing or the dependency graph the way a skill does.
 *
 * Keys are POSIX paths within the source; values are destinations relative to
 * the target's root. Both `""` and `"."` address the source root.
 */
export type BundlePaths = Record<string, string>;

export interface ResolvedBundle {
  name: string;
  source: PrimitiveSource;
  /** The ref as requested: branch, tag, or SHA. `""` for local sources. */
  ref: string;
  /** Exact commit SHA. `""` for local sources. */
  commit: string;
  /** Path within the repo the declared source paths are relative to. */
  subdir: string;
  /** Hash over every file in every declared source subtree. */
  contentHash: string;
  /** Per-source-path hash, so each destination tree can be verified alone. */
  pathHashes: Record<string, string>;
  /** Absolute path the declared source paths resolve against. */
  stagedDir: string;
  /** Every file the bundle installs, relative to `stagedDir`, POSIX-separated. */
  files: string[];
  paths: BundlePaths;
  /** `"manifest"` always: a fetched source cannot declare a bundle. */
  declaredBy: string;
  trusted: boolean;
}

/** A manifest reference to a bundle. */
export interface BundleRefEntry {
  ref: string;
  /** Override the derived name (the repository's last path segment). */
  name?: string;
  /** Source subtree -> destination, relative to the target's root. */
  paths: BundlePaths;
  auth?: AuthRef;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * A fragment of harness settings: the `.claude/settings.json` layer.
 *
 * Like an instruction fragment this is a merge, not a copy, but the file is
 * structured rather than prose, so marker comments are not available. Ownership
 * is tracked key by key instead (see `OwnedSettingsKeys`), which is what lets a
 * hand-written `settings.json` survive install, reinstall, and removal.
 */
export type SettingsFragment = Record<string, unknown>;

export interface ResolvedSettings {
  name: string;
  /** The fragment itself, parsed. */
  settings: SettingsFragment;
  source: PrimitiveSource;
  ref: string;
  commit: string;
  /** Path within the repo to the fragment file. `""` for inline fragments. */
  subdir: string;
  contentHash: string;
  /** True when the fragment was written inline in the manifest, not fetched. */
  inline: boolean;
  /** `"manifest"` always: a fetched source cannot declare settings. */
  declaredBy: string;
  trusted: boolean;
}

/** A manifest reference to a settings fragment, or an inline one. */
export interface SettingsRefEntry {
  /** Ref to a JSON file. Omit when supplying `settings` inline. */
  ref?: string;
  /** Override the derived name. Required for an inline fragment. */
  name?: string;
  /** An inline fragment, instead of `ref`. */
  settings?: SettingsFragment;
  auth?: AuthRef;
}

/**
 * The keys agent-outfitter owns in one settings file, for one fragment.
 *
 * Recorded in the lockfile because it is the only thing that distinguishes our
 * entries from the user's. Without it, removal would have to clobber the file
 * and a reinstall could not tell a stale entry of ours from a deliberate one of
 * theirs.
 */
export interface OwnedSettingsKeys {
  /** `env` keys. */
  env: string[];
  /** Region under `permissions` (`allow`/`deny`/`ask`) -> owned entries. */
  permissions: Record<string, string[]>;
  /** Hook registrations, keyed `"<Event> <matcher> <command>"`. */
  hooks: string[];
  /** Matcher groups we created, keyed `"<Event> <matcher>"`. Only these are pruned. */
  hookGroups: string[];
  /** Whole-value keys, dotted (`"model"`, `"permissions.defaultMode"`). */
  scalars: string[];
}

/** Owned keys plus a hash over the values behind them, for drift detection. */
export interface OwnedSettings extends OwnedSettingsKeys {
  /** Hash of the owned projection of the file. Changes when a value is edited. */
  hash: string;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Dependencies a skill declares in its `SKILL.md` frontmatter. */
export interface SkillDependencies {
  skills: PrimitiveRef[];
  mcp: NamedMcpServer[];
  instructions: InstructionRefEntry[];
  /** Declared primitives of kinds this version cannot install yet. */
  unsupported: Primitive[];
}

export interface Skill {
  name: string;
  description: string;
  /** Remaining `SKILL.md` frontmatter, minus the fields agent-outfitter consumes. */
  meta: Record<string, unknown>;
  /** Relative POSIX paths within the skill folder. */
  files: string[];
  dependencies: SkillDependencies;
}

export interface ResolvedSkill extends Skill {
  source: PrimitiveSource;
  /** The ref as requested: branch, tag, or SHA. `""` for local sources. */
  ref: string;
  /** Exact commit SHA. `""` for local sources. */
  commit: string;
  /** Path within the repo to this skill's folder. */
  subdir: string;
  contentHash: string;
  /** Absolute path to the verified staging directory this skill was read from. */
  stagedDir: string;
  /** Resolved dependency names (skills only): edges of the install DAG. */
  dependsOn: string[];
  /** MCP server names this skill pulled in. */
  mcpDependencies: string[];
  /** True when the skill was reached through another skill's dependencies. */
  transitive: boolean;
}

export interface InstalledPrimitive {
  name: string;
  /** Which kind of primitive this is. Lets one result list carry them all. */
  kind: PrimitiveKind;
  /** Target adapter name. */
  target: string;
  /**
   * Where it landed: an install directory for tree primitives, or the config
   * file a non-file primitive was merged into. For a bundle, the root its
   * destinations resolve against; the destinations themselves are in `paths`.
   */
  path: string;
  /** Bundle destinations, keyed by source path. Set only for bundles. */
  paths?: Record<string, string>;
  source: PrimitiveSource;
  ref: string;
  commit: string;
  contentHash: string;
  /** Set by targets that upload rather than copy (e.g. the OpenAI hosted target). */
  skillId?: string;
}

// ---------------------------------------------------------------------------
// Warnings & events
// ---------------------------------------------------------------------------

export type OutfitterWarningCode =
  | "duplicate-skill"
  | "scripts-present"
  | "hidden-unicode"
  | "transitive-mcp-dropped"
  | "transitive-instruction-dropped"
  | "mcp-conflict"
  | "instruction-conflict"
  | "settings-conflict"
  | "executable-harness"
  | "not-implemented"
  | "target-config"
  | "manifest"
  | "source";

export interface OutfitterWarning {
  code: OutfitterWarningCode;
  message: string;
  /** Skill / MCP server / target the warning is about, when applicable. */
  subject?: string;
  detail?: Record<string, unknown>;
}

export type OutfitterEvent =
  | { type: "resolve:start"; refs: number }
  | { type: "source:listed"; source: PrimitiveSource; skills: string[] }
  | {
      type: "resolve:done";
      skills: number;
      mcp: number;
      instructions: number;
      bundles: number;
      settings: number;
      warnings: number;
    }
  | {
      /** A transient network failure is being retried. Purely informational. */
      type: "source:retry";
      source: PrimitiveSource;
      attempt: number;
      of: number;
      delayMs: number;
      reason: string;
    }
  | { type: "skill:fetched"; name: string; commit: string; stagedDir: string }
  | { type: "skill:verified"; name: string; contentHash: string }
  | { type: "skill:materialized"; name: string; target: string; path: string }
  | { type: "skill:skipped"; name: string; target: string; path: string }
  | { type: "skill:removed"; name: string; target: string; path: string }
  | { type: "mcp:configured"; name: string; target: string; path: string }
  | { type: "instruction:written"; name: string; target: string; path: string }
  | { type: "instruction:removed"; name: string; target: string; path: string }
  | { type: "bundle:fetched"; name: string; commit: string; stagedDir: string }
  | {
      type: "bundle:materialized";
      name: string;
      target: string;
      /** Absolute destination per declared source path. */
      paths: Record<string, string>;
    }
  | { type: "bundle:skipped"; name: string; target: string; paths: Record<string, string> }
  | { type: "bundle:removed"; name: string; target: string; paths: Record<string, string> }
  | { type: "settings:written"; name: string; target: string; path: string }
  | { type: "settings:removed"; name: string; target: string; path: string }
  | { type: "lockfile:written"; path: string }
  | { type: "install:done"; installed: number; skipped: number }
  | { type: "warning"; warning: OutfitterWarning };

export type EventSink = (event: OutfitterEvent) => void;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface TrustPolicy {
  /** Hostnames git sources may be fetched from. Empty/omitted = any. */
  allowedHosts?: string[];
  /** Repo owners (first path segment) that are allowed. Empty/omitted = any. */
  allowedOwners?: string[];
  /** Fail when an installed tree's hash differs from the lockfile. Default true. */
  requireLockHashMatch?: boolean;
  /** How to treat skills that bundle executable scripts. Default `"warn"`. */
  scripts?: "allow" | "warn" | "deny";
  /**
   * How to treat a bundle that installs executable files, or a settings fragment
   * that registers hooks, a status line, or `permissions.allow` entries.
   * Default `"deny"`.
   *
   * A separate axis from `scripts` because it is a different and larger claim.
   * `scripts` describes files under a skill's `scripts/` folder, which the agent
   * runs only when a skill tells it to. An executable harness registers code into
   * lifecycle events that fire automatically on every tool call, can install a
   * `statusLine` command, and can pre-approve `Bash` through `permissions.allow`.
   * Nothing about that is implied by consenting to the former, so it is off until
   * an operator says otherwise.
   */
  executableHarness?: "allow" | "warn" | "deny";
  /** How to treat bidi/zero-width characters in text files. Default `"warn"`. */
  scan?: "off" | "warn" | "deny";
  /** Allow MCP servers pulled in by a dependency rather than the manifest. Default false. */
  allowTransitiveMcp?: boolean;
  /** Hosts a transitive HTTP MCP server may point at. */
  allowedMcpHosts?: string[];
  /** Commands a transitive stdio MCP server may run. */
  allowedMcpCommands?: string[];
  /**
   * Allow instruction fragments pulled in by a dependency rather than the
   * manifest. Default false.
   *
   * Gated for the same reason as MCP, and arguably more urgently: an
   * instruction fragment is text injected straight into the agent's standing
   * context, so a dependency that could add one silently could rewrite the
   * agent's operating rules.
   */
  allowTransitiveInstructions?: boolean;
  /** Local `file:`/`local:` sources bypass host checks. Default true. */
  allowLocalSources?: boolean;
}

export interface ResolvedPolicy
  extends Required<
    Omit<
      TrustPolicy,
      "allowedHosts" | "allowedOwners" | "allowedMcpHosts" | "allowedMcpCommands"
    >
  > {
  allowedHosts?: string[];
  allowedOwners?: string[];
  allowedMcpHosts?: string[];
  allowedMcpCommands?: string[];
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export interface TargetContext {
  /** The manager's working root: where the manifest and lockfile live. */
  root: string;
  cacheDir: string;
  emit: EventSink;
  warn: (warning: OutfitterWarning) => void;
}

export interface MaterializeInput {
  skill: ResolvedSkill;
  /** Absolute path to the verified, staged skill folder. */
  stagedDir: string;
  ctx: TargetContext;
}

export interface InstructionWriteInput {
  instructions: ResolvedInstruction[];
  /**
   * Fragment names agent-outfitter wrote into this target on a previous run,
   * from the lockfile. Anything here that is absent from `instructions` is a
   * region this manager owns and should now delete; everything else in the file
   * was written by a human and must survive untouched.
   */
  previouslyManaged: string[];
  ctx: TargetContext;
}

export interface InstructionWriteOutput {
  /** The instruction file that was merged into. */
  path: string;
  /** Fragment names actually written. */
  written: string[];
}

export interface MaterializeOutput {
  /** Absolute install path (or a stable identifier for non-filesystem targets). */
  path: string;
  /** Set by upload-style targets. */
  skillId?: string;
}

export interface McpWriteInput {
  servers: ResolvedMcpServer[];
  /**
   * Server names agent-outfitter wrote into this target on a previous run, from the
   * lockfile. Anything here that is not in `servers` is one this manager owns
   * and should now remove. Everything else in the config belongs to the user.
   */
  previouslyManaged: string[];
  ctx: TargetContext;
}

export interface McpWriteOutput {
  /** Where the config was written: a file path, or a URI for non-file targets. */
  path: string;
  /** Server names actually written. */
  written: string[];
}

export interface BundleMaterializeInput {
  bundle: ResolvedBundle;
  /** Absolute path the bundle's declared source paths resolve against. */
  stagedDir: string;
  ctx: TargetContext;
}

export interface BundleMaterializeOutput {
  /** Absolute destination per declared source path. */
  paths: Record<string, string>;
}

export interface SettingsWriteInput {
  settings: ResolvedSettings[];
  /**
   * Everything agent-outfitter owns in this target's settings file, from the
   * lockfile: the union across every fragment written on a previous run. Owned
   * keys absent from `settings` are ours to delete; every other key in the file
   * belongs to the user and must survive byte for byte.
   */
  previouslyManaged: OwnedSettingsKeys;
  ctx: TargetContext;
}

export interface SettingsWriteOutput {
  /** The settings file that was merged into. */
  path: string;
  /** Fragment names actually written. */
  written: string[];
  /** Keys now owned, per fragment name, for the lockfile to record. */
  owned: Record<string, OwnedSettings>;
}

export interface SettingsRemoveInput {
  /** Fragment names being removed. For diagnostics. */
  names: string[];
  /** The keys those fragments own, and only those: everything else stays. */
  previouslyManaged: OwnedSettingsKeys;
  ctx: TargetContext;
}

/**
 * A target is one agent harness's opinion about where things live.
 *
 * Primitive kinds land in genuinely different places and in different shapes:
 * a skill is a copied folder, an MCP server is a config table, an instruction is
 * a merged region of a markdown file, so each kind gets its own method rather
 * than one `materialize` that switches on kind internally. `supports` declares
 * which of them a target implements, so the manager can say precisely what will
 * not be installed instead of silently dropping it.
 */
export interface AgentTarget {
  readonly name: string;
  /** Primitive kinds this target can install. */
  readonly supports: readonly PrimitiveKind[];

  /**
   * Where a given kind lives for this target: an install directory for tree
   * primitives, or the file that config/instruction primitives merge into.
   */
  resolveDir(kind: PrimitiveKind, ctx: TargetContext): string | Promise<string>;

  /** Place a staged file-tree primitive (today: skills) into the target. */
  materialize(input: MaterializeInput): Promise<MaterializeOutput>;
  /**
   * Content hash of what is currently installed under `name`, or `undefined`
   * when nothing is. Lets the manager skip an unchanged skill without writing.
   * Targets that cannot read their own state may omit this.
   */
  currentHash?(name: string, ctx: TargetContext): Promise<string | undefined>;
  /** Remove a previously materialized skill. */
  unmaterialize?(name: string, ctx: TargetContext): Promise<void>;

  /** Merge MCP server entries into this target's config. Merge, never clobber. */
  writeMcpServers?(input: McpWriteInput): Promise<McpWriteOutput>;
  /** Remove only the MCP entries agent-outfitter manages. */
  removeMcpServers?(names: string[], ctx: TargetContext): Promise<void>;

  /** Merge instruction fragments into this target's instruction file. */
  writeInstructions?(input: InstructionWriteInput): Promise<InstructionWriteOutput>;
  /** Remove only the instruction regions agent-outfitter manages. */
  removeInstructions?(names: string[], ctx: TargetContext): Promise<void>;

  /** Copy a staged bundle's declared subtrees to their declared destinations. */
  materializeBundle?(input: BundleMaterializeInput): Promise<BundleMaterializeOutput>;
  /**
   * Combined hash of what is currently installed at this bundle's destinations,
   * or `undefined` when nothing is. Lets the manager skip an unchanged bundle.
   */
  currentBundleHash?(bundle: ResolvedBundle, ctx: TargetContext): Promise<string | undefined>;
  /** Delete the destination trees a bundle installed. */
  unmaterializeBundle?(paths: Record<string, string>, ctx: TargetContext): Promise<void>;

  /** Merge settings fragments into this target's settings file. Merge, never clobber. */
  writeSettings?(input: SettingsWriteInput): Promise<SettingsWriteOutput>;
  /** Remove only the settings keys agent-outfitter owns. */
  removeSettings?(input: SettingsRemoveInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface ManifestSourceEntry {
  ref: string;
  select?: string | string[];
  skillsRoot?: string;
  auth?: AuthRef;
}

export interface Manifest {
  version: 1;
  /** Target adapters, or built-in target names for YAML/JSON manifests. */
  targets?: (AgentTarget | string)[];
  sources?: (string | ManifestSourceEntry)[];
  mcp?: NamedMcpServer[];
  /** Instruction fragments to merge into each target's instruction file. */
  instructions?: (string | InstructionRefEntry)[];
  /**
   * Opaque subtrees to install verbatim. Declared, never discovered, and always
   * declared here rather than by a fetched source.
   */
  bundles?: BundleRefEntry[];
  /** Settings fragments to merge into each target's settings file. */
  settings?: SettingsRefEntry[];
  policy?: TrustPolicy;
}

// ---------------------------------------------------------------------------
// Resolution & results
// ---------------------------------------------------------------------------

export interface Resolution {
  /** Skill names in topological (dependency-first) order. */
  order: string[];
  /** Every skill, including transitive dependencies. */
  skills: Map<string, ResolvedSkill>;
  /** Every trusted MCP server. Dropped ones appear only as warnings. */
  mcp: Map<string, ResolvedMcpServer>;
  /** Every trusted instruction fragment. Dropped ones appear only as warnings. */
  instructions: Map<string, ResolvedInstruction>;
  /** Every declared bundle, staged and hashed. */
  bundles: Map<string, ResolvedBundle>;
  /** Every declared settings fragment. */
  settings: Map<string, ResolvedSettings>;
  warnings: OutfitterWarning[];
  /** Primitive kinds encountered but not yet installable. */
  unsupported: Primitive[];
}

export interface InstallResult {
  /** Everything written, across every kind and target. Check `kind` to filter. */
  installed: InstalledPrimitive[];
  /** Already present with a matching content hash. */
  skipped: InstalledPrimitive[];
  mcp: ResolvedMcpServer[];
  instructions: ResolvedInstruction[];
  bundles: ResolvedBundle[];
  settings: ResolvedSettings[];
  warnings: OutfitterWarning[];
  lockfilePath: string;
  /** True when `dryRun` was set. Nothing was written. */
  dryRun: boolean;
}

export interface VerifyIssue {
  kind:
    | "missing"
    | "hash-mismatch"
    | "hidden-unicode"
    | "scripts"
    | "extraneous"
    | "instruction-drift"
    | "settings-drift";
  name: string;
  /** Which primitive kind the issue is about. */
  primitive?: PrimitiveKind;
  target?: string;
  path?: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface VerifyReport {
  ok: boolean;
  checked: number;
  issues: VerifyIssue[];
}
