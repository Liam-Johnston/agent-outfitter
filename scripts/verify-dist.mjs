/**
 * Smoke-check the built package under plain Node.
 *
 * Node validates an ESM module's export list at link time, so importing dist is
 * enough to catch a build that emitted a name it does not actually export — the
 * failure mode that a bundled build introduced and this check exists to stop.
 * Then it runs one real install, because linking is necessary but not sufficient.
 */

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = pathToFileURL(join(process.cwd(), "dist", "index.js")).href;
const m = await import(dist);

const required = [
  "createAgentManager",
  "codexTarget",
  "claudeTarget",
  "filesystemTarget",
  "openaiHostedTarget",
  "defineConfig",
  "readLockfile",
  "mergeInstructions",
  "writeInstructionFile",
  "materializeToDir",
  "OutfitterError",
  "AuthError",
  "HashMismatchError",
  "PolicyViolationError",
  "CycleError",
];
const missing = required.filter((k) => m[k] === undefined);
if (missing.length > 0) throw new Error(`dist is missing exports: ${missing.join(", ")}`);

// One real install, exercising all three primitive kinds end to end.
const base = await mkdtemp(join(tmpdir(), "outfitter-verify-"));
const repo = join(base, "repo");
await mkdir(join(repo, "skills", "hello"), { recursive: true });
await writeFile(
  join(repo, "skills", "hello", "SKILL.md"),
  "---\nname: hello\ndescription: Say hi.\n---\nSay hi.\n",
);
await mkdir(join(repo, "instructions"), { recursive: true });
await writeFile(join(repo, "instructions", "house-style.md"), "Be terse.\n");

const root = join(base, "project");
await mkdir(root, { recursive: true });

const outfitter = m.createAgentManager({
  root,
  cacheDir: join(base, "cache"),
  targets: [m.filesystemTarget({ dir: "installed" })],
});

const result = await outfitter.install({
  refs: [`local:${repo}`],
  mcp: [{ name: "fs", transport: "stdio", command: "npx", args: ["-y", "srv"] }],
  instructions: [`local:${join(repo, "instructions")}`],
});

const kinds = [...new Set(result.installed.map((p) => p.kind))].sort();
if (kinds.join(",") !== "instruction,skill") {
  throw new Error(`expected skill and instruction installs, got: ${kinds.join(",") || "none"}`);
}
if (result.mcp.length !== 1) throw new Error("expected one MCP server to be configured");

const agents = await readFile(join(root, "installed", "AGENTS.md"), "utf8");
if (!agents.includes("BEGIN agent-outfitter: house-style")) {
  throw new Error("instruction fragment was not merged into AGENTS.md");
}

const report = await outfitter.verify();
if (!report.ok) throw new Error(`verify() failed: ${JSON.stringify(report.issues)}`);

const synced = await outfitter.sync();
if (synced.skipped.length !== 1) {
  throw new Error(`sync() should skip the unchanged skill, skipped ${synced.skipped.length}`);
}

console.log(
  `dist/index.js: ${Object.keys(m).length} exports, install+verify+sync all pass on Node ${process.version}`,
);
