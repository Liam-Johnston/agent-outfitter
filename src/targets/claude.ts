/**
 * Claude target.
 *
 * Claude Code auto-discovers skills under `.claude/skills` — dropping the folder
 * in is the whole install. The Claude *Agent SDK* is the exception: it only
 * reads filesystem skills when `settingSources` is set (or when they arrive as
 * a plugin). So `sdkOptions()` returns exactly that configuration, computed from
 * the same paths this target installed into — the wiring most likely to be got
 * wrong is the wiring you no longer have to write.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { ensureDir, writeFileAtomic } from "../fsutil.js";
import {
  createContextCapture,
  installedHash,
  materializeToDir,
  removeInstructionsFromFile,
  resolveAgainstRoot,
  unmaterializeFromDir,
  writeInstructionFile,
} from "./base.js";
import {
  mergeMcpJson,
  readIfExists,
  toClaudeMcpEntry,
  writeConfigIfChanged,
} from "./mcp-config.js";
import { toClaudeSdkMcpServers, type ClaudeSdkOptions } from "./sdk.js";
import type {
  AgentTarget,
  InstructionWriteInput,
  InstructionWriteOutput,
  MaterializeInput,
  MaterializeOutput,
  McpServer,
  McpWriteInput,
  McpWriteOutput,
  PrimitiveKind,
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
  /** Plugin directory name for `mode: "plugin"`. Default `"agent-outfitter-skills"`. */
  pluginName?: string;
  /** `"user"` writes to `~/.claude/skills` instead of the project directory. */
  scope?: "project" | "user";
  /**
   * Which Claude surface will read these skills. `"agent-sdk"` adds a warning
   * reminding the caller to set `settingSources`, since the SDK — unlike the
   * Claude Code app — does not read filesystem skills by default.
   */
  consumer?: "code" | "agent-sdk";
  /** Instruction file Claude reads. Default `CLAUDE.md`. */
  instructionFile?: string;
  name?: string;
}

export interface ClaudeTarget extends AgentTarget {
  /** Which consumer this target was configured for. Recorded for diagnostics. */
  readonly consumer: "code" | "agent-sdk";
  mcpConfigPath(ctx: TargetContext): string;
  /** Absolute path to the `CLAUDE.md` this target merges instructions into. */
  instructionPath(ctx: TargetContext): string;
  /**
   * Everything the Claude Agent SDK needs to actually see what this target
   * installed — most importantly `settingSources`, without which the SDK loads
   * no filesystem skills at all.
   *
   * ```ts
   * const sdk = claudeT.sdkOptions();
   * for await (const msg of query({ prompt, options: { ...sdk } })) { … }
   * ```
   *
   * Call after `install()` or `sync()`; the MCP entries are populated by the
   * install. The context defaults to the one the last install ran under.
   *
   * The returned `mcpServers` has env references resolved to **real values**, so
   * it may carry secrets — hand it to the SDK, do not log it. Claude Code
   * (`consumer: "code"`) needs none of this and reads the files directly.
   */
  sdkOptions(ctx?: TargetContext): ClaudeSdkOptions;
}

export const claudeTarget = (options: ClaudeTargetOptions = {}): ClaudeTarget => {
  const mode = options.mode ?? "skills";
  const consumer = options.consumer ?? "code";
  const pluginName = options.pluginName ?? "agent-outfitter-skills";
  const scope = options.scope ?? "project";
  const contexts = createContextCapture();
  /** MCP servers this target registered, kept for the SDK handoff. */
  let registered: { name: string; server: McpServer }[] = [];

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
          description: "Skills installed by agent-outfitter.",
          version: "0.0.0",
        },
        null,
        2,
      )}\n`,
    );
  };

  /**
   * The `settingSources` layer that makes `skillsDir` visible.
   *
   * Plugin mode returns none: a bundle is loaded through `plugins` instead, and
   * naming a settings source there would pull in unrelated project settings the
   * caller never asked for.
   */
  const settingSources = (): ClaudeSdkOptions["settingSources"] =>
    mode === "plugin" ? [] : scope === "user" ? ["user"] : ["project"];

  /**
   * Tell the caller how to consume what was just written.
   *
   * Kept as a warning even though `sdkOptions()` now supplies the answer,
   * because the failure it prevents is silent: an SDK constructed without these
   * options runs happily and simply never loads a skill.
   */
  const warnAgentSdk = (ctx: TargetContext, dir: string): void => {
    if (consumer !== "agent-sdk") return;
    const how =
      mode === "plugin"
        ? `pass plugins: [{ type: "local", path: "${pluginDir(ctx)}" }]`
        : `pass settingSources: ${JSON.stringify(settingSources())}`;
    ctx.warn({
      code: "target-config",
      subject: "claude",
      message:
        `Skills were written to ${dir}, but the Claude Agent SDK does not load filesystem ` +
        `skills by default — you must ${how}. Spread this target's sdkOptions() into the ` +
        `query() options to get that wiring, and its MCP servers, without hand-building it. ` +
        `Claude Code itself needs no configuration.`,
      detail: { dir, consumer, mode },
    });
  };

  /**
   * `CLAUDE.md` sits at the project root, where Claude Code looks — not inside
   * `.claude/`. User scope puts it in the Claude config dir instead.
   */
  const instructionPath = (ctx: TargetContext): string => {
    const file = options.instructionFile ?? "CLAUDE.md";
    if (mode === "plugin") return join(pluginDir(ctx), file);
    return scope === "user" ? join(claudeDir(ctx), file) : join(baseDir(ctx), file);
  };

  return {
    name: options.name ?? "claude",
    supports: ["skill", "mcp", "instruction"],
    consumer,

    mcpConfigPath(ctx: TargetContext): string {
      return mcpPath(ctx);
    },

    instructionPath,

    sdkOptions(override?: TargetContext): ClaudeSdkOptions {
      const ctx = contexts.resolve(override);
      // Warnings are dropped here on purpose: this accessor is pure, and the
      // same check already ran at install time against a live warning sink.
      const { servers } = toClaudeSdkMcpServers(registered);
      const sources = settingSources();
      return {
        settingSources: sources,
        ...(mode === "plugin"
          ? { plugins: [{ type: "local" as const, path: pluginDir(ctx) }] }
          : {}),
        mcpServers: servers,
        // `cwd` is what "project" is resolved relative to, so it is only
        // meaningful when a project settings source is in play.
        ...(sources.includes("project") ? { cwd: baseDir(ctx) } : {}),
        skillsDir: skillsDir(ctx),
        instructionPath: instructionPath(ctx),
      };
    },

    resolveDir(kind: PrimitiveKind, ctx: TargetContext): string {
      contexts.capture(ctx);
      if (kind === "mcp") return mcpPath(ctx);
      if (kind === "instruction") return instructionPath(ctx);
      return skillsDir(ctx);
    },

    async materialize(input: MaterializeInput): Promise<MaterializeOutput> {
      contexts.capture(input.ctx);
      await ensurePluginManifest(input.ctx);
      const dir = skillsDir(input.ctx);
      await ensureDir(dir);
      const result = await materializeToDir(dir, input);
      warnAgentSdk(input.ctx, dir);
      return result;
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
      registered = input.servers.map((s) => ({ name: s.name, server: s.server }));

      // Resolving env references is what `sdkOptions()` will do, so surface a
      // missing variable now — while there is still a live warning sink — rather
      // than letting it become an opaque auth failure at the first tool call.
      if (consumer === "agent-sdk") {
        const { warnings } = toClaudeSdkMcpServers(registered);
        for (const warning of warnings) input.ctx.warn(warning);
      }

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

    async writeInstructions(input: InstructionWriteInput): Promise<InstructionWriteOutput> {
      contexts.capture(input.ctx);
      await ensurePluginManifest(input.ctx);
      return writeInstructionFile(instructionPath(input.ctx), input);
    },

    async removeInstructions(names: string[], ctx: TargetContext): Promise<void> {
      await removeInstructionsFromFile(instructionPath(ctx), names);
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
