import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ManifestError } from "../src/errors.js";
import { defineConfig, findManifest, loadManifest, writeManifest } from "../src/manifest.js";
import { readTextFile } from "../src/fsutil.js";
import { cleanupTempDirs, makeTempDir, writeFileAt } from "./helpers.js";

afterAll(cleanupTempDirs);

const YAML_MANIFEST = `
version: 1
targets: [codex]
sources:
  - ref: github:acme/agent-skills#v1.4.0
    select: [csv-insights, pdf-extract]
  - github:anthropics/skills/skills/pdf
  - ref: github:acme/internal-skills#main
    auth: { env: SKILLS_TOKEN }
mcp:
  - name: github
    transport: http
    url: https://api.githubcopilot.com/mcp/
    auth: { bearerEnv: GITHUB_MCP_TOKEN }
  - name: filesystem
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
policy:
  allowedHosts: [github.com]
  requireLockHashMatch: true
  scripts: warn
  allowTransitiveMcp: false
  allowedMcpHosts: [api.githubcopilot.com]
`;

describe("loadManifest", () => {
  test("loads and validates the YAML form from the spec", async () => {
    const root = await makeTempDir();
    await writeFileAt(root, "outfitter.config.yaml", YAML_MANIFEST);

    const { manifest, path, writable } = await loadManifest({ root });
    expect(path).toBe(join(root, "outfitter.config.yaml"));
    expect(writable).toBe(true);
    expect(manifest.targets).toEqual(["codex"]);
    expect(manifest.sources).toHaveLength(3);
    expect(manifest.mcp?.[0]).toMatchObject({ name: "github", transport: "http" });
    expect(manifest.policy?.allowedHosts).toEqual(["github.com"]);
  });

  test("loads JSON and reports it as writable", async () => {
    const root = await makeTempDir();
    await writeFileAt(
      root,
      "outfitter.config.json",
      JSON.stringify({ version: 1, sources: ["local:./skills"] }),
    );
    const { manifest, writable } = await loadManifest({ root });
    expect(writable).toBe(true);
    expect(manifest.sources).toEqual(["local:./skills"]);
  });

  test("returns an empty manifest when none exists", async () => {
    const root = await makeTempDir();
    const { manifest, path } = await loadManifest({ root });
    expect(path).toBeUndefined();
    expect(manifest).toEqual({ version: 1, sources: [], mcp: [], instructions: [] });
  });

  test("accepts an inline manifest but marks it read-only", async () => {
    const root = await makeTempDir();
    const { manifest, writable } = await loadManifest({
      root,
      manifest: { version: 1, sources: ["local:./x"] },
    });
    expect(writable).toBe(false);
    expect(manifest.sources).toEqual(["local:./x"]);
  });

  test("loads a TypeScript config and treats it as read-only", async () => {
    const root = await makeTempDir();
    await writeFileAt(
      root,
      "outfitter.config.ts",
      `export default { version: 1 as const, sources: ["local:./skills"] };\n`,
    );
    const { manifest, writable, path } = await loadManifest({ root });
    expect(path).toBe(join(root, "outfitter.config.ts"));
    expect(writable).toBe(false);
    expect(manifest.sources).toEqual(["local:./skills"]);
  });

  test("prefers outfitter.config.ts over the YAML form", async () => {
    const root = await makeTempDir();
    await writeFileAt(root, "outfitter.config.yaml", "version: 1\n");
    await writeFileAt(root, "outfitter.config.ts", "export default { version: 1 };\n");
    expect(await findManifest(root)).toBe(join(root, "outfitter.config.ts"));
  });

  test("rejects an unknown version and unknown keys", async () => {
    const root = await makeTempDir();
    await writeFileAt(root, "outfitter.config.yaml", "version: 2\n");
    await expect(loadManifest({ root })).rejects.toThrow(ManifestError);

    const other = await makeTempDir();
    await writeFileAt(other, "outfitter.config.yaml", "version: 1\nsauces: []\n");
    await expect(loadManifest({ root: other })).rejects.toThrow(/sauces/);
  });

  test("rejects a missing explicit manifest path", async () => {
    const root = await makeTempDir();
    await expect(loadManifest({ root, manifest: "nope.yaml" })).rejects.toThrow(ManifestError);
  });
});

describe("writeManifest", () => {
  test("round-trips YAML", async () => {
    const root = await makeTempDir();
    const path = join(root, "outfitter.config.yaml");
    await writeManifest(path, {
      version: 1,
      sources: [{ ref: "github:a/b", select: ["x"] }],
      mcp: [{ name: "m", transport: "stdio", command: "npx" }],
    });
    const reloaded = await loadManifest({ root });
    expect(reloaded.manifest.sources).toEqual([{ ref: "github:a/b", select: ["x"] }]);
    expect(reloaded.manifest.mcp?.[0]?.name).toBe("m");
  });

  test("drops live target adapters, keeping named ones", async () => {
    const root = await makeTempDir();
    const path = join(root, "outfitter.config.json");
    await writeManifest(path, {
      version: 1,
      targets: ["codex", {
        name: "custom",
        supports: ["skill"],
        resolveDir: () => "",
        materialize: async () => ({ path: "" }),
      }],
      sources: [],
    });
    const written = JSON.parse(await readTextFile(path)) as { targets: string[] };
    expect(written.targets).toEqual(["codex"]);
  });

  test("refuses to write a TypeScript manifest", async () => {
    const root = await makeTempDir();
    await expect(writeManifest(join(root, "outfitter.config.ts"), { version: 1 })).rejects.toThrow(
      ManifestError,
    );
  });
});

describe("defineConfig", () => {
  test("is an identity helper", () => {
    const config = defineConfig({ version: 1, sources: ["local:./x"] });
    expect(config.sources).toEqual(["local:./x"]);
  });
});
