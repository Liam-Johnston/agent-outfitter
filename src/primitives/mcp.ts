/**
 * MCP server primitives.
 *
 * MCP servers are not copied as files — they are *configured* into each target.
 * Everything here is shape normalization plus the identity/equality logic the
 * resolver needs to dedupe one logical server declared in several places.
 */

import { hashCanonicalJson } from "../hash.js";
import type { McpServer, NamedMcpServer, ResolvedMcpServer } from "../types.js";

/** Strip undefined/empty fields so equal servers hash equal regardless of authoring style. */
export const normalizeMcpServer = (server: McpServer): McpServer => {
  if (server.transport === "stdio") {
    const out: McpServer = { transport: "stdio", command: server.command };
    if (server.args && server.args.length > 0) out.args = [...server.args];
    if (server.envVars && server.envVars.length > 0) out.envVars = [...server.envVars].sort();
    if (server.cwd) out.cwd = server.cwd;
    return out;
  }
  const out: McpServer = { transport: "http", url: server.url };
  if (server.auth?.bearerEnv) out.auth = { bearerEnv: server.auth.bearerEnv };
  if (server.headers && Object.keys(server.headers).length > 0) {
    out.headers = Object.fromEntries(
      Object.entries(server.headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }
  return out;
};

export const mcpConfigHash = (server: McpServer): string =>
  hashCanonicalJson(normalizeMcpServer(server));

export const mcpServersEqual = (a: McpServer, b: McpServer): boolean =>
  mcpConfigHash(a) === mcpConfigHash(b);

export const resolveMcpServer = (
  entry: NamedMcpServer,
  declaredBy: string,
  trusted: boolean,
): ResolvedMcpServer => {
  const { name, ...rest } = entry;
  const server = normalizeMcpServer(rest as McpServer);
  return { name, server, declaredBy, trusted, configHash: mcpConfigHash(server) };
};

/** Host of an HTTP MCP server, for `policy.allowedMcpHosts`. */
export const mcpHost = (server: McpServer): string | undefined => {
  if (server.transport !== "http") return undefined;
  try {
    return new URL(server.url).hostname;
  } catch {
    return undefined;
  }
};

/** Human-readable one-liner, safe to log — env var *names* only, never values. */
export const describeMcpServer = (server: McpServer): string =>
  server.transport === "stdio"
    ? `stdio ${[server.command, ...(server.args ?? [])].join(" ")}`
    : `http ${server.url}`;
