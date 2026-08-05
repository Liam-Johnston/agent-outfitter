/**
 * Codex target.
 *
 * Codex auto-discovers skills from `$CODEX_HOME/skills` (user scope) or
 * `<project>/.agents/skills` (project scope), so installing a skill is just
 * placing the folder — no config entry is involved. `config.toml` is touched
 * only to register MCP servers, which are not auto-discovered.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { ensureDir } from "../fsutil.js";
import { toCodexMcpEntry } from "./mcp-config.js";
import { mergeCodexToml, readIfExists, writeConfigIfChanged } from "./mcp-config.js";
import {
  createContextCapture,
  installedHash,
  materializeToDir,
  removeInstructionsFromFile,
  resolveAgainstRoot,
  unmaterializeFromDir,
  writeInstructionFile,
} from "./base.js";
import type { CodexSdkOptions } from "./sdk.js";
import { TargetError } from "../errors.js";
import type {
  AgentTarget,
  InstructionWriteInput,
  InstructionWriteOutput,
  MaterializeInput,
  MaterializeOutput,
  McpWriteInput,
  McpWriteOutput,
  PrimitiveKind,
  TargetContext,
} from "../types.js";

export interface CodexTargetOptions {
  /** Defaults to `$CODEX_HOME`, then `~/.codex`. */
  codexHome?: string;
  /** `"user"` writes to `$CODEX_HOME/skills`; `"project"` to `.agents/skills`. */
  scope?: "user" | "project";
  /** Project root for `scope: "project"`. Defaults to the manager root. */
  projectDir?: string;
  /**
   * Where MCP servers go.
   *
   * `"file"` writes `[mcp_servers.*]` into `config.toml` — persistent, and
   * shared with the Codex CLI and IDE. `"sdk-config"` writes nothing and
   * instead exposes the same entries via `mcpConfigOverrides`, for passing to
   * `@openai/codex-sdk`'s `config` option. Default `"file"`.
   */
  mcpMode?: "file" | "sdk-config";
  /**
   * Instruction file Codex reads. Default `AGENTS.md`, in `$CODEX_HOME` for user
   * scope or the project directory for project scope.
   */
  instructionFile?: string;
  /** Override the adapter name (useful when installing to two Codex homes). */
  name?: string;
}

export interface CodexTarget extends AgentTarget {
  /**
   * MCP entries in Codex's own config shape, populated after `install()`.
   * Pass as `new Codex({ config: target.mcpConfigOverrides })` when using
   * `mcpMode: "sdk-config"`.
   */
  readonly mcpConfigOverrides: { mcp_servers: Record<string, unknown> };
  /** Absolute path to the `config.toml` this target manages. */
  configPath(ctx: TargetContext): string;
  /** Absolute path to the `AGENTS.md` this target merges instructions into. */
  instructionPath(ctx: TargetContext): string;
  /**
   * Everything `@openai/codex-sdk` needs to see what this target installed.
   *
   * ```ts
   * const sdk = codexT.sdkOptions();
   * const codex = new Codex({ env: { ...process.env, ...sdk.env }, config: sdk.config });
   * ```
   *
   * Available in both `mcpMode`s: with `"file"` the entries are also on disk in
   * `config.toml`, and passing them again is harmless.
   *
   * Call after `install()` or `sync()` — the MCP entries are populated by the
   * install. The context defaults to the one the last install ran under.
   */
  sdkOptions(ctx?: TargetContext): CodexSdkOptions;
}

const defaultCodexHome = (): string => process.env.CODEX_HOME ?? join(homedir(), ".codex");

export const codexTarget = (options: CodexTargetOptions = {}): CodexTarget => {
  const scope = options.scope ?? "user";
  const mcpMode = options.mcpMode ?? "file";
  const overrides: { mcp_servers: Record<string, unknown> } = { mcp_servers: {} };
  const contexts = createContextCapture();

  const homeDir = (ctx: TargetContext): string =>
    resolveAgainstRoot(ctx, options.codexHome ?? defaultCodexHome());

  const skillsDir = (ctx: TargetContext): string => {
    if (scope === "project") {
      const projectDir = options.projectDir
        ? resolveAgainstRoot(ctx, options.projectDir)
        : ctx.root;
      return join(projectDir, ".agents", "skills");
    }
    return join(homeDir(ctx), "skills");
  };

  /**
   * Instructions belong wherever the agent actually runs: alongside the project
   * for project scope, and in `$CODEX_HOME` for user scope so they apply to
   * every session that home serves.
   */
  const instructionPath = (ctx: TargetContext): string => {
    const file = options.instructionFile ?? "AGENTS.md";
    if (scope === "project") {
      const projectDir = options.projectDir ? resolveAgainstRoot(ctx, options.projectDir) : ctx.root;
      return join(projectDir, file);
    }
    return join(homeDir(ctx), file);
  };

  return {
    name: options.name ?? "codex",
    supports: ["skill", "mcp", "instruction"],
    mcpConfigOverrides: overrides,

    configPath(ctx: TargetContext): string {
      return join(homeDir(ctx), "config.toml");
    },

    instructionPath,

    sdkOptions(override?: TargetContext): CodexSdkOptions {
      const ctx = contexts.resolve(override);
      return {
        env: { CODEX_HOME: homeDir(ctx) },
        // Copied, so a later install cannot mutate an object already handed to
        // an SDK constructor.
        config: { mcp_servers: { ...overrides.mcp_servers } },
        skillsDir: skillsDir(ctx),
        instructionPath: instructionPath(ctx),
      };
    },

    resolveDir(kind: PrimitiveKind, ctx: TargetContext): string {
      contexts.capture(ctx);
      if (kind === "mcp") return join(homeDir(ctx), "config.toml");
      if (kind === "instruction") return instructionPath(ctx);
      return skillsDir(ctx);
    },

    async materialize(input: MaterializeInput): Promise<MaterializeOutput> {
      contexts.capture(input.ctx);
      const dir = skillsDir(input.ctx);
      await ensureDir(dir);
      return materializeToDir(dir, input);
    },

    async currentHash(name: string, ctx: TargetContext): Promise<string | undefined> {
      contexts.capture(ctx);
      return installedHash(skillsDir(ctx), name);
    },

    async unmaterialize(name: string, ctx: TargetContext): Promise<void> {
      await unmaterializeFromDir(skillsDir(ctx), name);
    },

    async writeMcpServers(input: McpWriteInput): Promise<McpWriteOutput> {
      contexts.capture(input.ctx);
      const path = join(homeDir(input.ctx), "config.toml");

      if (mcpMode === "sdk-config") {
        overrides.mcp_servers = Object.fromEntries(
          input.servers.map((s) => [s.name, toCodexMcpEntry(s.server)]),
        );
        return { path: "codex://config-overrides", written: input.servers.map((s) => s.name) };
      }

      if (input.servers.length === 0 && input.previouslyManaged.length === 0) {
        return { path, written: [] };
      }

      const merged = mergeCodexToml(
        await readIfExists(path),
        input.servers,
        input.previouslyManaged,
        path,
      );
      for (const warning of merged.warnings) input.ctx.warn(warning);

      await ensureDir(homeDir(input.ctx));
      try {
        await writeConfigIfChanged(path, merged.content);
      } catch (error) {
        throw new TargetError(
          `Failed to write Codex MCP config at ${path}: ${(error as Error).message}`,
          { path },
        );
      }
      overrides.mcp_servers = Object.fromEntries(
        input.servers.map((s) => [s.name, toCodexMcpEntry(s.server)]),
      );
      return { path, written: merged.written };
    },

    async writeInstructions(input: InstructionWriteInput): Promise<InstructionWriteOutput> {
      contexts.capture(input.ctx);
      return writeInstructionFile(instructionPath(input.ctx), input);
    },

    async removeInstructions(names: string[], ctx: TargetContext): Promise<void> {
      await removeInstructionsFromFile(instructionPath(ctx), names);
    },

    async removeMcpServers(names: string[], ctx: TargetContext): Promise<void> {
      if (mcpMode === "sdk-config") {
        for (const name of names) delete overrides.mcp_servers[name];
        return;
      }
      const path = join(homeDir(ctx), "config.toml");
      const existing = await readIfExists(path);
      if (existing === undefined) return;
      const merged = mergeCodexToml(existing, [], names, path);
      for (const warning of merged.warnings) ctx.warn(warning);
      await writeConfigIfChanged(path, merged.content);
    },
  };
};
