/**
 * skillsmith — a library-first agent-skill package manager.
 *
 * Import a function, hand it a manifest (or refs) and one or more targets,
 * `await` the result. Nothing runs on import and nothing is written until you
 * call an install method.
 *
 * ```ts
 * import { createSkillManager, codexTarget } from "skillsmith";
 *
 * const skills = createSkillManager({
 *   targets: [codexTarget({ codexHome: "/workspace/.codex-home" })],
 *   policy: { allowedOwners: ["acme", "anthropics"] },
 * });
 *
 * const { installed } = await skills.install({
 *   refs: ["github:acme/agent-skills#v1.4.0"],
 * });
 * ```
 */

export { createSkillManager } from "./manager.js";
export type {
  AddOptions,
  InstallInput,
  ListOptions,
  RemoveOptions,
  ResolveInput,
  SkillManager,
  SkillManagerConfig,
  SyncOptions,
  VerifyOptions,
} from "./manager.js";

// -- manifest ---------------------------------------------------------------
export {
  defineConfig,
  findManifest,
  loadManifest,
  manifestSchema,
  MANIFEST_CANDIDATES,
  validateManifest,
} from "./manifest.js";

// -- lockfile ---------------------------------------------------------------
export {
  emptyLockfile,
  lockfilePath,
  lockfileSchema,
  LOCKFILE_NAME,
  readLockfile,
  serializeLockfile,
  writeLockfile,
} from "./lockfile.js";
export type { Lockfile, LockMcp, LockSkill, LockTarget } from "./lockfile.js";

// -- targets ----------------------------------------------------------------
export {
  builtinTargetNames,
  claudeTarget,
  codexTarget,
  filesystemTarget,
  openaiHostedTarget,
  resolveTarget,
  // Building blocks for custom adapters.
  installedHash,
  materializeToDir,
  mergeCodexToml,
  mergeMcpJson,
  resolveAgainstRoot,
  toClaudeMcpEntry,
  toCodexMcpEntry,
  toNormalizedMcpEntry,
  unmaterializeFromDir,
} from "./targets/index.js";
export type {
  ClaudeTarget,
  ClaudeTargetOptions,
  CodexTarget,
  CodexTargetOptions,
  FilesystemTargetOptions,
  HostedSkillFile,
  HostedUpload,
  HostedUploadInput,
  OpenAiHostedTargetOptions,
  OpenAiLikeClient,
} from "./targets/index.js";

// -- sources ----------------------------------------------------------------
export {
  builtinSourceProviders,
  gitSourceProvider,
  localSourceProvider,
  selectProvider,
} from "./sources/index.js";
export type { ProviderContext, SourceProvider } from "./sources/index.js";

// -- resolution internals worth reusing -------------------------------------
export { discoverSkills, CONVENTIONAL_SKILL_ROOTS } from "./discover.js";
export { hashTree, hashCanonicalJson, HASH_PREFIX } from "./hash.js";
export { normalizeRef, parseRefString, describeSource, sourceKey } from "./refs.js";
export { parseSkillMd, readSkillMd, SKILL_FILE } from "./primitives/skill.js";
export { describeMcpServer, mcpConfigHash, normalizeMcpServer } from "./primitives/mcp.js";
export { DEFAULT_POLICY, resolvePolicy } from "./policy.js";
export { checkTree, scanTextForHiddenUnicode } from "./verify.js";
export { defaultCacheDir } from "./paths.js";

// -- errors -----------------------------------------------------------------
export {
  AuthError,
  CycleError,
  HashMismatchError,
  LockfileError,
  ManifestError,
  NotImplementedError,
  PolicyViolationError,
  SkillsmithError,
  SkillNotFoundError,
  SourceResolutionError,
  TargetError,
} from "./errors.js";
export type { SkillsmithErrorCode } from "./errors.js";

// -- types ------------------------------------------------------------------
export type {
  AuthRef,
  AuthResolver,
  EventSink,
  GitProvider,
  InstallResult,
  InstalledSkill,
  Manifest,
  ManifestSourceEntry,
  MaterializeInput,
  MaterializeOutput,
  McpServer,
  McpWriteInput,
  McpWriteOutput,
  NamedMcpServer,
  NormalizedRef,
  Primitive,
  PrimitiveKind,
  ResolvedMcpServer,
  ResolvedPolicy,
  ResolvedSkill,
  Resolution,
  Skill,
  SkillDependencies,
  SkillEvent,
  SkillRef,
  SkillSource,
  SkillTarget,
  SkillWarning,
  SkillWarningCode,
  StructuredSkillRef,
  TargetContext,
  TrustPolicy,
  VerifyIssue,
  VerifyReport,
} from "./types.js";
