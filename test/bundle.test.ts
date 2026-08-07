/**
 * The `bundle` and `settings` kinds, end to end against a fixture repository
 * shaped like a committed-harness framework.
 *
 * Local `file:` sources throughout, so the whole resolve -> gate -> materialize ->
 * lockfile -> verify -> remove loop runs without a network.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { HashMismatchError, PolicyViolationError, SourceResolutionError } from "../src/errors.js";
import { readLockfile } from "../src/lockfile.js";
import { isDirectory, pathExists, readTextFile } from "../src/fsutil.js";
import { createAgentManager } from "../src/manager.js";
import { normalizeBundlePath, stageBundle } from "../src/primitives/bundle.js";
import { hookKey, unionOwnedSettings } from "../src/primitives/settings.js";
import { claudeTarget, filesystemTarget } from "../src/targets/index.js";
import { executableFiles, summarizeHarness } from "../src/verify.js";
import type { Manifest, OutfitterEvent } from "../src/types.js";
import {
  cleanupTempDirs,
  HARNESS_BUNDLE_PATHS,
  HARNESS_REGISTRATIONS,
  makeTempDir,
  writeFileAt,
  writeHarnessRepo,
} from "./helpers.js";

afterAll(cleanupTempDirs);

const workspace = async () => {
  const base = await makeTempDir();
  const repo = join(base, "harness-repo");
  const root = join(base, "project");
  const cacheDir = join(base, "cache");
  await writeFileAt(root, ".keep", "");
  await writeHarnessRepo(repo);
  return { base, repo, root, cacheDir };
};

/** The manifest a consumer would write to install the fixture harness whole. */
const harnessManifest = (repo: string, overrides: Partial<Manifest> = {}): Manifest => ({
  version: 1,
  sources: [{ ref: `local:${repo}`, skillsRoot: "skills" }],
  bundles: [{ ref: `local:${repo}`, name: "aidlc-engine", paths: { ...HARNESS_BUNDLE_PATHS } }],
  settings: [{ ref: `local:${repo}/.claude/settings.json`, name: "aidlc" }],
  instructions: [{ ref: `local:${repo}/rules/aidlc.md` }],
  policy: { executableHarness: "warn" },
  ...overrides,
});

const managerFor = (
  ws: Awaited<ReturnType<typeof workspace>>,
  manifest: Manifest,
  extra: Partial<Parameters<typeof createAgentManager>[0]> = {},
) => {
  const events: OutfitterEvent[] = [];
  const manager = createAgentManager({
    root: ws.root,
    cacheDir: ws.cacheDir,
    manifest,
    targets: [claudeTarget()],
    onEvent: (event) => events.push(event),
    ...extra,
  });
  return { manager, events };
};

const settingsFile = (root: string): string => join(root, ".claude", "settings.json");

const readSettings = async (root: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readTextFile(settingsFile(root))) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// Unit behaviour
// ---------------------------------------------------------------------------

describe("bundle paths", () => {
  test("normalizes the spellings that mean the tree root", () => {
    expect(normalizeBundlePath(".")).toBe("");
    expect(normalizeBundlePath("./")).toBe("");
    expect(normalizeBundlePath("./tools/")).toBe("tools");
    expect(normalizeBundlePath(".claude/tools")).toBe(".claude/tools");
  });

  test("refuses a declared path that is not a directory in the source", async () => {
    const ws = await workspace();
    await expect(
      stageBundle(ws.repo, { ".claude/nope": ".claude/nope" }, "local:repo"),
    ).rejects.toThrow(/not a directory in the source/);
  });

  test("hashes each declared subtree separately as well as together", async () => {
    const ws = await workspace();
    const staged = await stageBundle(ws.repo, { ...HARNESS_BUNDLE_PATHS }, "local:repo");

    expect(Object.keys(staged.pathHashes).sort()).toEqual(
      Object.keys(HARNESS_BUNDLE_PATHS).sort(),
    );
    expect(staged.contentHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    // Files are recorded under their source path, so the two views agree.
    expect(staged.files).toContain(".claude/tools/aidlc-orchestrate.ts");
    expect(staged.files).toContain("aidlc/spaces/default/README.md");
  });
});

describe("the executable-harness trust gate", () => {
  test("executableFiles catches engine code the scripts/ convention misses", () => {
    const files = [
      ".claude/tools/aidlc-orchestrate.ts",
      ".claude/hooks/guard-bash.ts",
      ".claude/knowledge/patterns.md",
      ".claude/tools/data/stages.json",
      "scripts/legacy.sh",
    ];
    expect(executableFiles(files)).toEqual([
      ".claude/tools/aidlc-orchestrate.ts",
      ".claude/hooks/guard-bash.ts",
      "scripts/legacy.sh",
    ]);
  });

  test("a data-only bundle is not an executable harness", () => {
    const summary = summarizeHarness(
      [
        {
          name: "knowledge",
          source: { type: "local", path: "/x" },
          ref: "",
          commit: "",
          subdir: "",
          contentHash: "sha256-x",
          pathHashes: {},
          stagedDir: "/x",
          files: ["knowledge/a.md", "knowledge/b.json"],
          paths: { knowledge: "knowledge" },
          declaredBy: "manifest",
          trusted: true,
        },
      ],
      [],
    );
    expect(summary.executable).toBe(false);
  });

  test("defaults to deny, and says what it would have registered", async () => {
    const ws = await workspace();
    // No policy at all: the default has to be the thing that refuses.
    const { manager } = managerFor(ws, harnessManifest(ws.repo, { policy: {} }));

    const error = await manager.install().then(
      () => undefined,
      (e: unknown) => e as PolicyViolationError,
    );

    expect(error).toBeInstanceOf(PolicyViolationError);
    expect(error!.message).toContain("executable agent harness");
    expect(error!.message).toContain("13 hook registration(s) across 9 event(s)");
    expect(error!.message).toContain("a statusLine command");
    expect(error!.message).toContain("4 permissions.allow entries");
    expect(error!.detail.hooks).toBe(13);
    expect((error!.detail.events as string[]).length).toBe(9);

    // Nothing was written: the gate runs before any target is touched.
    expect(await pathExists(join(ws.root, ".claude", "tools"))).toBe(false);
    expect(await pathExists(settingsFile(ws.root))).toBe(false);
  });

  test("warns, and installs, when opted into", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    const result = await manager.install();

    const warning = result.warnings.find((w) => w.code === "executable-harness");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("hooks fire without being invoked");
  });

  test("stays silent when allowed", async () => {
    const ws = await workspace();
    const { manager } = managerFor(
      ws,
      harnessManifest(ws.repo, { policy: { executableHarness: "allow" } }),
    );
    const result = await manager.install();
    expect(result.warnings.filter((w) => w.code === "executable-harness")).toEqual([]);
  });
});

describe("manifest validation", () => {
  const badPaths = async (paths: Record<string, string>) => {
    const ws = await workspace();
    const { manager } = managerFor(ws, {
      version: 1,
      bundles: [{ ref: `local:${ws.repo}`, name: "b", paths }],
    });
    return manager.resolve();
  };

  test("rejects a destination that escapes the root", async () => {
    await expect(badPaths({ ".claude/tools": "../evil" })).rejects.toThrow(/".." segment/);
    await expect(badPaths({ ".claude/tools": "a/../../evil" })).rejects.toThrow(/".." segment/);
  });

  test("rejects an absolute destination", async () => {
    await expect(badPaths({ ".claude/tools": "/etc" })).rejects.toThrow(/not absolute/);
  });

  test("rejects a destination that starts with a tilde", async () => {
    await expect(badPaths({ ".claude/tools": "~/.ssh" })).rejects.toThrow(/"~"/);
  });

  test("rejects two bundles claiming one destination", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, {
      version: 1,
      policy: { executableHarness: "allow" },
      bundles: [
        { ref: `local:${ws.repo}`, name: "one", paths: { ".claude/tools": "engine" } },
        { ref: `local:${ws.repo}`, name: "two", paths: { ".claude/hooks": "engine" } },
      ],
    });
    await expect(manager.install()).rejects.toThrow(SourceResolutionError);
    await expect(manager.install()).rejects.toThrow(/both install to "engine"/);
  });
});

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

describe("installing a committed harness", () => {
  test("lands every declared path, restores exec bits, and pins the tree", async () => {
    const ws = await workspace();
    const { manager, events } = managerFor(ws, harnessManifest(ws.repo));
    const result = await manager.install();

    for (const dest of Object.values(HARNESS_BUNDLE_PATHS)) {
      expect(await isDirectory(join(ws.root, dest))).toBe(true);
    }
    expect(await readTextFile(join(ws.root, ".claude/tools/aidlc-orchestrate.ts"))).toContain(
      "orchestrate",
    );
    expect(await readTextFile(join(ws.root, ".claude/tools/data/stages.json"))).toContain("stages");
    expect(await readTextFile(join(ws.root, "aidlc/spaces/default/README.md"))).toContain(
      "Default space",
    );

    // A shebang means the file is meant to be run, whatever the tarball said.
    const orchestrator = await stat(join(ws.root, ".claude/tools/aidlc-orchestrate.ts"));
    expect(orchestrator.mode & 0o111).toBeGreaterThan(0);

    const bundle = result.installed.find((p) => p.kind === "bundle");
    expect(bundle!.name).toBe("aidlc-engine");
    expect(bundle!.paths![".claude/tools"]).toBe(join(ws.root, ".claude/tools"));

    const lock = await readLockfile(ws.root);
    const locked = lock!.bundles["aidlc-engine"]!;
    expect(locked.contentHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(Object.keys(locked.pathHashes).sort()).toEqual(Object.keys(HARNESS_BUNDLE_PATHS).sort());
    expect(locked.paths).toEqual({ ...HARNESS_BUNDLE_PATHS });
    expect(lock!.targets.claude!.bundles["aidlc-engine"]![".claude/tools"]).toBe(
      join(ws.root, ".claude/tools"),
    );

    expect(events.map((e) => e.type)).toContain("bundle:materialized");
    expect(events.map((e) => e.type)).toContain("settings:written");
  });

  test("installs the engine before the skills that shell into it", async () => {
    const ws = await workspace();
    const { manager, events } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();

    const bundleAt = events.findIndex((e) => e.type === "bundle:materialized");
    const skillAt = events.findIndex((e) => e.type === "skill:materialized");
    const settingsAt = events.findIndex((e) => e.type === "settings:written");

    expect(bundleAt).toBeGreaterThanOrEqual(0);
    expect(bundleAt).toBeLessThan(skillAt);
    // Settings name the engine's files, so they are registered last.
    expect(settingsAt).toBeGreaterThan(skillAt);
  });

  test("registers all 13 hooks across 9 events, plus the other regions", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();

    const settings = await readSettings(ws.root);
    const hooks = settings.hooks as Record<
      string,
      { matcher?: string; hooks: { command: string }[] }[]
    >;

    expect(Object.keys(hooks).length).toBe(9);
    expect((hooks.PostToolUse ?? []).length).toBe(4);

    for (const [event, matcher, command] of HARNESS_REGISTRATIONS) {
      const group = hooks[event]!.find((g) => (g.matcher ?? "") === matcher);
      expect(group, `${event} ${matcher}`).toBeDefined();
      expect(group!.hooks.map((h) => h.command)).toContain(command);
    }

    expect(settings.model).toBe("opus");
    expect(settings.env).toEqual({ AIDLC_HOME: ".aidlc", AIDLC_STRICT: "1" });
    expect((settings.permissions as { allow: string[] }).allow.length).toBe(4);
    expect(settings.statusLine).toEqual({
      type: "command",
      command: "bun .claude/tools/aidlc-status.ts",
    });

    const lock = await readLockfile(ws.root);
    const owned = lock!.targets.claude!.settings.aidlc!;
    expect(owned.hooks.length).toBe(13);
    expect(owned.hooks).toContain(hookKey("PostToolUse", "Write|Edit", "bun .claude/hooks/aidlc-runtime-compile.ts"));
    expect(owned.env).toEqual(["AIDLC_HOME", "AIDLC_STRICT"]);
    expect(owned.scalars.sort()).toEqual(["companyAnnouncements", "model", "statusLine"]);
    expect(lock!.targets.claude!.settingsPath).toBe(settingsFile(ws.root));
  });

  test("writes settings to .claude/settings.json, not the project root", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();

    expect(await pathExists(settingsFile(ws.root))).toBe(true);
    expect(await pathExists(join(ws.root, "settings.json"))).toBe(false);
    // CLAUDE.md and .mcp.json stay at the root; settings.json does not.
    expect(await pathExists(join(ws.root, "CLAUDE.md"))).toBe(true);
  });

  test("a second install skips the unchanged bundle instead of rewriting it", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();

    const before = await stat(join(ws.root, ".claude/tools/aidlc-orchestrate.ts"));
    const second = await manager.install();
    const after = await stat(join(ws.root, ".claude/tools/aidlc-orchestrate.ts"));

    expect(second.installed.filter((p) => p.kind === "bundle")).toEqual([]);
    expect(second.skipped.filter((p) => p.kind === "bundle").length).toBe(1);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("dryRun writes nothing at all", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    const result = await manager.install({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.installed.some((p) => p.kind === "bundle")).toBe(true);
    expect(result.installed.some((p) => p.kind === "settings")).toBe(true);

    for (const dest of Object.values(HARNESS_BUNDLE_PATHS)) {
      expect(await pathExists(join(ws.root, dest))).toBe(false);
    }
    expect(await pathExists(settingsFile(ws.root))).toBe(false);
    expect(await pathExists(join(ws.root, "outfitter.lock.json"))).toBe(false);
    // The reported destinations are still the real ones.
    const bundle = result.installed.find((p) => p.kind === "bundle");
    expect(bundle!.paths!.aidlc).toBe(join(ws.root, "aidlc"));
  });

  test("an inline settings fragment merges beside a fetched one", async () => {
    const ws = await workspace();
    const { manager } = managerFor(
      ws,
      harnessManifest(ws.repo, {
        settings: [
          { ref: `local:${ws.repo}/.claude/settings.json`, name: "aidlc" },
          { name: "local-overrides", settings: { env: { CI: "1" } } },
        ],
        policy: { executableHarness: "warn" },
      }),
    );
    await manager.install();

    const settings = await readSettings(ws.root);
    expect(settings.env).toEqual({ AIDLC_HOME: ".aidlc", AIDLC_STRICT: "1", CI: "1" });

    const lock = await readLockfile(ws.root);
    // Nothing to re-fetch, so the fragment travels in the lockfile itself.
    expect(lock!.settings["local-overrides"]!.inline).toBe(true);
    expect(lock!.settings["local-overrides"]!.content).toBe('{"env":{"CI":"1"}}');
  });

  test("a target that cannot merge settings says so rather than dropping them", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo), {
      targets: [filesystemTarget({ dir: "installed" })],
    });
    const result = await manager.install();

    const warning = result.warnings.find(
      (w) => w.code === "target-config" && w.message.includes("cannot merge settings"),
    );
    expect(warning).toBeDefined();
    // The bundle is still installed: only settings are Claude-specific.
    expect(await isDirectory(join(ws.root, "installed", ".claude/tools"))).toBe(true);
  });

  test("plugin mode refuses bundles and settings instead of writing them nowhere", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo), {
      targets: [claudeTarget({ mode: "plugin" })],
    });
    const result = await manager.install();

    const messages = result.warnings.map((w) => w.message).join("\n");
    expect(messages).toContain("plugin mode");
    expect(await pathExists(join(ws.root, ".claude/tools"))).toBe(false);
    expect(await pathExists(settingsFile(ws.root))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reproduce, verify, remove
// ---------------------------------------------------------------------------

describe("sync, verify, and remove", () => {
  test("sync reproduces the install byte for byte in a fresh root", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();
    const lockBytes = await readTextFile(join(ws.root, "outfitter.lock.json"));
    const settingsBytes = await readTextFile(settingsFile(ws.root));

    // A second clone: same lockfile, empty tree, no manifest consulted.
    const clone = join(ws.base, "clone");
    await writeFileAt(clone, "outfitter.lock.json", lockBytes);
    const { manager: cloned } = managerFor(
      { ...ws, root: clone },
      harnessManifest(ws.repo),
      { root: clone },
    );
    await cloned.sync();

    expect(await readTextFile(join(clone, ".claude/settings.json"))).toBe(settingsBytes);
    expect(await readTextFile(join(clone, ".claude/tools/aidlc-orchestrate.ts"))).toBe(
      await readTextFile(join(ws.root, ".claude/tools/aidlc-orchestrate.ts")),
    );
    // The lockfile's content-addressed sections are identical; only the recorded
    // install paths differ, because they are absolute and the roots are not.
    const pick = (bytes: string) => {
      const lock = JSON.parse(bytes) as Record<string, unknown>;
      return JSON.stringify({
        skills: lock.skills,
        bundles: lock.bundles,
        settings: lock.settings,
        instructions: lock.instructions,
      });
    };
    expect(pick(await readTextFile(join(clone, "outfitter.lock.json")))).toBe(pick(lockBytes));
  });

  test("sync refuses a source whose bytes moved under a pinned commit", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();

    await writeFile(join(ws.repo, ".claude/tools/aidlc-graph.ts"), "export const graph = 0;\n");
    await expect(manager.sync()).rejects.toThrow(HashMismatchError);
  });

  test("verify detects a single edited byte in the installed engine", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();

    expect((await manager.verify()).ok).toBe(true);

    const installed = join(ws.root, ".claude/tools/aidlc-orchestrate.ts");
    await writeFile(installed, `${await readTextFile(installed)} `);

    const report = await manager.verify();
    const issue = report.issues.find((i) => i.primitive === "bundle");
    expect(report.ok).toBe(false);
    expect(issue!.kind).toBe("hash-mismatch");
    expect(issue!.name).toBe("aidlc-engine");
    expect(issue!.path).toBe(join(ws.root, ".claude/tools"));
  });

  test("verify reports a missing destination tree", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();
    await rm(join(ws.root, ".claude/knowledge"), { recursive: true, force: true });

    const report = await manager.verify();
    const issue = report.issues.find((i) => i.primitive === "bundle" && i.kind === "missing");
    expect(issue!.message).toContain(".claude/knowledge");
  });

  test("verify detects an edited hook command in settings", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();

    const settings = await readSettings(ws.root);
    const hooks = settings.hooks as Record<string, { hooks: { command: string }[] }[]>;
    hooks.PostToolUse![0]!.hooks[0]!.command = "bun .claude/hooks/evil.ts";
    await writeFile(settingsFile(ws.root), `${JSON.stringify(settings, null, 2)}\n`);

    const report = await manager.verify();
    const issue = report.issues.find((i) => i.kind === "settings-drift");
    expect(issue!.name).toBe("aidlc");
    expect(issue!.message).toContain("were edited or removed");
  });

  test("verify ignores edits the user makes outside the managed keys", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();

    const settings = await readSettings(ws.root);
    settings.cleanupPeriodDays = 90;
    await writeFile(settingsFile(ws.root), `${JSON.stringify(settings, null, 2)}\n`);

    expect((await manager.verify()).ok).toBe(true);
  });

  test("remove deletes the engine trees and unwinds only its own settings", async () => {
    const ws = await workspace();

    // A settings file the operator wrote first, which must come back intact.
    const original = `${JSON.stringify(
      {
        env: { THEIRS: "1" },
        permissions: { allow: ["Bash(git push:*)"] },
        hooks: {
          PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "theirs.sh" }] }],
        },
      },
      null,
      2,
    )}\n`;
    await writeFileAt(ws.root, ".claude/settings.json", original);

    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();

    const merged = await readSettings(ws.root);
    expect((merged.env as Record<string, string>).THEIRS).toBe("1");
    expect((merged.permissions as { allow: string[] }).allow).toContain("Bash(git push:*)");

    await manager.remove("aidlc-engine");
    for (const dest of Object.values(HARNESS_BUNDLE_PATHS)) {
      expect(await pathExists(join(ws.root, dest))).toBe(false);
    }
    // Removing the engine does not remove the settings fragment: it is named,
    // and removed, separately.
    expect(await pathExists(settingsFile(ws.root))).toBe(true);

    await manager.remove("aidlc");
    expect(await readTextFile(settingsFile(ws.root))).toBe(original);

    const lock = await readLockfile(ws.root);
    expect(lock!.bundles["aidlc-engine"]).toBeUndefined();
    expect(lock!.settings.aidlc).toBeUndefined();
    expect(lock!.targets.claude!.bundles).toEqual({});
    expect(lock!.targets.claude!.settings).toEqual({});
  });

  test("remove drops the manifest entries so the next install does not re-add them", async () => {
    const ws = await workspace();
    await writeFileAt(
      ws.root,
      "outfitter.config.json",
      `${JSON.stringify(harnessManifest(ws.repo), null, 2)}\n`,
    );
    const { manager } = managerFor(ws, harnessManifest(ws.repo), { manifest: undefined });

    await manager.install();
    await manager.remove("aidlc-engine");
    await manager.remove("aidlc");

    const written = JSON.parse(
      await readTextFile(join(ws.root, "outfitter.config.json")),
    ) as Manifest;
    // An emptied section is omitted rather than written as `[]`.
    expect(written.bundles ?? []).toEqual([]);
    expect(written.settings ?? []).toEqual([]);
  });

  test("an orphaned bundle is reported, and pruned on request", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();

    const withoutBundle = harnessManifest(ws.repo, { bundles: [] });
    const { manager: pruning } = managerFor(ws, withoutBundle);

    const warned = await pruning.install();
    expect(
      warned.warnings.some((w) => w.message.includes("aidlc-engine") && w.code === "manifest"),
    ).toBe(true);
    expect(await isDirectory(join(ws.root, ".claude/tools"))).toBe(true);

    await pruning.install({ prune: true });
    expect(await pathExists(join(ws.root, ".claude/tools"))).toBe(false);
    expect((await readLockfile(ws.root))!.bundles["aidlc-engine"]).toBeUndefined();
  });

  test("list reports bundles and settings alongside skills", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();

    const listed = await manager.list();
    const bundle = listed.find((p) => p.kind === "bundle");
    expect(bundle!.name).toBe("aidlc-engine");
    expect(Object.keys(bundle!.paths!).length).toBe(Object.keys(HARNESS_BUNDLE_PATHS).length);
    expect(listed.find((p) => p.kind === "settings")!.name).toBe("aidlc");
    expect(listed.filter((p) => p.kind === "skill").map((p) => p.name).sort()).toEqual([
      "aidlc-build",
      "aidlc-plan",
    ]);
  });

  test("removing one fragment leaves keys a second fragment also owns", async () => {
    const ws = await workspace();
    // Both fragments declare the same env value and the same hook, which is
    // legitimate: a base fragment plus a project's own copy of one setting.
    const shared = {
      env: { AIDLC_HOME: ".aidlc" },
      hooks: {
        PostToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [{ type: "command", command: "bun .claude/hooks/aidlc-runtime-compile.ts" }],
          },
        ],
      },
    };
    const { manager } = managerFor(
      ws,
      harnessManifest(ws.repo, {
        settings: [
          { ref: `local:${ws.repo}/.claude/settings.json`, name: "aidlc" },
          { name: "project-pins", settings: shared },
        ],
        policy: { executableHarness: "warn" },
      }),
    );
    await manager.install();

    await manager.remove("project-pins");

    const settings = await readSettings(ws.root);
    // Still declared by "aidlc", so dropping "project-pins" must not take it.
    expect((settings.env as Record<string, string>).AIDLC_HOME).toBe(".aidlc");
    const groups = (settings.hooks as Record<string, { hooks: { command: string }[] }[]>)
      .PostToolUse!;
    expect(groups.flatMap((g) => g.hooks.map((h) => h.command))).toContain(
      "bun .claude/hooks/aidlc-runtime-compile.ts",
    );

    // And removing the last owner does take it.
    await manager.remove("aidlc");
    expect(await pathExists(settingsFile(ws.root))).toBe(false);
  });

  test("the settings ownership record is what makes removal surgical", async () => {
    const ws = await workspace();
    const { manager } = managerFor(ws, harnessManifest(ws.repo));
    await manager.install();

    const lock = await readLockfile(ws.root);
    const owned = unionOwnedSettings(Object.values(lock!.targets.claude!.settings));
    // Every region the fragment touched is accounted for by name, which is the
    // only reason the merge can be undone without clobbering the file.
    expect(owned.hooks.length).toBe(13);
    // Every registration sits in its own matcher group, and we created all of them.
    expect(owned.hookGroups.length).toBe(13);
    expect(owned.permissions.allow!.length).toBe(4);
  });
});

describe("bundles in a plain filesystem target", () => {
  test("destinations resolve under the target's own directory", async () => {
    const ws = await workspace();
    const { manager } = managerFor(
      ws,
      {
        version: 1,
        bundles: [
          { ref: `local:${ws.repo}`, name: "engine", paths: { ".claude/tools": "engine/tools" } },
        ],
        policy: { executableHarness: "allow" },
      },
      { targets: [filesystemTarget({ dir: "out" })] },
    );
    await manager.install();

    expect((await readdir(join(ws.root, "out", "engine", "tools"))).sort()).toEqual([
      "aidlc-graph.ts",
      "aidlc-orchestrate.ts",
      "aidlc-status.ts",
      "data",
    ]);
  });
});
