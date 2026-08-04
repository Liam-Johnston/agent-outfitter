import { describe, expect, test } from "bun:test";
import { parse as parseToml } from "smol-toml";

import { TargetError } from "../src/errors.js";
import { mcpConfigHash, normalizeMcpServer, resolveMcpServer } from "../src/primitives/mcp.js";
import {
  mergeCodexToml,
  mergeMcpJson,
  toClaudeMcpEntry,
  toCodexMcpEntry,
  toNormalizedMcpEntry,
} from "../src/targets/mcp-config.js";
import type { NamedMcpServer } from "../src/types.js";

const githubServer: NamedMcpServer = {
  name: "github",
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  auth: { bearerEnv: "GITHUB_MCP_TOKEN" },
};

const fsServer: NamedMcpServer = {
  name: "filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
  envVars: ["HOME"],
};

const resolved = (entry: NamedMcpServer) => resolveMcpServer(entry, "manifest", true);

describe("normalizeMcpServer", () => {
  test("hashes equal for equivalent declarations", () => {
    expect(mcpConfigHash(normalizeMcpServer({ transport: "stdio", command: "npx", args: [] }))).toBe(
      mcpConfigHash({ transport: "stdio", command: "npx" }),
    );
  });

  test("hashes differ when arguments differ", () => {
    expect(mcpConfigHash({ transport: "stdio", command: "npx", args: ["a"] })).not.toBe(
      mcpConfigHash({ transport: "stdio", command: "npx", args: ["b"] }),
    );
  });

  test("sorts envVars and headers so authoring order is irrelevant", () => {
    const a = normalizeMcpServer({ transport: "stdio", command: "x", envVars: ["B", "A"] });
    const b = normalizeMcpServer({ transport: "stdio", command: "x", envVars: ["A", "B"] });
    expect(mcpConfigHash(a)).toBe(mcpConfigHash(b));
  });
});

describe("Codex config.toml", () => {
  test("maps stdio and http servers to Codex keys", () => {
    expect(toCodexMcpEntry(normalizeMcpServer(fsServer))).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      env_vars: ["HOME"],
    });
    expect(toCodexMcpEntry(normalizeMcpServer(githubServer))).toEqual({
      url: "https://api.githubcopilot.com/mcp/",
      bearer_token_env_var: "GITHUB_MCP_TOKEN",
    });
  });

  test("merges into an existing config without clobbering unrelated settings", () => {
    const existing = [
      'model = "gpt-5"',
      "approval_policy = \"on-request\"",
      "",
      "[mcp_servers.mine]",
      'command = "my-server"',
      "",
    ].join("\n");

    const { content } = mergeCodexToml(existing, [resolved(githubServer)], [], "config.toml");
    const doc = parseToml(content) as Record<string, any>;

    expect(doc.model).toBe("gpt-5");
    expect(doc.approval_policy).toBe("on-request");
    expect(doc.mcp_servers.mine.command).toBe("my-server");
    expect(doc.mcp_servers.github.url).toBe("https://api.githubcopilot.com/mcp/");
  });

  test("removes only previously managed servers that are no longer wanted", () => {
    const existing = [
      "[mcp_servers.mine]",
      'command = "my-server"',
      "",
      "[mcp_servers.stale]",
      'command = "old"',
      "",
    ].join("\n");

    const { content } = mergeCodexToml(existing, [], ["stale"], "config.toml");
    const doc = parseToml(content) as Record<string, any>;
    expect(doc.mcp_servers.stale).toBeUndefined();
    expect(doc.mcp_servers.mine.command).toBe("my-server");
  });

  test("drops the table entirely when nothing is left", () => {
    const { content } = mergeCodexToml("[mcp_servers.stale]\ncommand = \"old\"\n", [], ["stale"], "c");
    expect(parseToml(content)).toEqual({});
  });

  test("warns that comments are lost, but keeps the values", () => {
    const { content, warnings } = mergeCodexToml(
      '# my notes\nmodel = "gpt-5"\n',
      [resolved(fsServer)],
      [],
      "config.toml",
    );
    expect(warnings.map((w) => w.code)).toEqual(["target-config"]);
    expect((parseToml(content) as Record<string, unknown>).model).toBe("gpt-5");
  });

  test("fails loudly on an unparseable config", () => {
    expect(() => mergeCodexToml("this is not = = toml", [], [], "config.toml")).toThrow(TargetError);
  });
});

describe("Claude .mcp.json", () => {
  test("references secrets by env-var expansion, never by value", () => {
    expect(toClaudeMcpEntry(normalizeMcpServer(githubServer))).toEqual({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ${GITHUB_MCP_TOKEN}" },
    });
    expect(toClaudeMcpEntry(normalizeMcpServer(fsServer))).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      env: { HOME: "${HOME}" },
    });
  });

  test("merges under mcpServers and preserves user entries", () => {
    const existing = JSON.stringify({
      mcpServers: { mine: { command: "x" } },
      somethingElse: true,
    });
    const { content, written } = mergeMcpJson(
      existing,
      [resolved(githubServer)],
      [],
      ".mcp.json",
      toClaudeMcpEntry,
    );
    const doc = JSON.parse(content) as Record<string, any>;
    expect(doc.somethingElse).toBe(true);
    expect(doc.mcpServers.mine.command).toBe("x");
    expect(doc.mcpServers.github.type).toBe("http");
    expect(written).toEqual(["github"]);
  });

  test("fails loudly on invalid JSON", () => {
    expect(() => mergeMcpJson("{oops", [], [], ".mcp.json", toClaudeMcpEntry)).toThrow(TargetError);
  });
});

describe("normalized MCP shape", () => {
  test("passes skillsmith's own field names through", () => {
    expect(toNormalizedMcpEntry(normalizeMcpServer(githubServer))).toEqual({
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      auth: { bearerEnv: "GITHUB_MCP_TOKEN" },
    });
  });
});
