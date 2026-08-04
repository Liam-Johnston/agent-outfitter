import { afterAll, describe, expect, test } from "bun:test";

import { SourceResolutionError } from "../src/errors.js";
import { parseSkillMd, readSkillMd } from "../src/primitives/skill.js";
import { cleanupTempDirs, makeTempDir, skillMd, writeSkill } from "./helpers.js";

afterAll(cleanupTempDirs);

describe("parseSkillMd", () => {
  test("extracts name, description, and preserves unknown frontmatter in meta", () => {
    const parsed = parseSkillMd(
      skillMd({
        name: "csv-insights",
        description: "Summarize CSV files.",
        frontmatter: "license: MIT\nallowed-tools: [Read, Bash]",
      }),
      "SKILL.md",
    );
    expect(parsed.name).toBe("csv-insights");
    expect(parsed.description).toBe("Summarize CSV files.");
    expect(parsed.meta).toEqual({ license: "MIT", "allowed-tools": ["Read", "Bash"] });
    expect(parsed.body.trim()).toBe("Do the thing.");
  });

  test("handles a document with no frontmatter", () => {
    const parsed = parseSkillMd("# Just markdown\n", "SKILL.md");
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBe("");
    expect(parsed.dependencies).toEqual({ skills: [], mcp: [], unsupported: [] });
  });

  test("parses structured skill and mcp dependencies", () => {
    const parsed = parseSkillMd(
      skillMd({
        name: "csv-insights",
        frontmatter: [
          "dependencies:",
          "  skills:",
          "    - github:acme/agent-skills/skills/shared-csv-utils",
          "  mcp:",
          "    - name: csv-mcp",
          "      transport: stdio",
          "      command: npx",
          '      args: ["-y", "@acme/csv-mcp"]',
        ].join("\n"),
      }),
      "SKILL.md",
    );
    expect(parsed.dependencies.skills).toEqual([
      "github:acme/agent-skills/skills/shared-csv-utils",
    ]);
    expect(parsed.dependencies.mcp).toEqual([
      { name: "csv-mcp", transport: "stdio", command: "npx", args: ["-y", "@acme/csv-mcp"] },
    ]);
  });

  test("accepts a bare list of skill refs", () => {
    const parsed = parseSkillMd(
      skillMd({ name: "x", frontmatter: "dependencies:\n  - local:../shared" }),
      "SKILL.md",
    );
    expect(parsed.dependencies.skills).toEqual(["local:../shared"]);
  });

  test("infers the MCP transport from url or command", () => {
    const parsed = parseSkillMd(
      skillMd({
        name: "x",
        frontmatter: [
          "dependencies:",
          "  mcp:",
          "    - name: gh",
          "      url: https://api.githubcopilot.com/mcp/",
        ].join("\n"),
      }),
      "SKILL.md",
    );
    expect(parsed.dependencies.mcp[0]).toMatchObject({ transport: "http" });
  });

  test("records not-yet-supported primitive kinds instead of failing", () => {
    const parsed = parseSkillMd(
      skillMd({
        name: "x",
        frontmatter: "dependencies:\n  plugins:\n    - fancy-plugin\n  hooks:\n    - name: pre",
      }),
      "SKILL.md",
    );
    expect(parsed.dependencies.unsupported).toEqual([
      { kind: "plugin", name: "fancy-plugin" },
      { kind: "hook", name: "pre" },
    ]);
  });

  test("rejects a typo'd dependency key", () => {
    expect(() =>
      parseSkillMd(skillMd({ name: "x", frontmatter: "dependencies:\n  skillz: [a]" }), "SKILL.md"),
    ).toThrow(SourceResolutionError);
  });

  test("rejects invalid YAML and non-mapping frontmatter", () => {
    expect(() => parseSkillMd("---\n: :\n bad\n---\n", "SKILL.md")).toThrow(SourceResolutionError);
    expect(() => parseSkillMd("---\n- a\n- b\n---\n", "SKILL.md")).toThrow(SourceResolutionError);
  });
});

describe("readSkillMd", () => {
  test("falls back to the folder name when no name is declared", async () => {
    const root = await makeTempDir();
    const dir = await writeSkill(root, "pdf-extract", { description: "Extract." });
    const parsed = await readSkillMd(dir, "local:pdf-extract");
    expect(parsed.name).toBe("pdf-extract");
  });

  test("rejects a name that is not a safe directory segment", async () => {
    const root = await makeTempDir();
    const dir = await writeSkill(root, "bad", { name: "../escape" });
    await expect(readSkillMd(dir, "local:bad")).rejects.toThrow(SourceResolutionError);
  });
});
