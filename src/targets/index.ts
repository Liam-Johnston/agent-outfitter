/** Built-in target adapters and name resolution for YAML/JSON manifests. */

import { TargetError } from "../errors.js";
import type { AgentTarget } from "../types.js";
import { claudeTarget } from "./claude.js";
import { codexTarget } from "./codex.js";

export { claudeTarget, type ClaudeTarget, type ClaudeTargetOptions } from "./claude.js";
export { codexTarget, type CodexTarget, type CodexTargetOptions } from "./codex.js";
export { filesystemTarget, type FilesystemTargetOptions } from "./filesystem.js";
export {
  openaiHostedTarget,
  type HostedSkillFile,
  type HostedUpload,
  type HostedUploadInput,
  type OpenAiHostedTargetOptions,
  type OpenAiLikeClient,
} from "./openai-hosted.js";
export {
  createContextCapture,
  installedHash,
  materializeToDir,
  removeInstructionsFromFile,
  resolveAgainstRoot,
  unmaterializeFromDir,
  writeInstructionFile,
  type ContextCapture,
} from "./base.js";
export {
  toClaudeSdkMcpEntry,
  toClaudeSdkMcpServers,
  type ClaudeSdkMcpServer,
  type ClaudeSdkOptions,
  type CodexSdkOptions,
} from "./sdk.js";
export {
  mergeCodexToml,
  mergeMcpJson,
  toClaudeMcpEntry,
  toCodexMcpEntry,
  toNormalizedMcpEntry,
} from "./mcp-config.js";

/**
 * Targets a YAML/JSON manifest can name as a bare string.
 *
 * Only adapters with sensible zero-argument defaults are listed:
 * `filesystemTarget` needs a directory, so it must be constructed in code.
 */
const BUILTIN_TARGETS: Record<string, () => AgentTarget> = {
  codex: () => codexTarget(),
  "codex:user": () => codexTarget({ scope: "user" }),
  "codex:project": () => codexTarget({ scope: "project" }),
  claude: () => claudeTarget(),
  "claude:project": () => claudeTarget({ scope: "project" }),
  "claude:user": () => claudeTarget({ scope: "user" }),
  "claude:plugin": () => claudeTarget({ mode: "plugin" }),
};

export const builtinTargetNames = (): string[] => Object.keys(BUILTIN_TARGETS);

export const resolveTarget = (target: AgentTarget | string): AgentTarget => {
  if (typeof target !== "string") return target;
  const factory = BUILTIN_TARGETS[target];
  if (!factory) {
    throw new TargetError(
      `Unknown target "${target}". Built-ins: ${builtinTargetNames().join(", ")}. ` +
        `Other targets (including filesystemTarget) must be constructed in a ` +
        `TypeScript config or passed via the manager's "targets" option.`,
      { target },
    );
  }
  return factory();
};
