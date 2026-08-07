/**
 * Container smoke test: a whole committed harness, installed from a pinned commit.
 *
 * The outfitting lives in `harness/aidlc.ts`, which is a file a consumer can copy
 * whole. This one only drives it and checks the result, the same split the
 * Codex/Claude smoke test keeps.
 *
 * What is worth proving here, in order:
 *
 *  1. all four kinds land together: skills, the engine subtree, settings, instructions;
 *  2. the engine is *complete*, reconciled file by file against the lockfile, because
 *     a partial engine produces skills that fail on first invocation;
 *  3. `settings.json` carries every hook the source registers, reconciled against
 *     the source file rather than against a number written down here; and
 *  4. a `settings.json` the project already had survives the install and comes back
 *     byte for byte after `remove()`.
 *
 * (4) is the check worth having. Everything else fails visibly at install time; a
 * settings merge that clobbers the operator's own file fails invisibly, and the
 * damage is to their work rather than to anything the library reports on.
 *
 * Run via `make smoke-aidlc`.
 */

import { readFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { OutfitterEvent } from "agent-outfitter";

import { check, checkContains, checkDir, checkFile, finish, section } from "./assert.ts";
import { printFiles, printTree, walkFiles } from "./inventory.ts";
import { AIDLC_ENGINE_PATHS, AIDLC_HARNESS_ROOT, AIDLC_REF, setupAidlc } from "./harness/aidlc.ts";

const OUTPUT_DIR = process.cwd();
const HOST_OUTPUT_DIR = process.env.HOST_OUTPUT_DIR;

/**
 * Floors, not exact counts.
 *
 * The upstream harness is free to grow, and a smoke test that fails when it does
 * is a maintenance burden rather than a signal. What must not happen is silently
 * installing *less* than a working harness, so each floor is set below today's
 * figure and the exact shape is reconciled against the source tree instead.
 */
const MIN_SKILLS = 30;
const MIN_HOOK_REGISTRATIONS = 15;
const MIN_HOOK_EVENTS = 8;
const MIN_ENGINE_FILES = 180;

const SETTINGS_PATH = join(OUTPUT_DIR, ".claude", "settings.json");
const RAW_BASE = `https://raw.githubusercontent.com/awslabs/aidlc-workflows/${AIDLC_REF}/${AIDLC_HARNESS_ROOT}`;

type HookGroups = Record<string, { matcher?: string; hooks: { command?: string }[] }[]>;

/** Every `[event, matcher, command]` a settings document registers. */
const registrations = (settings: { hooks?: HookGroups }): string[] => {
  const out: string[] = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) {
      for (const entry of group.hooks ?? []) {
        if (entry.command) out.push(`${event} ${group.matcher ?? ""} ${entry.command}`);
      }
    }
  }
  return out.sort();
};

// ---------------------------------------------------------------------------
// A settings file the operator wrote first
// ---------------------------------------------------------------------------

if (process.env.KEEP_OUTPUT === "1") {
  console.log("  KEEP_OUTPUT=1: not clearing the output directory");
} else {
  for (const entry of await readdir(OUTPUT_DIR)) {
    await rm(join(OUTPUT_DIR, entry), { recursive: true, force: true });
  }
}

/**
 * Seeded before installing, at the literal expected path.
 *
 * Every region the merge has to be careful about is represented: an `env` value,
 * a `permissions.allow` rule, a scalar, and a hook of their own in an event the
 * harness also uses. "Merge, never clobber" is the claim most likely to be broken
 * by a refactor and least likely to be noticed.
 */
const HAND_WRITTEN = `${JSON.stringify(
  {
    env: { OPERATOR_OWNED: "1" },
    permissions: { allow: ["Bash(git push:*)"] },
    cleanupPeriodDays: 45,
    hooks: {
      PostToolUse: [
        { matcher: "Write|Edit", hooks: [{ type: "command", command: "./operators-own-hook.sh" }] },
      ],
    },
  },
  null,
  2,
)}\n`;

await mkdir(dirname(SETTINGS_PATH), { recursive: true });
await writeFile(SETTINGS_PATH, HAND_WRITTEN);

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

console.log("agent-outfitter smoke test (harness: aidlc)");
console.log(`  installing awslabs/aidlc-workflows@${AIDLC_REF} into ${OUTPUT_DIR}`);
if (HOST_OUTPUT_DIR) console.log(`  on host: ${HOST_OUTPUT_DIR}`);

const events: OutfitterEvent[] = [];
const onEvent = (event: OutfitterEvent): void => {
  events.push(event);
  if (event.type === "source:retry") {
    console.log(`  … retrying (${event.attempt}/${event.of}) after ${event.delayMs}ms`);
  }
};

const started = Date.now();
const { outfitter, install: result } = await setupAidlc({ onEvent });
const elapsed = Date.now() - started;

section(`Install (${elapsed}ms, cold cache)`);
const skills = result.installed.filter((p) => p.kind === "skill");
const bundles = result.installed.filter((p) => p.kind === "bundle");
const settingsInstalled = result.installed.filter((p) => p.kind === "settings");

check(`installed at least ${MIN_SKILLS} skills`, skills.length >= MIN_SKILLS, `got ${skills.length}`);
check("installed the engine bundle", bundles.length === 1, `got ${bundles.length}`);
check("merged the settings fragment", settingsInstalled.length === 1);
check("merged an instruction fragment", result.instructions.length >= 1);
check(
  "every primitive pinned to a commit",
  [...skills, ...bundles, ...settingsInstalled].every((p) => /^[0-9a-f]{40}$/.test(p.commit)),
);
await checkFile("lockfile written", result.lockfilePath);

/**
 * The engine must be on disk before the skills that shell into it.
 *
 * Not cosmetic: an agent that discovers a skill whose engine is absent reports a
 * broken skill, which sends whoever reads it looking in the wrong place.
 */
const firstBundle = events.findIndex((e) => e.type === "bundle:materialized");
const firstSkill = events.findIndex((e) => e.type === "skill:materialized");
const settingsAt = events.findIndex((e) => e.type === "settings:written");
check("the engine was installed before any skill", firstBundle >= 0 && firstBundle < firstSkill);
check("settings were registered last", settingsAt > firstSkill);

const harnessWarning = result.warnings.find((w) => w.code === "executable-harness");
check("the executable harness was declared, not assumed", harnessWarning !== undefined);
if (harnessWarning) console.log(`      ${harnessWarning.message.slice(0, 200)}…`);

// This source carries four legitimate mid-file U+FEFFs. Under `scan: "warn"` they
// must be *reported*, not passed over: a scanner that goes quiet is worse than
// one that is noisy. See the note in harness/aidlc.ts.
const scanWarning = result.warnings.find((w) => w.code === "hidden-unicode");
check("hidden characters in the engine were reported", scanWarning !== undefined);

// ---------------------------------------------------------------------------
// The engine on disk
// ---------------------------------------------------------------------------

section("Engine on disk");
for (const dest of Object.values(AIDLC_ENGINE_PATHS)) {
  await checkDir(dest, join(OUTPUT_DIR, dest));
}
await checkFile(
  ".claude/tools holds the orchestrator every skill calls",
  join(OUTPUT_DIR, ".claude/tools/aidlc-orchestrate.ts"),
);

const engineFiles = (
  await Promise.all(
    Object.values(AIDLC_ENGINE_PATHS).map(async (dest) => {
      const files = await walkFiles(join(OUTPUT_DIR, dest));
      // Re-rooted at the project so the paths match what the lockfile recorded.
      return files.map((f) => ({ rel: `${dest}/${f.rel}`, bytes: f.bytes }));
    }),
  )
).flat();

check(
  `engine carries at least ${MIN_ENGINE_FILES} files`,
  engineFiles.length >= MIN_ENGINE_FILES,
  `got ${engineFiles.length}`,
);

/**
 * Reconcile the engine against the lockfile.
 *
 * This is what turns the listing into evidence. The lockfile records the file list
 * the bundle was hashed over, so a disagreement means either the install dropped
 * something or wrote something it does not account for, and in both cases the hash
 * guarding the tree describes a tree that is not the one on disk.
 */
const lock = JSON.parse(await readFile(result.lockfilePath, "utf8")) as {
  bundles: Record<string, { files: string[]; contentHash: string; pathHashes: Record<string, string> }>;
  settings: Record<string, { contentHash: string }>;
};
const locked = lock.bundles["aidlc-engine"];

if (!locked) {
  check("lockfile records the engine bundle", false, "absent from the lockfile");
} else {
  const onDisk = new Set(engineFiles.map((f) => f.rel));
  const missing = locked.files.filter((f) => !onDisk.has(f));
  const extra = [...onDisk].filter((f) => !locked.files.includes(f));
  check(
    `${locked.files.length} recorded engine files all present, none unaccounted for`,
    missing.length === 0 && extra.length === 0,
    [
      missing.length > 0 ? `missing: ${missing.slice(0, 5).join(", ")}` : "",
      extra.length > 0 ? `unaccounted for: ${extra.slice(0, 5).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; "),
  );
  check(
    "each declared path carries its own hash",
    Object.keys(locked.pathHashes).length === Object.keys(AIDLC_ENGINE_PATHS).length,
  );
}

section("Installed engine");
printTree(OUTPUT_DIR, engineFiles);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

section("Settings merge");
await checkFile("settings written inside .claude/", SETTINGS_PATH);
check(
  "settings did not land at the project root",
  !(await stat(join(OUTPUT_DIR, "settings.json")).then(
    () => true,
    () => false,
  )),
);

const merged = JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as {
  hooks?: HookGroups;
  env?: Record<string, string>;
  permissions?: { allow?: string[] };
  statusLine?: unknown;
  model?: string;
  cleanupPeriodDays?: number;
};

/**
 * Reconciled against the *source* settings file, not against a count written here.
 *
 * Reading the expected shape out of the input is legitimate; reading it out of the
 * code under test would not be. The floors above keep a silently-empty source from
 * passing this.
 */
const sourceSettings = (await fetch(`${RAW_BASE}/.claude/settings.json`).then((r) =>
  r.json(),
)) as { hooks?: HookGroups; env?: Record<string, string>; permissions?: { allow?: string[] } };

const wanted = registrations(sourceSettings);
const got = new Set(registrations(merged));
const absent = wanted.filter((r) => !got.has(r));

check(
  `source registers at least ${MIN_HOOK_REGISTRATIONS} hooks`,
  wanted.length >= MIN_HOOK_REGISTRATIONS,
  `source has ${wanted.length}`,
);
check(
  `across at least ${MIN_HOOK_EVENTS} events`,
  Object.keys(sourceSettings.hooks ?? {}).length >= MIN_HOOK_EVENTS,
);
check(
  `all ${wanted.length} hook registrations present after the merge`,
  absent.length === 0,
  absent.slice(0, 5).join(" | "),
);
check(
  "multi-matcher events kept every group",
  (merged.hooks?.PostToolUse ?? []).length >= (sourceSettings.hooks?.PostToolUse ?? []).length,
);
check("the status line was registered", merged.statusLine !== undefined);
check("scalars came across", typeof merged.model === "string", String(merged.model));
for (const [key, value] of Object.entries(sourceSettings.env ?? {})) {
  if (merged.env?.[key] !== value) {
    check(`env.${key} merged`, false, `got ${merged.env?.[key]}`);
  }
}
check("every source env key merged", Object.keys(sourceSettings.env ?? {}).every((k) => k in (merged.env ?? {})));

section("The operator's own file");
check("their env key survived", merged.env?.OPERATOR_OWNED === "1", JSON.stringify(merged.env));
check(
  "their permissions rule survived",
  (merged.permissions?.allow ?? []).includes("Bash(git push:*)"),
);
check("their unrelated scalar survived", merged.cleanupPeriodDays === 45);
check(
  "their own hook survived, beside the harness's",
  got.has("PostToolUse Write|Edit ./operators-own-hook.sh"),
);

const instructions = await readFile(join(OUTPUT_DIR, "CLAUDE.md"), "utf8");
checkContains("instruction region opened", instructions, "<!-- BEGIN agent-outfitter:");

await printFiles("Configuration and instructions", [
  result.lockfilePath,
  SETTINGS_PATH,
  join(OUTPUT_DIR, "CLAUDE.md"),
]);

// ---------------------------------------------------------------------------
// Reproducibility
// ---------------------------------------------------------------------------

section("Verify and re-sync");
const report = await outfitter.verify();
check(
  "verify() reports no issues",
  report.issues.length === 0,
  report.issues.map((i) => `${i.kind}:${i.name}`).join(", "),
);

// An edited engine file must be caught: this is the guarantee that makes pinning
// worth anything at all.
const probe = join(OUTPUT_DIR, ".claude/tools/aidlc-orchestrate.ts");
const pristine = await readFile(probe, "utf8");
await writeFile(probe, `${pristine} `);
const tampered = await outfitter.verify();
check(
  "verify() catches a single edited byte in the engine",
  tampered.issues.some((i) => i.kind === "hash-mismatch" && i.primitive === "bundle"),
  tampered.issues.map((i) => `${i.kind}:${i.name}`).join(", "),
);
await writeFile(probe, pristine);

const resyncStarted = Date.now();
const second = await outfitter.sync();
const resyncElapsed = Date.now() - resyncStarted;
check(
  `sync() re-materialized nothing (${resyncElapsed}ms, warm cache)`,
  second.installed.filter((p) => p.kind === "skill" || p.kind === "bundle").length === 0,
  `${second.installed.length} unexpectedly rewritten`,
);
check(
  "sync() skipped the engine instead",
  second.skipped.some((p) => p.kind === "bundle"),
);

const listed = await outfitter.list();
check("list() sees the engine", listed.some((p) => p.kind === "bundle"));
check("list() sees the settings fragment", listed.some((p) => p.kind === "settings"));

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

section("Removal");
await outfitter.remove("aidlc-engine");
const enginePresent = await Promise.all(
  Object.values(AIDLC_ENGINE_PATHS).map((dest) =>
    stat(join(OUTPUT_DIR, dest)).then(
      () => true,
      () => false,
    ),
  ),
);
check("remove() deleted every engine tree", enginePresent.every((p) => !p));

await outfitter.remove("aidlc-settings");
const restored = await readFile(SETTINGS_PATH, "utf8");
check(
  "the operator's settings.json is byte-identical to what they wrote",
  restored === HAND_WRITTEN,
  `${restored.length} bytes vs ${HAND_WRITTEN.length} expected`,
);

if (HOST_OUTPUT_DIR) {
  section("Inspect on the host");
  const rel = (abs: string): string => `${HOST_OUTPUT_DIR}${abs.slice(OUTPUT_DIR.length)}`;
  console.log(`  skills:       ${rel(join(OUTPUT_DIR, ".claude/skills"))}`);
  console.log(`  settings:     ${rel(SETTINGS_PATH)}`);
  console.log(`  lockfile:     ${rel(result.lockfilePath)}`);
}

finish("aidlc");
