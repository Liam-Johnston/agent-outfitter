/**
 * The in-process SDK handoff.
 *
 * These assertions are about a specific failure mode: an install that reports
 * success while the SDK consuming it loads nothing. So the interesting property
 * is not that `sdkOptions()` returns *a* shape, but that the paths it returns are
 * the same paths the install actually wrote to, and that the settings layer it
 * names is the one covering those paths.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createAgentManager } from "../src/manager.js";
import { claudeTarget, codexTarget } from "../src/targets/index.js";
import { toClaudeSdkMcpEntry, toClaudeSdkMcpServers } from "../src/targets/sdk.js";
import type { NamedMcpServer, OutfitterWarning } from "../src/types.js";
import { cleanupTempDirs, makeTempDir, writeFileAt, writeSkillRepo } from "./helpers.js";

afterAll(cleanupTempDirs);

const workspace = async () => {
  const base = await makeTempDir("agent-outfitter-sdk-");
  const repo = join(base, "repo");
  const root = join(base, "project");
  const cacheDir = join(base, "cache");
  await writeFileAt(root, ".keep", "");
  await writeSkillRepo(repo, { alpha: {}, beta: {} });
  return { base, repo, root, cacheDir };
};

const mcpServers: NamedMcpServer[] = [
  {
    name: "gh",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    auth: { bearerEnv: "TEST_MCP_TOKEN" },
  },
  {
    name: "fs",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    envVars: ["TEST_FS_ROOT"],
  },
];

describe("claudeTarget.sdkOptions", () => {
  test("names the settings source that actually covers the skills directory", async () => {
    const ws = await workspace();
    const target = claudeTarget({ dir: ws.root, consumer: "agent-sdk" });
    const outfitter = createAgentManager({
      root: ws.root,
      cacheDir: ws.cacheDir,
      targets: [target],
      manifest: { version: 1, sources: [{ ref: `local:${ws.repo}` }] },
    });

    const { installed } = await outfitter.install();
    const sdk = target.sdkOptions();

    expect(sdk.settingSources).toEqual(["project"]);
    // The claim under test: the settings layer is anchored where the files went.
    expect(sdk.skillsDir).toBe(join(ws.root, ".claude", "skills"));
    expect(sdk.cwd).toBe(ws.root);
    for (const skill of installed.filter((p) => p.kind === "skill")) {
      expect(skill.path.startsWith(sdk.skillsDir)).toBe(true);
    }
  });

  test("user scope switches the settings source rather than the directory alone", async () => {
    const ws = await workspace();
    const configDir = join(ws.base, "claude-home");
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      const target = claudeTarget({ scope: "user", consumer: "agent-sdk" });
      const outfitter = createAgentManager({
        root: ws.root,
        cacheDir: ws.cacheDir,
        targets: [target],
        manifest: { version: 1, sources: [{ ref: `local:${ws.repo}` }] },
      });
      await outfitter.install();

      const sdk = target.sdkOptions();
      expect(sdk.settingSources).toEqual(["user"]);
      expect(sdk.skillsDir).toBe(join(configDir, "skills"));
      // `cwd` anchors "project", so it is meaningless (and absent) here.
      expect(sdk.cwd).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  test("plugin mode hands back a plugin path instead of a settings source", async () => {
    const ws = await workspace();
    const target = claudeTarget({ dir: ws.root, mode: "plugin", consumer: "agent-sdk" });
    const outfitter = createAgentManager({
      root: ws.root,
      cacheDir: ws.cacheDir,
      targets: [target],
      manifest: { version: 1, sources: [{ ref: `local:${ws.repo}` }] },
    });
    await outfitter.install();

    const sdk = target.sdkOptions();
    // A bundle is loaded by path; naming a settings source would additionally
    // pull in project settings the caller never asked for.
    expect(sdk.settingSources).toEqual([]);
    expect(sdk.plugins).toEqual([
      { type: "local", path: join(ws.root, "agent-outfitter-skills") },
    ]);
  });

  test("resolves MCP env references to values, unlike the on-disk form", async () => {
    const ws = await workspace();
    process.env.TEST_MCP_TOKEN = "secret-token";
    process.env.TEST_FS_ROOT = "/workspace";
    try {
      const target = claudeTarget({ dir: ws.root, consumer: "agent-sdk" });
      const outfitter = createAgentManager({
        root: ws.root,
        cacheDir: ws.cacheDir,
        targets: [target],
        manifest: { version: 1, sources: [{ ref: `local:${ws.repo}` }], mcp: mcpServers },
      });
      await outfitter.install();

      const sdk = target.sdkOptions();
      expect(sdk.mcpServers.gh).toEqual({
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer secret-token" },
      });
      expect(sdk.mcpServers.fs).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        env: { TEST_FS_ROOT: "/workspace" },
      });

      // The file written alongside it still references the variable by name,
      // which is the whole point of keeping the two serializations separate.
      const onDisk = await Bun.file(join(ws.root, ".mcp.json")).text();
      expect(onDisk).toContain("${TEST_MCP_TOKEN}");
      expect(onDisk).not.toContain("secret-token");
    } finally {
      delete process.env.TEST_MCP_TOKEN;
      delete process.env.TEST_FS_ROOT;
    }
  });

  test("warns at install time when a referenced env var is unset", async () => {
    const ws = await workspace();
    delete process.env.TEST_MCP_TOKEN;
    const warnings: OutfitterWarning[] = [];
    const target = claudeTarget({ dir: ws.root, consumer: "agent-sdk" });
    const outfitter = createAgentManager({
      root: ws.root,
      cacheDir: ws.cacheDir,
      targets: [target],
      manifest: { version: 1, sources: [{ ref: `local:${ws.repo}` }], mcp: [mcpServers[0]!] },
      onEvent: (event) => {
        if (event.type === "warning") warnings.push(event.warning);
      },
    });
    await outfitter.install();

    // Reported while a sink is live, rather than surfacing later as an opaque
    // 401 from the server on the agent's first tool call.
    expect(warnings.some((w) => w.message.includes("TEST_MCP_TOKEN"))).toBe(true);
    expect(target.sdkOptions().mcpServers.gh).toEqual({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
    });
  });

  test("is callable before any install, without throwing", async () => {
    const ws = await workspace();
    const target = claudeTarget({ dir: ws.root });
    const sdk = target.sdkOptions();
    expect(sdk.mcpServers).toEqual({});
    expect(sdk.settingSources).toEqual(["project"]);
  });
});

describe("codexTarget.sdkOptions", () => {
  test("returns the CODEX_HOME the install actually used", async () => {
    const ws = await workspace();
    const codexHome = join(ws.base, "codex-home");
    const target = codexTarget({ codexHome, scope: "user" });
    const outfitter = createAgentManager({
      root: ws.root,
      cacheDir: ws.cacheDir,
      targets: [target],
      manifest: { version: 1, sources: [{ ref: `local:${ws.repo}` }], mcp: mcpServers },
    });
    const { installed } = await outfitter.install();

    const sdk = target.sdkOptions();
    expect(sdk.env.CODEX_HOME).toBe(codexHome);
    expect(sdk.skillsDir).toBe(join(codexHome, "skills"));
    expect(sdk.instructionPath).toBe(join(codexHome, "AGENTS.md"));
    for (const skill of installed.filter((p) => p.kind === "skill")) {
      expect(skill.path.startsWith(sdk.skillsDir)).toBe(true);
    }
  });

  test("exposes MCP entries in file mode too, not only sdk-config", async () => {
    const ws = await workspace();
    const codexHome = join(ws.base, "codex-home");
    const target = codexTarget({ codexHome, mcpMode: "file" });
    const outfitter = createAgentManager({
      root: ws.root,
      cacheDir: ws.cacheDir,
      targets: [target],
      manifest: { version: 1, sources: [{ ref: `local:${ws.repo}` }], mcp: mcpServers },
    });
    await outfitter.install();

    const sdk = target.sdkOptions();
    // Codex resolves the bearer env var itself, so the config keeps the *name*.
    expect(sdk.config.mcp_servers.gh).toEqual({
      url: "https://api.githubcopilot.com/mcp/",
      bearer_token_env_var: "TEST_MCP_TOKEN",
    });
    expect(sdk.config.mcp_servers.fs).toMatchObject({ command: "npx" });
  });

  test("hands back a copy, so a later install cannot mutate it", async () => {
    const ws = await workspace();
    const codexHome = join(ws.base, "codex-home");
    const target = codexTarget({ codexHome, mcpMode: "sdk-config" });
    const outfitter = createAgentManager({
      root: ws.root,
      cacheDir: ws.cacheDir,
      targets: [target],
      manifest: { version: 1, sources: [{ ref: `local:${ws.repo}` }], mcp: mcpServers },
    });
    await outfitter.install();

    const first = target.sdkOptions();
    expect(Object.keys(first.config.mcp_servers).sort()).toEqual(["fs", "gh"]);

    // Reinstall with one server dropped; the object already handed out must not
    // change under a caller who passed it to an SDK constructor.
    const outfitter2 = createAgentManager({
      root: ws.root,
      cacheDir: ws.cacheDir,
      targets: [target],
      manifest: { version: 1, sources: [{ ref: `local:${ws.repo}` }], mcp: [mcpServers[1]!] },
    });
    await outfitter2.install();

    expect(Object.keys(first.config.mcp_servers).sort()).toEqual(["fs", "gh"]);
    expect(Object.keys(target.sdkOptions().config.mcp_servers)).toEqual(["fs"]);
  });
});

describe("toClaudeSdkMcpEntry", () => {
  test("reports a missing variable instead of emitting an empty credential", () => {
    const { value, missing } = toClaudeSdkMcpEntry(
      { transport: "http", url: "https://example.test/mcp", auth: { bearerEnv: "NOPE" } },
      {},
    );
    expect(missing).toEqual(["NOPE"]);
    expect(value).toEqual({ type: "http", url: "https://example.test/mcp" });
  });

  test("treats an empty string as missing", () => {
    const { missing } = toClaudeSdkMcpEntry(
      { transport: "stdio", command: "x", envVars: ["BLANK"] },
      { BLANK: "" },
    );
    expect(missing).toEqual(["BLANK"]);
  });

  test("preserves static headers alongside a resolved bearer token", () => {
    const { value } = toClaudeSdkMcpEntry(
      {
        transport: "http",
        url: "https://example.test/mcp",
        headers: { "X-Trace": "on" },
        auth: { bearerEnv: "TOK" },
      },
      { TOK: "abc" },
    );
    expect(value).toEqual({
      type: "http",
      url: "https://example.test/mcp",
      headers: { "X-Trace": "on", Authorization: "Bearer abc" },
    });
  });

  test("collects one warning per server, naming every missing variable", () => {
    const { warnings } = toClaudeSdkMcpServers(
      [
        { name: "a", server: { transport: "stdio", command: "x", envVars: ["P", "Q"] } },
        { name: "b", server: { transport: "stdio", command: "y", envVars: ["R"] } },
      ],
      { R: "set" },
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.subject).toBe("a");
    expect(warnings[0]!.detail?.missing).toEqual(["P", "Q"]);
  });
});
