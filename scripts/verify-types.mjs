/**
 * Typecheck a synthetic consumer against the built declarations.
 *
 * Resolution goes through package.json "exports", the way a real dependent
 * resolves types — which catches a .d.ts that only happens to compile inside
 * this repo's own tsconfig.
 */

import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const pkgRoot = process.cwd();
const dir = await mkdtemp(join(tmpdir(), "outfitter-types-"));
await mkdir(join(dir, "node_modules"), { recursive: true });
await symlink(pkgRoot, join(dir, "node_modules", "agent-outfitter"), "dir");
await symlink(join(pkgRoot, "node_modules", "@types"), join(dir, "node_modules", "@types"), "dir");

// Without "type": "module" TypeScript treats app.ts as CommonJS under
// nodenext, which forbids top-level await and misreports the real errors.
await writeFile(
  join(dir, "package.json"),
  JSON.stringify({ name: "consumer", private: true, type: "module" }),
);

await writeFile(
  join(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      lib: ["ES2022"],
      target: "ES2022",
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
    },
    include: ["app.ts"],
  }),
);

await writeFile(
  join(dir, "app.ts"),
  `
import {
  createAgentManager, codexTarget, claudeTarget, filesystemTarget, openaiHostedTarget,
  defineConfig, materializeToDir, installedHash, writeInstructionFile, HashMismatchError,
} from "agent-outfitter";
import type {
  AgentTarget, OutfitterEvent, Resolution, InstallResult, TrustPolicy, InstalledPrimitive,
  ResolvedInstruction, PrimitiveKind,
} from "agent-outfitter";

const custom: AgentTarget = {
  name: "mine",
  supports: ["skill", "instruction"],
  resolveDir: (kind: PrimitiveKind, ctx) =>
    kind === "instruction" ? \`\${ctx.root}/AGENTS.md\` : \`\${ctx.root}/skills\`,
  materialize: (input) => materializeToDir(\`\${input.ctx.root}/skills\`, input),
  currentHash: (name, ctx) => installedHash(\`\${ctx.root}/skills\`, name),
  writeInstructions: (input) => writeInstructionFile(\`\${input.ctx.root}/AGENTS.md\`, input),
};

const policy: TrustPolicy = {
  allowedOwners: ["acme"], scripts: "warn",
  allowTransitiveMcp: false, allowTransitiveInstructions: false,
};

const o = createAgentManager({
  root: "/tmp/x",
  targets: [codexTarget({ codexHome: "/tmp/c" }), claudeTarget({ dir: "/tmp/p" }),
            filesystemTarget({ dir: "out" }), custom],
  policy,
  auth: (host, owner) => (owner === "acme" ? process.env.T : undefined),
  onEvent: (e: OutfitterEvent) => { if (e.type === "instruction:written") void e.path; },
});

const r: Resolution = await o.resolve({
  refs: ["github:acme/skills#v1"],
  instructions: [{ ref: "github:acme/cfg/instructions", select: ["house-*"] }],
});
const frags: ResolvedInstruction[] = [...r.instructions.values()];
void frags.map((f) => f.contentHash);

const out: InstallResult = await o.install({ resolution: r, dryRun: true });
const byKind: InstalledPrimitive[] = out.installed.filter((p) => p.kind === "instruction");
void byKind.length;
void out.instructions.length;
void (await o.sync()).lockfilePath;
void (await o.list()).map((s) => s.kind);
void (await o.verify()).issues.map((i) => i.primitive);
await o.remove("x");
void (await o.add("github:acme/skills", { select: ["a"] })).installed;
void new HashMismatchError("a", "b", "c").expected;
void defineConfig({ version: 1, sources: ["local:./s"], instructions: ["local:./i"], targets: [custom] });
void openaiHostedTarget({ upload: async () => ({ skillId: "sk_1" }) }).supports;

// @ts-expect-error - an invalid policy value must not typecheck
const bad: TrustPolicy = { scripts: "sometimes" };
void bad;
// @ts-expect-error - resolveDir requires a kind argument
void custom.resolveDir({ root: "", cacheDir: "", emit: () => {}, warn: () => {} });
`,
);

const tsc = join(pkgRoot, "node_modules", ".bin", "tsc");
const result = spawnSync(tsc, ["-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" });
if (result.status !== 0) {
  console.error(result.stdout || result.stderr);
  throw new Error("consumer typecheck failed against the published declarations");
}
console.log("published types resolve cleanly for a consumer via package.json exports");
