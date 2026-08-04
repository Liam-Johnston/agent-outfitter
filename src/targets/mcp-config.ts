/**
 * MCP config translation and merging.
 *
 * MCP servers are the only thing skillsmith writes into a harness's config —
 * skills themselves are auto-discovered from their directory. Every write here
 * is a *merge*: entries the user or another tool put in the file are preserved,
 * and skillsmith only ever adds, updates, or removes servers it manages.
 *
 * Secrets are referenced by environment-variable name and never inlined, so a
 * generated config is safe to bake into a container image.
 */

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { TargetError } from "../errors.js";
import { pathExists, readTextFile, writeFileAtomic } from "../fsutil.js";
import type { McpServer, ResolvedMcpServer, SkillWarning } from "../types.js";

// ---------------------------------------------------------------------------
// Codex — $CODEX_HOME/config.toml, [mcp_servers.<name>]
// ---------------------------------------------------------------------------

export const toCodexMcpEntry = (server: McpServer): Record<string, unknown> => {
  if (server.transport === "stdio") {
    return {
      command: server.command,
      ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
      ...(server.envVars && server.envVars.length > 0 ? { env_vars: server.envVars } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    };
  }
  return {
    url: server.url,
    ...(server.auth?.bearerEnv ? { bearer_token_env_var: server.auth.bearerEnv } : {}),
    ...(server.headers && Object.keys(server.headers).length > 0
      ? { http_headers: server.headers }
      : {}),
  };
};

export interface TomlMergeResult {
  content: string;
  written: string[];
  warnings: SkillWarning[];
}

/**
 * Merge MCP entries into a Codex `config.toml`.
 *
 * `smol-toml` round-trips values, not comments, so a config that carries
 * comments is flagged: the operator should know their annotations were dropped.
 */
export const mergeCodexToml = (
  existing: string | undefined,
  servers: readonly ResolvedMcpServer[],
  managedNames: readonly string[],
  configPath: string,
): TomlMergeResult => {
  const warnings: SkillWarning[] = [];
  let doc: Record<string, unknown> = {};

  if (existing && existing.trim().length > 0) {
    try {
      doc = parseToml(existing) as Record<string, unknown>;
    } catch (error) {
      throw new TargetError(
        `Could not parse ${configPath} as TOML: ${(error as Error).message}. ` +
          `Fix or remove the file before installing MCP servers.`,
        { path: configPath },
      );
    }
    if (/^\s*#/m.test(existing)) {
      warnings.push({
        code: "target-config",
        subject: configPath,
        message:
          `${configPath} contains comments. Rewriting it to register MCP servers drops them; ` +
          `the configuration values themselves are preserved.`,
      });
    }
  }

  const table = { ...(doc.mcp_servers as Record<string, unknown> | undefined) };
  const desired = new Set(servers.map((s) => s.name));

  // Drop entries skillsmith previously managed that are no longer wanted.
  for (const name of managedNames) {
    if (!desired.has(name)) delete table[name];
  }
  for (const server of servers) {
    table[server.name] = toCodexMcpEntry(server.server);
  }

  const next: Record<string, unknown> = { ...doc };
  if (Object.keys(table).length > 0) next.mcp_servers = table;
  else delete next.mcp_servers;

  return {
    content: stringifyToml(next) + (Object.keys(next).length > 0 ? "\n" : ""),
    written: servers.map((s) => s.name),
    warnings,
  };
};

// ---------------------------------------------------------------------------
// Claude — .mcp.json, { "mcpServers": { ... } }
// ---------------------------------------------------------------------------

/**
 * Claude expands `${VAR}` inside `.mcp.json` string values, which is how an
 * env-var *name* becomes a runtime secret without ever touching the file.
 */
export const toClaudeMcpEntry = (server: McpServer): Record<string, unknown> => {
  if (server.transport === "stdio") {
    return {
      type: "stdio",
      command: server.command,
      ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
      ...(server.envVars && server.envVars.length > 0
        ? { env: Object.fromEntries(server.envVars.map((name) => [name, `\${${name}}`])) }
        : {}),
    };
  }
  const headers: Record<string, string> = { ...server.headers };
  if (server.auth?.bearerEnv) headers.Authorization = `Bearer \${${server.auth.bearerEnv}}`;
  return {
    type: "http",
    url: server.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
};

export interface JsonMergeResult {
  content: string;
  written: string[];
}

export const mergeMcpJson = (
  existing: string | undefined,
  servers: readonly ResolvedMcpServer[],
  managedNames: readonly string[],
  configPath: string,
  toEntry: (server: McpServer) => Record<string, unknown>,
): JsonMergeResult => {
  let doc: Record<string, unknown> = {};
  if (existing && existing.trim().length > 0) {
    try {
      doc = JSON.parse(existing) as Record<string, unknown>;
    } catch (error) {
      throw new TargetError(
        `Could not parse ${configPath} as JSON: ${(error as Error).message}. ` +
          `Fix or remove the file before installing MCP servers.`,
        { path: configPath },
      );
    }
  }

  const table = { ...(doc.mcpServers as Record<string, unknown> | undefined) };
  const desired = new Set(servers.map((s) => s.name));
  for (const name of managedNames) {
    if (!desired.has(name)) delete table[name];
  }
  for (const server of servers) {
    table[server.name] = toEntry(server.server);
  }

  const next = { ...doc, mcpServers: table };
  return { content: `${JSON.stringify(next, null, 2)}\n`, written: servers.map((s) => s.name) };
};

/** skillsmith's own normalized shape, for `filesystemTarget` and custom runtimes. */
export const toNormalizedMcpEntry = (server: McpServer): Record<string, unknown> => ({
  ...server,
});

// ---------------------------------------------------------------------------
// Shared IO
// ---------------------------------------------------------------------------

export const readIfExists = async (path: string): Promise<string | undefined> =>
  (await pathExists(path)) ? readTextFile(path) : undefined;

/** Write only when the content actually changed, so mtimes stay meaningful. */
export const writeConfigIfChanged = async (path: string, content: string): Promise<boolean> => {
  const existing = await readIfExists(path);
  if (existing === content) return false;
  await writeFileAtomic(path, content);
  return true;
};
