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
  installedHash,
  materializeToDir,
  resolveAgainstRoot,
  unmaterializeFromDir,
} from "./base.js";
import { TargetError } from "../errors.js";
import type {
  MaterializeInput,
  MaterializeOutput,
  McpWriteInput,
  McpWriteOutput,
  SkillTarget,
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
  /** Override the adapter name (useful when installing to two Codex homes). */
  name?: string;
}

export interface CodexTarget extends SkillTarget {
  /**
   * MCP entries in Codex's own config shape, populated after `install()`.
   * Pass as `new Codex({ config: target.mcpConfigOverrides })` when using
   * `mcpMode: "sdk-config"`.
   */
  readonly mcpConfigOverrides: { mcp_servers: Record<string, unknown> };
  /** Absolute path to the `config.toml` this target manages. */
  configPath(ctx: TargetContext): string;
}

const defaultCodexHome = (): string => process.env.CODEX_HOME ?? join(homedir(), ".codex");

export const codexTarget = (options: CodexTargetOptions = {}): CodexTarget => {
  const scope = options.scope ?? "user";
  const mcpMode = options.mcpMode ?? "file";
  const overrides: { mcp_servers: Record<string, unknown> } = { mcp_servers: {} };

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

  return {
    name: options.name ?? "codex",
    mcpConfigOverrides: overrides,

    configPath(ctx: TargetContext): string {
      return join(homeDir(ctx), "config.toml");
    },

    resolveSkillsDir(ctx: TargetContext): string {
      return skillsDir(ctx);
    },

    async materialize(input: MaterializeInput): Promise<MaterializeOutput> {
      const dir = skillsDir(input.ctx);
      await ensureDir(dir);
      return materializeToDir(dir, input);
    },

    async currentHash(name: string, ctx: TargetContext): Promise<string | undefined> {
      return installedHash(skillsDir(ctx), name);
    },

    async unmaterialize(name: string, ctx: TargetContext): Promise<void> {
      await unmaterializeFromDir(skillsDir(ctx), name);
    },

    async writeMcpServers(input: McpWriteInput): Promise<McpWriteOutput> {
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
