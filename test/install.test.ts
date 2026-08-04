/**
 * End-to-end coverage of the install pipeline using `local:` sources, so the
 * whole resolve -> verify -> materialize -> lockfile loop is exercised without
 * touching the network.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CycleError,
  HashMismatchError,
  PolicyViolationError,
  SkillNotFoundError,
  TargetError,
} from "../src/errors.js";
import { createSkillManager } from "../src/manager.js";
import { readLockfile } from "../src/lockfile.js";
import { readTextFile, pathExists } from "../src/fsutil.js";
import { claudeTarget, codexTarget, filesystemTarget } from "../src/targets/index.js";
import type { SkillEvent } from "../src/types.js";
import {
  cleanupTempDirs,
  makeTempDir,
  writeFileAt,
  writeSkill,
  writeSkillRepo,
} from "./helpers.js";

afterAll(cleanupTempDirs);

/** A workspace with a repo of skills, an install root, and a scratch cache. */
const workspace = async () => {
  const base = await makeTempDir();
  const repo = join(base, "repo");
  const root = join(base, "project");
  const cacheDir = join(base, "cache");
  await writeFileAt(root, ".keep", "");
  return { base, repo, root, cacheDir };
};

const managerFor = (
  ws: Awaited<ReturnType<typeof workspace>>,
  extra: Partial<Parameters<typeof createSkillManager>[0]> = {},
) => {
  const events: SkillEvent[] = [];
  const manager = createSkillManager({
    root: ws.root,
    cacheDir: ws.cacheDir,
    targets: [filesystemTarget({ dir: "installed" })],
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { manager, events };
};

describe("install from a local monorepo", () => {
  test("installs selected skills, writes a lockfile, and restores exec bits", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, {
      "csv-insights": {
        description: "Summarize CSVs.",
        files: { "scripts/summarize.py": "#!/usr/bin/env python3\nprint(1)\n" },
      },
      "pdf-extract": { description: "Extract PDFs." },
      "unused-skill": { description: "Not selected." },
    });

    const { manager, events } = managerFor(ws);
    const result = await manager.install({
      refs: [{ source: { type: "local", path: ws.repo }, select: ["csv-insights", "pdf-extract"] }],
    });

    expect(result.installed.map((s) => s.name).sort()).toEqual(["csv-insights", "pdf-extract"]);
    expect(result.dryRun).toBe(false);

    const installedDir = join(ws.root, "installed");
    expect((await readdir(installedDir)).sort()).toEqual(["csv-insights", "pdf-extract"]);
    expect(await readTextFile(join(installedDir, "pdf-extract", "SKILL.md"))).toContain(
      "Extract PDFs.",
    );

    // Tarball extraction loses modes, so the exec bit is re-derived on install.
    const script = await stat(join(installedDir, "csv-insights", "scripts", "summarize.py"));
    expect(script.mode & 0o111).toBeGreaterThan(0);

    const lock = await readLockfile(ws.root);
    expect(Object.keys(lock!.skills).sort()).toEqual(["csv-insights", "pdf-extract"]);
    expect(lock!.skills["csv-insights"]!.contentHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(lock!.skills["csv-insights"]!.files).toEqual(["SKILL.md", "scripts/summarize.py"]);
    expect(lock!.targets.filesystem!.skills["csv-insights"]).toBe(
      join(installedDir, "csv-insights"),
    );

    expect(events.map((e) => e.type)).toContain("skill:materialized");
    expect(events.map((e) => e.type)).toContain("lockfile:written");
  });

  test("installs every skill when no select is given", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {}, b: {}, c: {} });
    const { manager } = managerFor(ws);
    const result = await manager.install({ refs: [`local:${ws.repo}`] });
    expect(result.installed.map((s) => s.name).sort()).toEqual(["a", "b", "c"]);
  });

  test("supports glob selection", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { "csv-a": {}, "csv-b": {}, "pdf-a": {} });
    const { manager } = managerFor(ws);
    const result = await manager.install({
      refs: [{ source: { type: "local", path: ws.repo }, select: "csv-*" }],
    });
    expect(result.installed.map((s) => s.name).sort()).toEqual(["csv-a", "csv-b"]);
  });

  test("treats a folder that is itself a skill as a single skill", async () => {
    const ws = await workspace();
    await writeSkill(ws.repo, ".", { name: "solo", description: "Just me." });
    const { manager } = managerFor(ws);
    const result = await manager.install({ refs: [`local:${ws.repo}`] });
    expect(result.installed.map((s) => s.name)).toEqual(["solo"]);
  });

  test("prefers a conventional skills/ root over a stray top-level skill folder", async () => {
    // The layout of anthropics/skills: skills live under skills/, and the repo
    // root also carries a template folder that is itself a valid skill.
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { pdf: {}, xlsx: {} });
    await writeSkill(ws.repo, "template", { name: "template-skill" });

    const { manager } = managerFor(ws);
    const result = await manager.install({ refs: [`local:${ws.repo}`] });
    expect(result.installed.map((s) => s.name).sort()).toEqual(["pdf", "xlsx"]);
  });

  test("skillsRoot overrides the conventional layout", async () => {
    const ws = await workspace();
    await writeSkill(ws.repo, "custom/one", { name: "one" });
    await writeSkillRepo(ws.repo, { ignored: {} });

    const { manager } = managerFor(ws);
    const result = await manager.install({
      refs: [{ source: { type: "local", path: ws.repo }, skillsRoot: "custom" }],
    });
    expect(result.installed.map((s) => s.name)).toEqual(["one"]);
  });

  test("reports a select that matches nothing, listing what is available", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {}, b: {} });
    const { manager } = managerFor(ws);
    await expect(
      manager.install({ refs: [{ source: { type: "local", path: ws.repo }, select: ["nope"] }] }),
    ).rejects.toThrow(/No skill in .* matches \[nope\].*Available: a, b/s);
  });

  test("reports a source with no skills at all", async () => {
    const ws = await workspace();
    await writeFileAt(ws.repo, "README.md", "nothing here");
    const { manager } = managerFor(ws);
    await expect(manager.install({ refs: [`local:${ws.repo}`] })).rejects.toThrow(
      SkillNotFoundError,
    );
  });

  test("requires at least one target", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const manager = createSkillManager({ root: ws.root, cacheDir: ws.cacheDir });
    await expect(manager.install({ refs: [`local:${ws.repo}`] })).rejects.toThrow(TargetError);
  });
});

describe("idempotence and drift", () => {
  test("skips a second install and re-installs after a change", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: { description: "One." } });
    const { manager } = managerFor(ws);
    const refs = [`local:${ws.repo}`];

    const first = await manager.install({ refs });
    expect(first.installed).toHaveLength(1);
    expect(first.skipped).toHaveLength(0);

    const second = await manager.install({ refs });
    expect(second.installed).toHaveLength(0);
    expect(second.skipped.map((s) => s.name)).toEqual(["a"]);

    await writeSkillRepo(ws.repo, { a: { description: "Two." } });
    const third = await manager.install({ refs });
    expect(third.installed.map((s) => s.name)).toEqual(["a"]);
    expect(await readTextFile(join(ws.root, "installed", "a", "SKILL.md"))).toContain("Two.");
  });

  test("force re-materializes even when the hash matches", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const { manager } = managerFor(ws);
    await manager.install({ refs: [`local:${ws.repo}`] });
    const forced = await manager.install({ refs: [`local:${ws.repo}`], force: true });
    expect(forced.installed.map((s) => s.name)).toEqual(["a"]);
  });

  test("removes a stale file rather than leaving it behind", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: { files: { "extra.md": "old" } } });
    const { manager } = managerFor(ws);
    await manager.install({ refs: [`local:${ws.repo}`] });
    expect(await pathExists(join(ws.root, "installed", "a", "extra.md"))).toBe(true);

    await rm(join(ws.repo, "skills", "a", "extra.md"));
    await manager.install({ refs: [`local:${ws.repo}`] });
    expect(await pathExists(join(ws.root, "installed", "a", "extra.md"))).toBe(false);
  });

  test("dry run plans without writing anything", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const { manager } = managerFor(ws);
    const result = await manager.install({ refs: [`local:${ws.repo}`], dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.installed.map((s) => s.name)).toEqual(["a"]);
    expect(await pathExists(join(ws.root, "installed"))).toBe(false);
    expect(await readLockfile(ws.root)).toBeUndefined();
  });
});

describe("transitive dependencies", () => {
  const repoWithChain = async (repo: string) => {
    await writeSkill(repo, "skills/csv-insights", {
      name: "csv-insights",
      frontmatter: "dependencies:\n  skills:\n    - local:../shared-csv-utils",
    });
    await writeSkill(repo, "skills/shared-csv-utils", {
      name: "shared-csv-utils",
      frontmatter: "dependencies:\n  skills:\n    - local:../base-utils",
    });
    await writeSkill(repo, "skills/base-utils", { name: "base-utils" });
  };

  test("pulls in dependencies and installs them first", async () => {
    const ws = await workspace();
    await repoWithChain(ws.repo);

    const { manager } = managerFor(ws);
    const resolution = await manager.resolve({
      refs: [{ source: { type: "local", path: ws.repo }, select: ["csv-insights"] }],
    });

    expect([...resolution.skills.keys()].sort()).toEqual([
      "base-utils",
      "csv-insights",
      "shared-csv-utils",
    ]);
    expect(resolution.order).toEqual(["base-utils", "shared-csv-utils", "csv-insights"]);
    expect(resolution.skills.get("csv-insights")!.dependsOn).toEqual(["shared-csv-utils"]);
    expect(resolution.skills.get("shared-csv-utils")!.transitive).toBe(true);
    expect(resolution.skills.get("csv-insights")!.transitive).toBe(false);

    const result = await manager.install({ resolution });
    expect(result.installed.map((s) => s.name)).toEqual([
      "base-utils",
      "shared-csv-utils",
      "csv-insights",
    ]);

    const lock = await readLockfile(ws.root);
    expect(lock!.skills["csv-insights"]!.dependencies).toEqual(["shared-csv-utils"]);
    expect(lock!.skills["shared-csv-utils"]!.transitive).toBe(true);
  });

  test("detects a dependency cycle", async () => {
    const ws = await workspace();
    await writeSkill(ws.repo, "skills/a", {
      name: "a",
      frontmatter: "dependencies:\n  skills:\n    - local:../b",
    });
    await writeSkill(ws.repo, "skills/b", {
      name: "b",
      frontmatter: "dependencies:\n  skills:\n    - local:../a",
    });

    const { manager } = managerFor(ws);
    await expect(
      manager.resolve({ refs: [{ source: { type: "local", path: ws.repo }, select: ["a"] }] }),
    ).rejects.toThrow(CycleError);
  });

  test("an only-install still brings its dependencies", async () => {
    const ws = await workspace();
    await repoWithChain(ws.repo);
    const { manager } = managerFor(ws);
    const result = await manager.install({
      refs: [`local:${ws.repo}`],
      only: ["csv-insights"],
    });
    expect(result.installed.map((s) => s.name).sort()).toEqual([
      "base-utils",
      "csv-insights",
      "shared-csv-utils",
    ]);
  });

  test("warns rather than failing when two sources provide the same name", async () => {
    const ws = await workspace();
    const other = join(ws.base, "other");
    await writeSkillRepo(ws.repo, { dup: { description: "First." } });
    await writeSkillRepo(other, { dup: { description: "Second." } });

    const { manager } = managerFor(ws);
    const resolution = await manager.resolve({
      refs: [`local:${ws.repo}`, `local:${other}`],
    });
    expect(resolution.skills.size).toBe(1);
    expect(resolution.warnings.map((w) => w.code)).toContain("duplicate-skill");
  });
});

describe("MCP servers", () => {
  test("writes manifest-declared servers into each target's config", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const codexHome = join(ws.base, "codex-home");

    const { manager } = managerFor(ws, {
      targets: [
        codexTarget({ codexHome, scope: "user" }),
        claudeTarget({ dir: join(ws.base, "claude-project") }),
      ],
    });

    const result = await manager.install({
      refs: [`local:${ws.repo}`],
      mcp: [
        {
          name: "github",
          transport: "http",
          url: "https://api.githubcopilot.com/mcp/",
          auth: { bearerEnv: "GITHUB_MCP_TOKEN" },
        },
      ],
    });

    expect(result.mcp.map((s) => s.name)).toEqual(["github"]);

    const toml = await readTextFile(join(codexHome, "config.toml"));
    expect(toml).toContain("[mcp_servers.github]");
    expect(toml).toContain("bearer_token_env_var");
    expect(toml).not.toContain("GITHUB_MCP_TOKEN =");

    const mcpJson = JSON.parse(
      await readTextFile(join(ws.base, "claude-project", ".mcp.json")),
    ) as Record<string, any>;
    expect(mcpJson.mcpServers.github.headers.Authorization).toBe("Bearer ${GITHUB_MCP_TOKEN}");

    const lock = await readLockfile(ws.root);
    expect(lock!.mcp.github!.declaredBy).toBe("manifest");
    expect(lock!.targets.codex!.mcp).toEqual(["github"]);
    expect(lock!.targets.codex!.mcpConfigPath).toBe(join(codexHome, "config.toml"));
  });

  test("writes no config at all when there are no MCP dependencies", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const codexHome = join(ws.base, "codex-home");
    const { manager } = managerFor(ws, {
      targets: [codexTarget({ codexHome, scope: "user" })],
    });

    await manager.install({ refs: [`local:${ws.repo}`] });

    expect(await pathExists(join(codexHome, "skills", "a", "SKILL.md"))).toBe(true);
    expect(await pathExists(join(codexHome, "config.toml"))).toBe(false);
  });

  test("drops a transitive MCP server by default and explains why", async () => {
    const ws = await workspace();
    await writeSkill(ws.repo, "skills/csv-insights", {
      name: "csv-insights",
      frontmatter: [
        "dependencies:",
        "  mcp:",
        "    - name: csv-mcp",
        "      transport: stdio",
        "      command: npx",
        '      args: ["-y", "@acme/csv-mcp"]',
      ].join("\n"),
    });

    const { manager } = managerFor(ws);
    const dropped = await manager.resolve({ refs: [`local:${ws.repo}`] });
    expect(dropped.mcp.size).toBe(0);
    expect(dropped.warnings.map((w) => w.code)).toContain("transitive-mcp-dropped");

    const allowed = await manager.resolve({
      refs: [`local:${ws.repo}`],
      policy: { allowTransitiveMcp: true },
    });
    expect([...allowed.mcp.keys()]).toEqual(["csv-mcp"]);
    expect(allowed.mcp.get("csv-mcp")!.declaredBy).toBe("csv-insights");
  });

  test("admits a transitive server that matches an allowlist", async () => {
    const ws = await workspace();
    await writeSkill(ws.repo, "skills/x", {
      name: "x",
      frontmatter: [
        "dependencies:",
        "  mcp:",
        "    - name: gh",
        "      transport: http",
        "      url: https://api.githubcopilot.com/mcp/",
      ].join("\n"),
    });
    const { manager } = managerFor(ws, {
      policy: { allowedMcpHosts: ["api.githubcopilot.com"] },
    });
    const resolution = await manager.resolve({ refs: [`local:${ws.repo}`] });
    expect([...resolution.mcp.keys()]).toEqual(["gh"]);
  });

  test("removing a config entry leaves unmanaged entries alone", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const dir = join(ws.root, "installed");
    const { manager } = managerFor(ws);

    await manager.install({
      refs: [`local:${ws.repo}`],
      mcp: [{ name: "managed", transport: "stdio", command: "x" }],
    });

    // Simulate a server the user added by hand.
    const configPath = join(dir, "mcp.json");
    const doc = JSON.parse(await readTextFile(configPath)) as Record<string, any>;
    doc.mcpServers.byHand = { transport: "stdio", command: "theirs" };
    await writeFile(configPath, JSON.stringify(doc, null, 2));

    await manager.install({ refs: [`local:${ws.repo}`] });

    const after = JSON.parse(await readTextFile(configPath)) as Record<string, any>;
    expect(after.mcpServers.managed).toBeUndefined();
    expect(after.mcpServers.byHand.command).toBe("theirs");
  });
});

describe("policy", () => {
  test("blocks a source whose host is not allowlisted", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, { policy: { allowedHosts: ["github.com"] } });
    await expect(
      manager.resolve({ refs: ["git:https://evil.example.com/a/b.git"] }),
    ).rejects.toThrow(PolicyViolationError);
  });

  test("blocks a source whose owner is not allowlisted", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, { policy: { allowedOwners: ["acme"] } });
    await expect(manager.resolve({ refs: ["github:someone-else/skills"] })).rejects.toThrow(
      /allowedOwners/,
    );
  });

  test("host allowlists do not block local sources", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const { manager } = managerFor(ws, { policy: { allowedHosts: ["github.com"] } });
    const resolution = await manager.resolve({ refs: [`local:${ws.repo}`] });
    expect(resolution.skills.size).toBe(1);
  });

  test("allowLocalSources: false blocks them", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const { manager } = managerFor(ws, { policy: { allowLocalSources: false } });
    await expect(manager.resolve({ refs: [`local:${ws.repo}`] })).rejects.toThrow(
      PolicyViolationError,
    );
  });

});

describe("sync", () => {
  test("reinstalls deterministically from the lockfile", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: { description: "Locked." }, b: {} });
    const { manager } = managerFor(ws);
    await manager.install({ refs: [`local:${ws.repo}`] });

    await rm(join(ws.root, "installed"), { recursive: true, force: true });

    const synced = await manager.sync();
    expect(synced.installed.map((s) => s.name).sort()).toEqual(["a", "b"]);
    expect(await readTextFile(join(ws.root, "installed", "a", "SKILL.md"))).toContain("Locked.");
  });

  test("fails on drift between the source and the lockfile", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: { description: "Original." } });
    const { manager } = managerFor(ws);
    await manager.install({ refs: [`local:${ws.repo}`] });

    await writeSkillRepo(ws.repo, { a: { description: "Tampered." } });
    await expect(manager.sync()).rejects.toThrow(HashMismatchError);
  });

  test("tolerates drift when the policy allows it", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: { description: "Original." } });
    const { manager } = managerFor(ws, { policy: { requireLockHashMatch: false } });
    await manager.install({ refs: [`local:${ws.repo}`] });
    await writeSkillRepo(ws.repo, { a: { description: "Changed." } });
    const synced = await manager.sync();
    expect(synced.installed.map((s) => s.name)).toEqual(["a"]);
  });

  test("requires a lockfile", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws);
    await expect(manager.sync()).rejects.toThrow(/No .*skills.lock.json/);
  });

  test("preserves dependency order", async () => {
    const ws = await workspace();
    await writeSkill(ws.repo, "skills/top", {
      name: "top",
      frontmatter: "dependencies:\n  skills:\n    - local:../bottom",
    });
    await writeSkill(ws.repo, "skills/bottom", { name: "bottom" });

    const { manager } = managerFor(ws);
    await manager.install({ refs: [{ source: { type: "local", path: ws.repo }, select: ["top"] }] });
    await rm(join(ws.root, "installed"), { recursive: true, force: true });

    const synced = await manager.sync();
    expect(synced.installed.map((s) => s.name)).toEqual(["bottom", "top"]);
  });
});

describe("list and verify", () => {
  test("lists what is installed and detects in-place edits", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {}, b: {} });
    const { manager } = managerFor(ws);
    await manager.install({ refs: [`local:${ws.repo}`] });

    const listed = await manager.list();
    expect(listed.map((s) => s.name)).toEqual(["a", "b"]);
    expect(listed[0]!.target).toBe("filesystem");
    expect(listed[0]!.contentHash).toMatch(/^sha256-/);

    expect((await manager.verify()).ok).toBe(true);

    await writeFile(join(ws.root, "installed", "a", "SKILL.md"), "edited in place\n");
    const report = await manager.verify();
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === "hash-mismatch" && i.name === "a")).toBe(true);
  });

  test("reports a skill deleted from the target", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const { manager } = managerFor(ws);
    await manager.install({ refs: [`local:${ws.repo}`] });

    await rm(join(ws.root, "installed", "a"), { recursive: true });
    expect(await manager.list()).toEqual([]);
    expect((await manager.list({ includeMissing: true })).map((s) => s.name)).toEqual(["a"]);

    const report = await manager.verify();
    expect(report.issues.some((i) => i.kind === "missing")).toBe(true);
  });

  test("flags an added file as extraneous", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const { manager } = managerFor(ws);
    await manager.install({ refs: [`local:${ws.repo}`] });
    await writeFile(join(ws.root, "installed", "a", "snuck-in.md"), "surprise\n");

    const report = await manager.verify();
    expect(report.issues.some((i) => i.kind === "extraneous")).toBe(true);
  });

  test("bundled scripts are informational under warn, an issue under deny", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: { files: { "scripts/go.sh": "#!/bin/sh\n" } } });

    const warn = managerFor(ws, { policy: { scripts: "warn" } }).manager;
    await warn.install({ refs: [`local:${ws.repo}`] });
    expect((await warn.verify()).ok).toBe(true);

    const deny = managerFor(ws, { policy: { scripts: "deny" } }).manager;
    const report = await deny.verify();
    expect(report.issues.some((i) => i.kind === "scripts")).toBe(true);
  });

  test("reports hidden Unicode in installed files without throwing", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const { manager } = managerFor(ws, { policy: { scan: "deny" } });
    await manager.install({ refs: [`local:${ws.repo}`] });
    await writeFile(join(ws.root, "installed", "a", "notes.md"), "sneaky‮reversed\n");

    const report = await manager.verify();
    expect(report.issues.some((i) => i.kind === "hidden-unicode")).toBe(true);
  });

  test("returns nothing before the first install", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws);
    expect(await manager.list()).toEqual([]);
    expect((await manager.verify()).ok).toBe(false);
  });
});

describe("remove", () => {
  test("deletes files, lockfile entries, and the manifest selection", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {}, b: {} });
    await writeFileAt(
      ws.root,
      "skills.config.yaml",
      `version: 1\nsources:\n  - ref: local:${ws.repo}\n    select: [a, b]\n`,
    );

    const { manager } = managerFor(ws);
    await manager.install();
    expect(await pathExists(join(ws.root, "installed", "a"))).toBe(true);

    await manager.remove("a");

    expect(await pathExists(join(ws.root, "installed", "a"))).toBe(false);
    expect(await pathExists(join(ws.root, "installed", "b"))).toBe(true);

    const lock = await readLockfile(ws.root);
    expect(Object.keys(lock!.skills)).toEqual(["b"]);
    expect(lock!.targets.filesystem!.skills.a).toBeUndefined();

    const manifest = await readTextFile(join(ws.root, "skills.config.yaml"));
    expect(manifest).not.toContain("- a");
    expect(manifest).toContain("- b");
  });

  test("removes MCP servers only this skill pulled in", async () => {
    const ws = await workspace();
    await writeSkill(ws.repo, "skills/a", {
      name: "a",
      frontmatter: [
        "dependencies:",
        "  mcp:",
        "    - name: only-mine",
        "      transport: stdio",
        "      command: x",
      ].join("\n"),
    });

    const { manager } = managerFor(ws, { policy: { allowTransitiveMcp: true } });
    await manager.install({
      refs: [`local:${ws.repo}`],
      mcp: [{ name: "from-manifest", transport: "stdio", command: "y" }],
    });

    const configPath = join(ws.root, "installed", "mcp.json");
    let doc = JSON.parse(await readTextFile(configPath)) as Record<string, any>;
    expect(Object.keys(doc.mcpServers).sort()).toEqual(["from-manifest", "only-mine"]);

    await manager.remove("a");

    doc = JSON.parse(await readTextFile(configPath)) as Record<string, any>;
    expect(doc.mcpServers["only-mine"]).toBeUndefined();
    expect(doc.mcpServers["from-manifest"]).toBeDefined();
  });

  test("warns when the manifest cannot express the removal", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {}, b: {} });
    await writeFileAt(ws.root, "skills.config.yaml", `version: 1\nsources:\n  - local:${ws.repo}\n`);

    const { manager, events } = managerFor(ws);
    await manager.install();
    await manager.remove("a");

    const warnings = events.filter((e) => e.type === "warning");
    expect(warnings.some((w) => w.type === "warning" && /No manifest source names/.test(w.warning.message))).toBe(
      true,
    );
  });
});

describe("add", () => {
  test("records the ref in the manifest and installs just it", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {}, b: {} });
    await writeFileAt(ws.root, "skills.config.yaml", "version: 1\nsources: []\n");

    const { manager } = managerFor(ws);
    const result = await manager.add(`local:${ws.repo}`, { select: "a" });

    expect(result.installed.map((s) => s.name)).toEqual(["a"]);
    const manifest = await readTextFile(join(ws.root, "skills.config.yaml"));
    expect(manifest).toContain(`ref: local:${ws.repo}`);
    expect(manifest).toContain("- a");
    expect(await pathExists(join(ws.root, "installed", "b"))).toBe(false);
  });

  test("installs without saving when there is no writable manifest", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const { manager } = managerFor(ws);
    const result = await manager.add(`local:${ws.repo}`, { save: false });
    expect(result.installed.map((s) => s.name)).toEqual(["a"]);
  });

  test("preserves unrelated lockfile entries", async () => {
    const ws = await workspace();
    const other = join(ws.base, "other");
    await writeSkillRepo(ws.repo, { a: {} });
    await writeSkillRepo(other, { z: {} });

    const { manager } = managerFor(ws);
    await manager.install({ refs: [`local:${ws.repo}`] });
    await manager.add(`local:${other}`, { save: false });

    const lock = await readLockfile(ws.root);
    expect(Object.keys(lock!.skills).sort()).toEqual(["a", "z"]);
  });
});

describe("orphans", () => {
  test("warns by default and deletes with prune", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {}, b: {} });
    const { manager, events } = managerFor(ws);
    await manager.install({ refs: [`local:${ws.repo}`] });

    const narrowed = { source: { type: "local" as const, path: ws.repo }, select: ["a"] };

    const warned = await manager.install({ refs: [narrowed] });
    expect(warned.warnings.some((w) => /no longer resolved/.test(w.message))).toBe(true);
    expect(await pathExists(join(ws.root, "installed", "b"))).toBe(true);

    await manager.install({ refs: [narrowed], prune: true });
    expect(await pathExists(join(ws.root, "installed", "b"))).toBe(false);
    expect(events.some((e) => e.type === "skill:removed")).toBe(true);

    const lock = await readLockfile(ws.root);
    expect(Object.keys(lock!.skills)).toEqual(["a"]);
  });
});

describe("multiple targets", () => {
  test("each target gets its own installed entry and lockfile record", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const codexHome = join(ws.base, "codex-home");
    const claudeDir = join(ws.base, "claude");

    const { manager } = managerFor(ws, {
      targets: [codexTarget({ codexHome, scope: "user" }), claudeTarget({ dir: claudeDir })],
    });
    const result = await manager.install({ refs: [`local:${ws.repo}`] });

    expect(result.installed.map((s) => s.target).sort()).toEqual(["claude", "codex"]);
    expect(await pathExists(join(codexHome, "skills", "a", "SKILL.md"))).toBe(true);
    expect(await pathExists(join(claudeDir, ".claude", "skills", "a", "SKILL.md"))).toBe(true);

    const lock = await readLockfile(ws.root);
    expect(Object.keys(lock!.targets).sort()).toEqual(["claude", "codex"]);
  });

  test("rejects two targets with the same name", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, {
      targets: [filesystemTarget({ dir: "one" }), filesystemTarget({ dir: "two" })],
    });
    await expect(manager.install({ refs: [] })).rejects.toThrow(/share the name/);
  });

  test("codex project scope writes to .agents/skills", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const { manager } = managerFor(ws, { targets: [codexTarget({ scope: "project" })] });
    await manager.install({ refs: [`local:${ws.repo}`] });
    expect(await pathExists(join(ws.root, ".agents", "skills", "a", "SKILL.md"))).toBe(true);
  });

  test("claude plugin mode writes a plugin manifest", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const { manager } = managerFor(ws, {
      targets: [claudeTarget({ dir: ws.root, mode: "plugin", pluginName: "my-plugin" })],
    });
    await manager.install({ refs: [`local:${ws.repo}`] });

    expect(await pathExists(join(ws.root, "my-plugin", "skills", "a", "SKILL.md"))).toBe(true);
    const manifest = JSON.parse(
      await readTextFile(join(ws.root, "my-plugin", ".claude-plugin", "plugin.json")),
    ) as { name: string };
    expect(manifest.name).toBe("my-plugin");
  });

  test("the agent-sdk consumer warns about settingSources", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    const { manager } = managerFor(ws, {
      targets: [claudeTarget({ dir: ws.root, consumer: "agent-sdk" })],
    });
    const result = await manager.install({ refs: [`local:${ws.repo}`] });
    expect(result.warnings.some((w) => /settingSources/.test(w.message))).toBe(true);
  });
});

describe("manifest-driven install", () => {
  test("resolves sources, MCP, and policy from skills.config.yaml", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: { files: { "scripts/x.sh": "#!/bin/sh\n" } }, b: {} });
    await writeFileAt(
      ws.root,
      "skills.config.yaml",
      [
        "version: 1",
        "sources:",
        `  - ref: local:${ws.repo}`,
        "    select: [a]",
        "mcp:",
        "  - name: fs",
        "    command: npx",
        '    args: ["-y", "server"]',
        "policy:",
        "  scripts: deny",
        "",
      ].join("\n"),
    );

    const { manager } = managerFor(ws);
    // policy.scripts: deny comes from the manifest and must be enforced.
    await expect(manager.install()).rejects.toThrow(PolicyViolationError);

    const relaxed = managerFor(ws, { policy: { scripts: "warn" } }).manager;
    const result = await relaxed.install();
    expect(result.installed.map((s) => s.name)).toEqual(["a"]);
    expect(result.mcp.map((s) => s.name)).toEqual(["fs"]);
    expect(result.warnings.some((w) => w.code === "scripts-present")).toBe(true);
  });

  test("ignoreManifest resolves only the inline refs", async () => {
    const ws = await workspace();
    const other = join(ws.base, "other");
    await writeSkillRepo(ws.repo, { fromManifest: {} });
    await writeSkillRepo(other, { fromRef: {} });
    await writeFileAt(ws.root, "skills.config.yaml", `version: 1\nsources:\n  - local:${ws.repo}\n`);

    const { manager } = managerFor(ws);
    const both = await manager.resolve({ refs: [`local:${other}`] });
    expect([...both.skills.keys()].sort()).toEqual(["fromManifest", "fromRef"]);

    const only = await manager.resolve({ refs: [`local:${other}`], ignoreManifest: true });
    expect([...only.skills.keys()]).toEqual(["fromRef"]);
  });

  test("named targets in the manifest resolve to built-in adapters", async () => {
    const ws = await workspace();
    await writeSkillRepo(ws.repo, { a: {} });
    await writeFileAt(
      ws.root,
      "skills.config.yaml",
      `version: 1\ntargets: [codex:project]\nsources:\n  - local:${ws.repo}\n`,
    );
    const manager = createSkillManager({ root: ws.root, cacheDir: ws.cacheDir });
    await manager.install();
    expect(await pathExists(join(ws.root, ".agents", "skills", "a", "SKILL.md"))).toBe(true);
  });

  test("an unknown target name is reported with the available list", async () => {
    const ws = await workspace();
    await writeFileAt(ws.root, "skills.config.yaml", "version: 1\ntargets: [nonesuch]\n");
    const manager = createSkillManager({ root: ws.root, cacheDir: ws.cacheDir });
    await expect(manager.install()).rejects.toThrow(/Unknown target "nonesuch"/);
  });
});
