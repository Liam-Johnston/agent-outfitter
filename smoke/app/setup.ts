/**
 * Container smoke test.
 *
 * The outfitting itself lives in `harness/codex.ts` and `harness/claude.ts`,
 * each self-contained, each a file a consumer can copy whole. This one only drives
 * them and checks the result. Keeping the split strict is deliberate: an example
 * carrying test scaffolding is an example nobody can lift cleanly, and assertions
 * living inside the thing they assert on tend to start agreeing with it.
 *
 * What gets checked, in the order a wrapper depends on it:
 *
 *  1. the paths resolved to the library's documented defaults, since neither
 *     harness file configures one;
 *  2. the files landed there, reconciled file-by-file against the lockfile; and
 *  3. `sdkOptions()` points at those same files.
 *
 * (3) is the check worth having. A wrong path in (2) fails visibly at install; a
 * wrong path in (3) produces an agent that starts fine and silently knows
 * nothing, which is the failure this whole exercise exists to rule out.
 *
 * Everything written survives the container via a bind mount, so the result can
 * also be read by hand afterwards rather than only trusted.
 *
 * Run via `make smoke`. Set HARNESS=codex|claude to pick a target.
 */

import { homedir } from "node:os";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { OutfitterEvent } from "agent-outfitter";

import { check, checkAbsent, checkContains, checkDir, checkFile, finish, section } from "./assert.ts";
import { printFiles, printTree, walkFiles } from "./inventory.ts";
import { setupClaude } from "./harness/claude.ts";
import { setupCodex } from "./harness/codex.ts";

/**
 * What the harness files are expected to install.
 *
 * Restated here rather than imported from them: an assertion that reads its
 * expected value out of the code under test cannot fail, it can only agree.
 */
const SKILLS = ["pdf", "xlsx", "mcp-builder", "ce-work"] as const;
const MCP_SERVERS = ["filesystem", "github"] as const;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const HARNESS = process.env.HARNESS ?? "codex";

/**
 * Neither harness file passes an install location, so every path comes from the
 * library's own defaults: `$HOME/.codex` for Codex, the working directory for
 * Claude. Steering the *output* is done by pointing `HOME` and the working
 * directory at the bind mount in the Dockerfile, not by passing arguments, so the
 * default resolution logic is the thing under test rather than being bypassed.
 */
const OUTPUT_DIR = process.cwd();
/** Where the host can find `OUTPUT_DIR`, for the closing hint. Cosmetic only. */
const HOST_OUTPUT_DIR = process.env.HOST_OUTPUT_DIR;
/** Baked into the image, outside the mount, so clearing the output cannot eat it. */
const INSTRUCTIONS_DIR = process.env.INSTRUCTIONS_DIR ?? "/workspace/instructions";

if (HARNESS !== "codex" && HARNESS !== "claude") {
  console.error(`HARNESS must be "codex" or "claude", got ${JSON.stringify(HARNESS)}`);
  process.exit(2);
}

// A default-location install is only inspectable if the defaults land inside the
// mount, so fail loudly rather than scattering files somewhere invisible.
if (process.env.CODEX_HOME) {
  console.error("CODEX_HOME is set; unset it so the Codex default path is what gets tested.");
  process.exit(2);
}
if (homedir() !== OUTPUT_DIR) {
  console.error(`HOME (${homedir()}) must equal the working directory (${OUTPUT_DIR}).`);
  process.exit(2);
}

/**
 * The paths each harness's defaults should resolve to.
 *
 * Written out here as literals rather than read back off the target, because
 * comparing a target's output to itself would pass no matter where it pointed.
 */
const EXPECTED =
  HARNESS === "codex"
    ? {
        skillsDir: join(homedir(), ".codex", "skills"),
        instructionPath: join(homedir(), ".codex", "AGENTS.md"),
        mcpConfig: join(homedir(), ".codex", "config.toml"),
        skillsLabel: "$HOME/.codex/skills",
        instructionLabel: "$HOME/.codex/AGENTS.md",
      }
    : {
        skillsDir: join(OUTPUT_DIR, ".claude", "skills"),
        instructionPath: join(OUTPUT_DIR, "CLAUDE.md"),
        mcpConfig: join(OUTPUT_DIR, ".mcp.json"),
        skillsLabel: "<cwd>/.claude/skills",
        instructionLabel: "<cwd>/CLAUDE.md",
      };

/**
 * Clear the output directory before installing.
 *
 * A bind-mounted directory outlives the container, and a skill whose hash still
 * matches is skipped rather than rewritten, so leftovers from a previous run
 * would turn the first install into a no-op and make the assertions below
 * describe the *last* run instead of this one. The mount point's contents are
 * removed rather than the directory itself, which cannot be unlinked.
 *
 * `KEEP_OUTPUT=1` skips this, which is how a deliberately dirty starting state is
 * staged to confirm an assertion can actually fail. See the README.
 */
if (process.env.KEEP_OUTPUT === "1") {
  console.log("  KEEP_OUTPUT=1: not clearing the output directory");
} else {
  for (const entry of await readdir(OUTPUT_DIR)) {
    await rm(join(OUTPUT_DIR, entry), { recursive: true, force: true });
  }
}

/**
 * Seed the instruction file with hand-written prose before installing.
 *
 * "Merge, never clobber" is the claim most likely to be broken by a refactor and
 * least likely to be noticed, because the damage is to the operator's own text
 * rather than to anything the library reports on. Written to the literal expected
 * path, so the seeding does not depend on the code under test agreeing about
 * where that is.
 */
const HAND_WRITTEN = "# House rules\n\nWritten by a human. Must survive the install.\n";
await mkdir(dirname(EXPECTED.instructionPath), { recursive: true });
await writeFile(EXPECTED.instructionPath, HAND_WRITTEN);

// ---------------------------------------------------------------------------
// Run the example
// ---------------------------------------------------------------------------

console.log(`agent-outfitter smoke test (harness: ${HARNESS})`);
console.log(`  default paths, nothing configured:`);
console.log(`    HOME:  ${homedir()}`);
console.log(`    cwd:   ${OUTPUT_DIR}`);
if (HOST_OUTPUT_DIR) console.log(`  on host: ${HOST_OUTPUT_DIR}`);

const events: OutfitterEvent[] = [];
const onEvent = (event: OutfitterEvent): void => {
  events.push(event);
  if (event.type === "source:retry") {
    console.log(`  … retrying (${event.attempt}/${event.of}) after ${event.delayMs}ms`);
  }
};

const started = Date.now();
const setup =
  HARNESS === "codex"
    ? await setupCodex({ instructionsDir: INSTRUCTIONS_DIR, onEvent })
    : await setupClaude({ instructionsDir: INSTRUCTIONS_DIR, onEvent });
const elapsed = Date.now() - started;

const { outfitter, install: result, sdk } = setup;

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

section(`Install (${elapsed}ms, cold cache)`);
const installedSkills = result.installed.filter((p) => p.kind === "skill");
check(
  `installed ${SKILLS.length} skills`,
  installedSkills.length === SKILLS.length,
  `got ${installedSkills.length}: ${installedSkills.map((s) => s.name).join(", ")}`,
);
for (const name of SKILLS) {
  check(`skill "${name}" reported installed`, installedSkills.some((s) => s.name === name));
}
check(
  `every skill pinned to a commit`,
  installedSkills.every((s) => /^[0-9a-f]{40}$/.test(s.commit)),
);
check(`${MCP_SERVERS.length} MCP servers resolved`, result.mcp.length === MCP_SERVERS.length);
check(`instruction fragment resolved`, result.instructions.length >= 1);
await checkFile("lockfile written", result.lockfilePath);

// ---------------------------------------------------------------------------
// Default locations
// ---------------------------------------------------------------------------

section("Default locations");
check(`skills default to ${EXPECTED.skillsLabel}`, sdk.skillsDir === EXPECTED.skillsDir, sdk.skillsDir);
check(
  `instructions default to ${EXPECTED.instructionLabel}`,
  sdk.instructionPath === EXPECTED.instructionPath,
  sdk.instructionPath,
);
check(
  "lockfile defaults to <cwd>",
  result.lockfilePath === join(OUTPUT_DIR, "outfitter.lock.json"),
  result.lockfilePath,
);

section("Files on disk");
await checkDir("skills directory exists", sdk.skillsDir);
for (const name of SKILLS) {
  await checkFile(`${name}/SKILL.md`, join(sdk.skillsDir, name, "SKILL.md"));
}
check(
  "installed paths agree with sdkOptions().skillsDir",
  installedSkills.every((s) => s.path.startsWith(sdk.skillsDir)),
  `skillsDir=${sdk.skillsDir}`,
);

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

section("Installed files");
const onDiskFiles = await walkFiles(sdk.skillsDir);
printTree(sdk.skillsDir, onDiskFiles);

console.log("");
await printFiles("Configuration and instructions", [
  result.lockfilePath,
  sdk.instructionPath,
  EXPECTED.mcpConfig,
]);

/**
 * Reconcile the listing above against the lockfile.
 *
 * This is what turns the printout from a claim into evidence. The lockfile
 * records the file list each skill was hashed over, so a disagreement between it
 * and the directory means either the install dropped something or wrote something
 * it does not account for, and in both cases the content hash guarding the tree
 * describes a tree that is not the one on disk.
 */
section("Inventory reconciliation");
const lock = JSON.parse(await readFile(result.lockfilePath, "utf8")) as {
  skills: Record<string, { files: string[]; contentHash: string }>;
};

const onDiskBySkill = new Map<string, Set<string>>();
for (const file of onDiskFiles) {
  const slash = file.rel.indexOf("/");
  if (slash === -1) continue;
  const skill = file.rel.slice(0, slash);
  const set = onDiskBySkill.get(skill) ?? new Set<string>();
  set.add(file.rel.slice(slash + 1));
  onDiskBySkill.set(skill, set);
}

let reconciled = 0;
for (const name of SKILLS) {
  const recorded = lock.skills[name]?.files;
  if (!recorded) {
    check(`lockfile records "${name}"`, false, "absent from the lockfile");
    continue;
  }
  const actual = onDiskBySkill.get(name) ?? new Set<string>();
  const missing = recorded.filter((f) => !actual.has(f));
  const extra = [...actual].filter((f) => !recorded.includes(f));
  const ok = check(
    `${name}: ${recorded.length} files on disk match the lockfile`,
    missing.length === 0 && extra.length === 0,
    [
      missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
      extra.length > 0 ? `unaccounted for: ${extra.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; "),
  );
  if (ok) reconciled += recorded.length;
}
check(
  `every recorded file accounted for (${reconciled} total)`,
  reconciled === onDiskFiles.length,
  `lockfile totals ${reconciled}, directory holds ${onDiskFiles.length}`,
);

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

section("Instructions");
await checkFile("instruction file written", sdk.instructionPath);
const instructions = await readFile(sdk.instructionPath, "utf8");
checkContains("managed region opened", instructions, "<!-- BEGIN agent-outfitter:");
checkContains("managed region closed", instructions, "<!-- END agent-outfitter:");
checkContains("fragment body present", instructions, "smoke-test marker");
checkContains("hand-written prose survived", instructions, HAND_WRITTEN.trim());

// ---------------------------------------------------------------------------
// MCP configuration
// ---------------------------------------------------------------------------

section("MCP configuration");
await checkFile("mcp config written", EXPECTED.mcpConfig);
const mcpRaw = await readFile(EXPECTED.mcpConfig, "utf8");

if (HARNESS === "codex") {
  checkContains("[mcp_servers.github]", mcpRaw, "[mcp_servers.github]");
  checkContains("[mcp_servers.filesystem]", mcpRaw, "[mcp_servers.filesystem]");
  checkContains("http server url", mcpRaw, "https://api.githubcopilot.com/mcp/");
  checkContains("stdio server command", mcpRaw, 'command = "npx"');
  checkContains("token referenced by env name", mcpRaw, "GITHUB_MCP_TOKEN");
} else {
  const parsed = JSON.parse(mcpRaw) as {
    mcpServers?: Record<string, { type?: string }>;
  };
  check("mcpServers.github present", parsed.mcpServers?.github?.type === "http");
  check("mcpServers.filesystem present", parsed.mcpServers?.filesystem?.type === "stdio");
  checkContains("token referenced by placeholder", mcpRaw, "${GITHUB_MCP_TOKEN}");
}
// The promise that makes a generated config safe to bake into a container image.
checkAbsent("no token value in the file", mcpRaw, "smoke-secret-value");

// ---------------------------------------------------------------------------
// The SDK handoff
// ---------------------------------------------------------------------------

section("SDK handoff");
if (HARNESS === "codex") {
  const { sdk: codexSdk } = setup as Awaited<ReturnType<typeof setupCodex>>;
  check(
    "env.CODEX_HOME points at the install",
    codexSdk.env.CODEX_HOME === join(homedir(), ".codex"),
    codexSdk.env.CODEX_HOME,
  );
  check(
    "config.mcp_servers carries both servers",
    Object.keys(codexSdk.config.mcp_servers).sort().join(",") === MCP_SERVERS.join(","),
    Object.keys(codexSdk.config.mcp_servers).join(","),
  );
} else {
  const { sdk: claudeSdk } = setup as Awaited<ReturnType<typeof setupClaude>>;
  // Without this the Agent SDK loads no filesystem skills at all.
  check(
    'settingSources includes "project"',
    claudeSdk.settingSources.includes("project"),
    JSON.stringify(claudeSdk.settingSources),
  );
  check("cwd is the project dir", claudeSdk.cwd === OUTPUT_DIR, String(claudeSdk.cwd));
  check(
    "mcpServers carries both servers",
    Object.keys(claudeSdk.mcpServers).sort().join(",") === MCP_SERVERS.join(","),
    Object.keys(claudeSdk.mcpServers).join(","),
  );
  // In-process options must hold the real value; the placeholder form would be
  // passed through verbatim as a broken credential.
  const gh = claudeSdk.mcpServers.github;
  check(
    "http auth header resolved to a value",
    gh?.type === "http" && gh.headers?.Authorization === "Bearer smoke-secret-value",
    gh?.type === "http" ? JSON.stringify(gh.headers) : "not an http server",
  );
}

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

// A second pass must be a no-op: the cache is warm and the hashes match, so
// nothing should be re-materialized. This is also the path a container takes
// when the image already carries a warm cache.
const resyncStarted = Date.now();
const second = await outfitter.sync();
const resyncElapsed = Date.now() - resyncStarted;
check(
  `sync() re-materialized nothing (${resyncElapsed}ms, warm cache)`,
  second.installed.filter((p) => p.kind === "skill").length === 0,
  `${second.installed.length} unexpectedly rewritten`,
);
check(
  "sync() skipped every skill instead",
  second.skipped.filter((p) => p.kind === "skill").length === SKILLS.length,
  `${second.skipped.length} skipped`,
);

const listed = await outfitter.list();
check(
  "list() sees the installed skills",
  listed.filter((p) => p.kind === "skill").length === SKILLS.length,
);

// Everything asserted above survives the container, so point at it. The paths
// are printed relative to the mount so they can be pasted straight into a shell.
if (HOST_OUTPUT_DIR) {
  section("Inspect on the host");
  const rel = (abs: string): string => `${HOST_OUTPUT_DIR}${abs.slice(OUTPUT_DIR.length)}`;
  console.log(`  skills:       ${rel(sdk.skillsDir)}`);
  console.log(`  instructions: ${rel(sdk.instructionPath)}`);
  console.log(`  mcp config:   ${rel(EXPECTED.mcpConfig)}`);
  console.log(`  lockfile:     ${rel(result.lockfilePath)}`);
}

finish(HARNESS);
