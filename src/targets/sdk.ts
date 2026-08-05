/**
 * In-process SDK handoff.
 *
 * A target knows exactly where it put things and which of those locations its
 * harness actually reads. When the consumer is an SDK running in the same
 * process rather than the harness's own CLI, that knowledge is the difference
 * between a successful install and an agent that silently loads nothing — so
 * each target exposes it as `sdkOptions()`, ready to spread into the SDK
 * constructor.
 *
 * ## Why this serialization differs from the on-disk one
 *
 * `toClaudeMcpEntry` writes `${VAR}` placeholders into `.mcp.json` because
 * Claude Code expands them when it reads the file — the secret never lands on
 * disk. An in-process SDK option object is not read by anything that performs
 * that expansion, so a placeholder would be passed through verbatim as a broken
 * credential. Here the value is resolved from `process.env` instead.
 *
 * The consequence is the reason this lives in its own module rather than beside
 * the file writers: **the object returned by `sdkOptions()` can contain real
 * secrets.** It is built to be handed straight to an SDK constructor. Do not log
 * it, serialize it into an event, or write it to disk.
 */

import type { McpServer, OutfitterWarning } from "../types.js";

// ---------------------------------------------------------------------------
// Option shapes
// ---------------------------------------------------------------------------

/**
 * An MCP server entry in the shape the Claude Agent SDK's `mcpServers` option
 * takes. Structural rather than imported, so `@anthropic-ai/claude-agent-sdk`
 * stays an optional peer.
 */
export type ClaudeSdkMcpServer =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export interface ClaudeSdkOptions {
  /**
   * Which settings layers the SDK should load. This is the option whose absence
   * makes filesystem skills invisible to the Agent SDK, so it is always set.
   * Empty when `mode: "plugin"`, where `plugins` carries the skills instead.
   */
  settingSources: ("project" | "user" | "local")[];
  /** Locally-installed plugin bundles, set only when `mode: "plugin"`. */
  plugins?: { type: "local"; path: string }[];
  /** MCP servers with env references already resolved to values. */
  mcpServers: Record<string, ClaudeSdkMcpServer>;
  /**
   * The directory `settingSources: ["project"]` is resolved against. Only
   * meaningful for project scope; omitted for user scope, where the settings
   * layer is anchored at the Claude config dir instead.
   */
  cwd?: string;
  /** Where skills were installed. Informational — the SDK derives it itself. */
  skillsDir: string;
  /** The `CLAUDE.md` instructions were merged into. */
  instructionPath: string;
}

export interface CodexSdkOptions {
  /**
   * Environment overrides to merge into the SDK's `env`. Carries `CODEX_HOME`,
   * which is what points Codex at the home this target installed into.
   *
   * Spread over `process.env` rather than passed alone — Codex needs `PATH` and
   * its credentials from the ambient environment:
   * `new Codex({ env: { ...process.env, ...sdk.env } })`
   */
  env: { CODEX_HOME: string };
  /** Config overrides for the SDK's `config` option. */
  config: { mcp_servers: Record<string, unknown> };
  /** Where skills were installed. Codex discovers them from here on its own. */
  skillsDir: string;
  /** The `AGENTS.md` instructions were merged into. */
  instructionPath: string;
}

// ---------------------------------------------------------------------------
// Env resolution
// ---------------------------------------------------------------------------

export interface EnvResolution<T> {
  value: T;
  /** Env vars a server referenced that are absent from the environment. */
  missing: string[];
}

/**
 * Translate an MCP server into the Claude Agent SDK's in-process shape,
 * resolving env-var *names* to their current values.
 *
 * A referenced variable that is unset is reported rather than emitted as an
 * empty string: an empty `Authorization` header fails at the first tool call
 * with an opaque auth error, which is far harder to trace back to a missing
 * variable in the container's environment than a warning at install time.
 */
export const toClaudeSdkMcpEntry = (
  server: McpServer,
  env: Record<string, string | undefined> = process.env,
): EnvResolution<ClaudeSdkMcpServer> => {
  const missing: string[] = [];
  const read = (name: string): string | undefined => {
    const value = env[name];
    if (value === undefined || value === "") {
      missing.push(name);
      return undefined;
    }
    return value;
  };

  if (server.transport === "stdio") {
    const passthrough: Record<string, string> = {};
    for (const name of server.envVars ?? []) {
      const value = read(name);
      if (value !== undefined) passthrough[name] = value;
    }
    return {
      value: {
        type: "stdio",
        command: server.command,
        ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
        ...(Object.keys(passthrough).length > 0 ? { env: passthrough } : {}),
      },
      missing,
    };
  }

  const headers: Record<string, string> = { ...server.headers };
  if (server.auth?.bearerEnv) {
    const token = read(server.auth.bearerEnv);
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  }
  return {
    value: {
      type: "http",
      url: server.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
    missing,
  };
};

/** Build the whole `mcpServers` map, collecting one warning per short-handed server. */
export const toClaudeSdkMcpServers = (
  servers: readonly { name: string; server: McpServer }[],
  env: Record<string, string | undefined> = process.env,
): { servers: Record<string, ClaudeSdkMcpServer>; warnings: OutfitterWarning[] } => {
  const out: Record<string, ClaudeSdkMcpServer> = {};
  const warnings: OutfitterWarning[] = [];

  for (const { name, server } of servers) {
    const { value, missing } = toClaudeSdkMcpEntry(server, env);
    out[name] = value;
    if (missing.length > 0) {
      warnings.push({
        code: "target-config",
        subject: name,
        message:
          `MCP server "${name}" references ${missing.join(", ")}, which ${
            missing.length === 1 ? "is" : "are"
          } not set in this process's environment. The SDK receives the server ` +
          `without ${missing.length === 1 ? "it" : "them"}, so it will likely fail to ` +
          `authenticate.`,
        detail: { server: name, missing },
      });
    }
  }
  return { servers: out, warnings };
};
