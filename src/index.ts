/**
 * agent-outfitter — a library-first agent-skill package manager.
 *
 * Import a function, hand it a manifest (or refs) and one or more targets,
 * `await` the result. Nothing runs on import and nothing is written until you
 * call an install method.
 *
 * ```ts
 * import { createAgentManager, codexTarget } from "agent-outfitter";
 *
 * const skills = createAgentManager({
 *   targets: [codexTarget({ codexHome: "/workspace/.codex-home" })],
 *   policy: { allowedOwners: ["acme", "anthropics"] },
 * });
 *
 * const { installed } = await skills.install({
 *   refs: ["github:acme/agent-skills#v1.4.0"],
 * });
 * ```
 */

export { createAgentManager } from "./manager.js";
export type {
  AddOptions,
  InstallInput,
  ListOptions,
  RemoveOptions,
  ResolveInput,
  AgentManager,
  AgentManagerConfig,
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
export type {
  Lockfile,
  LockInstruction,
  LockMcp,
  LockSkill,
  LockTarget,
} from "./lockfile.js";

// -- targets ----------------------------------------------------------------
export {
  builtinTargetNames,
  claudeTarget,
  codexTarget,
  filesystemTarget,
  openaiHostedTarget,
  resolveTarget,
  // Building blocks for custom adapters.
  createContextCapture,
  installedHash,
  materializeToDir,
  mergeCodexToml,
  mergeMcpJson,
  removeInstructionsFromFile,
  resolveAgainstRoot,
  writeInstructionFile,
  toClaudeMcpEntry,
  toClaudeSdkMcpEntry,
  toClaudeSdkMcpServers,
  toCodexMcpEntry,
  toNormalizedMcpEntry,
  unmaterializeFromDir,
} from "./targets/index.js";
export type {
  ClaudeSdkMcpServer,
  ClaudeSdkOptions,
  ClaudeTarget,
  ClaudeTargetOptions,
  CodexSdkOptions,
  CodexTarget,
  CodexTargetOptions,
  ContextCapture,
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
export {
  beginMarker,
  discoverInstructions,
  endMarker,
  hashInstruction,
  instructionNameFromPath,
  managedRegionNames,
  MARKER_TAG,
  mergeInstructions,
  readRegion,
  renderRegion,
} from "./primitives/instruction.js";
export { describeMcpServer, mcpConfigHash, normalizeMcpServer } from "./primitives/mcp.js";
export { DEFAULT_POLICY, decideInstructionTrust, decideMcpTrust, resolvePolicy } from "./policy.js";
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
  OutfitterError,
  SkillNotFoundError,
  SourceResolutionError,
  TargetError,
} from "./errors.js";
export type { OutfitterErrorCode } from "./errors.js";

// -- types ------------------------------------------------------------------
export type {
  AgentTarget,
  AuthRef,
  AuthResolver,
  EventSink,
  GitProvider,
  InstallResult,
  InstalledPrimitive,
  Instruction,
  InstructionRefEntry,
  InstructionWriteInput,
  InstructionWriteOutput,
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
  ResolvedInstruction,
  ResolvedMcpServer,
  ResolvedPolicy,
  ResolvedSkill,
  Resolution,
  Skill,
  SkillDependencies,
  OutfitterEvent,
  PrimitiveRef,
  PrimitiveSource,
  OutfitterWarning,
  OutfitterWarningCode,
  StructuredPrimitiveRef,
  TargetContext,
  TrustPolicy,
  VerifyIssue,
  VerifyReport,
} from "./types.js";
