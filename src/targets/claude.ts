/**
 * Claude target.
 *
 * Claude Code auto-discovers skills under `.claude/skills` — dropping the folder
 * in is the whole install. The Claude *Agent SDK* is the exception: it only
 * reads filesystem skills when `settingSources` is set (or when they arrive as
 * a plugin), so `consumer: "agent-sdk"` emits a warning describing exactly what
 * the caller still has to configure.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { ensureDir, writeFileAtomic } from "../fsutil.js";
import {
  installedHash,
  materializeToDir,
  resolveAgainstRoot,
  unmaterializeFromDir,
} from "./base.js";
import {
  mergeMcpJson,
  readIfExists,
  toClaudeMcpEntry,
  writeConfigIfChanged,
} from "./mcp-config.js";
import type {
  MaterializeInput,
  MaterializeOutput,
  McpWriteInput,
  McpWriteOutput,
  SkillTarget,
  TargetContext,
} from "../types.js";

export interface ClaudeTargetOptions {
  /** Directory holding `.claude/`. Defaults to the manager root. */
  dir?: string;
  /**
   * `"skills"` writes `<dir>/.claude/skills/<name>`.
   * `"plugin"` writes a plugin bundle at `<dir>/<pluginName>` with a
   * `.claude-plugin/plugin.json` and its skills inside.
   */
  mode?: "skills" | "plugin";
  /** Plugin directory name for `mode: "plugin"`. Default `"skillsmith-skills"`. */
  pluginName?: string;
  /** `"user"` writes to `~/.claude/skills` instead of the project directory. */
  scope?: "project" | "user";
  /**
   * Which Claude surface will read these skills. `"agent-sdk"` adds a warning
   * reminding the caller to set `settingSources`, since the SDK — unlike the
   * Claude Code app — does not read filesystem skills by default.
   */
  consumer?: "code" | "agent-sdk";
  name?: string;
}

export interface ClaudeTarget extends SkillTarget {
  /** Which consumer this target was configured for. Recorded for diagnostics. */
  readonly consumer: "code" | "agent-sdk";
  mcpConfigPath(ctx: TargetContext): string;
}

export const claudeTarget = (options: ClaudeTargetOptions = {}): ClaudeTarget => {
  const mode = options.mode ?? "skills";
  const consumer = options.consumer ?? "code";
  const pluginName = options.pluginName ?? "skillsmith-skills";
  const scope = options.scope ?? "project";

  /** The directory that *contains* `.claude/` (project scope) or is it (user scope). */
  const baseDir = (ctx: TargetContext): string =>
    options.dir ? resolveAgainstRoot(ctx, options.dir) : ctx.root;

  /** The `.claude` directory itself. */
  const claudeDir = (ctx: TargetContext): string =>
    scope === "user"
      ? resolveAgainstRoot(ctx, process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"))
      : join(baseDir(ctx), ".claude");

  const pluginDir = (ctx: TargetContext): string => join(baseDir(ctx), pluginName);

  const skillsDir = (ctx: TargetContext): string =>
    mode === "plugin" ? join(pluginDir(ctx), "skills") : join(claudeDir(ctx), "skills");

  /**
   * `.mcp.json` sits at the project root for project scope (that is where Claude
   * Code looks), inside the bundle for a plugin, and inside `.claude` for user
   * scope, where there is no project root to anchor to.
   */
  const mcpPath = (ctx: TargetContext): string => {
    if (mode === "plugin") return join(pluginDir(ctx), ".mcp.json");
    return scope === "user" ? join(claudeDir(ctx), ".mcp.json") : join(baseDir(ctx), ".mcp.json");
  };

  /** A plugin bundle is only discoverable once its manifest exists. */
  const ensurePluginManifest = async (ctx: TargetContext): Promise<void> => {
    if (mode !== "plugin") return;
    const manifestPath = join(pluginDir(ctx), ".claude-plugin", "plugin.json");
    const existing = await readIfExists(manifestPath);
    if (existing !== undefined) return;
    await ensureDir(join(pluginDir(ctx), ".claude-plugin"));
    await writeFileAtomic(
      manifestPath,
      `${JSON.stringify(
        {
          name: pluginName,
          description: "Skills installed by skillsmith.",
          version: "0.0.0",
        },
        null,
        2,
      )}\n`,
    );
  };

  const warnAgentSdk = (ctx: TargetContext, dir: string): void => {
    if (consumer !== "agent-sdk") return;
    ctx.warn({
      code: "target-config",
      subject: "claude",
      message:
        `Skills were written to ${dir}, but the Claude Agent SDK does not load filesystem ` +
        `skills unless you pass settingSources: ['project'] (or ['user']) — or load them ` +
        `through the "plugins" option. Claude Code itself needs no configuration.`,
      detail: { dir, consumer },
    });
  };

  return {
    name: options.name ?? "claude",
    consumer,

    mcpConfigPath(ctx: TargetContext): string {
      return mcpPath(ctx);
    },

    resolveSkillsDir(ctx: TargetContext): string {
      return skillsDir(ctx);
    },

    async materialize(input: MaterializeInput): Promise<MaterializeOutput> {
      await ensurePluginManifest(input.ctx);
      const dir = skillsDir(input.ctx);
      await ensureDir(dir);
      const result = await materializeToDir(dir, input);
      warnAgentSdk(input.ctx, dir);
      return result;
    },

    async currentHash(name: string, ctx: TargetContext): Promise<string | undefined> {
      return installedHash(skillsDir(ctx), name);
    },

    async unmaterialize(name: string, ctx: TargetContext): Promise<void> {
      await unmaterializeFromDir(skillsDir(ctx), name);
    },

    async writeMcpServers(input: McpWriteInput): Promise<McpWriteOutput> {
      const path = mcpPath(input.ctx);
      if (input.servers.length === 0 && input.previouslyManaged.length === 0) {
        return { path, written: [] };
      }
      await ensurePluginManifest(input.ctx);
      const merged = mergeMcpJson(
        await readIfExists(path),
        input.servers,
        input.previouslyManaged,
        path,
        toClaudeMcpEntry,
      );
      await writeConfigIfChanged(path, merged.content);
      return { path, written: merged.written };
    },

    async removeMcpServers(names: string[], ctx: TargetContext): Promise<void> {
      const path = mcpPath(ctx);
      const existing = await readIfExists(path);
      if (existing === undefined) return;
      const merged = mergeMcpJson(existing, [], names, path, toClaudeMcpEntry);
      await writeConfigIfChanged(path, merged.content);
    },
  };
};
