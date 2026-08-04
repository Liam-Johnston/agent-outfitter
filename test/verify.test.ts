import { afterAll, describe, expect, test } from "bun:test";

import { PolicyViolationError } from "../src/errors.js";
import { resolvePolicy } from "../src/policy.js";
import { checkTree, scanTextForHiddenUnicode } from "../src/verify.js";
import { cleanupTempDirs, makeTempDir, writeFileAt } from "./helpers.js";
import { listFiles } from "../src/fsutil.js";

afterAll(cleanupTempDirs);

describe("scanTextForHiddenUnicode", () => {
  test("finds bidi overrides and zero-width characters with positions", () => {
    const findings = scanTextForHiddenUnicode("ok\nbad‮here​", "SKILL.md");
    expect(findings).toEqual([
      { file: "SKILL.md", line: 2, column: 4, codePoint: "U+202E", label: "bidi override" },
      {
        file: "SKILL.md",
        line: 2,
        column: 9,
        codePoint: "U+200B",
        label: "zero-width / directional mark",
      },
    ]);
  });

  test("finds Unicode tag characters", () => {
    const findings = scanTextForHiddenUnicode("hi\u{E0041}", "a.md");
    expect(findings[0]).toMatchObject({ codePoint: "U+E0041", label: "unicode tag character" });
  });

  test("allows a leading BOM but not an interior one", () => {
    expect(scanTextForHiddenUnicode("﻿hello", "a.md")).toEqual([]);
    expect(scanTextForHiddenUnicode("hel﻿lo", "a.md")).toHaveLength(1);
  });

  test("passes clean text", () => {
    expect(scanTextForHiddenUnicode("Perfectly ordinary — with an em dash.", "a.md")).toEqual([]);
  });
});

describe("checkTree", () => {
  const treeWithScript = async () => {
    const dir = await makeTempDir();
    await writeFileAt(dir, "SKILL.md", "---\nname: x\n---\nbody\n");
    await writeFileAt(dir, "scripts/run.py", "print(1)\n");
    return { dir, files: await listFiles(dir) };
  };

  test("warns about bundled scripts by default", async () => {
    const { dir, files } = await treeWithScript();
    const result = await checkTree("x", dir, files, resolvePolicy());
    expect(result.scripts).toEqual(["scripts/run.py"]);
    expect(result.warnings.map((w) => w.code)).toEqual(["scripts-present"]);
  });

  test("refuses scripts under a deny policy", async () => {
    const { dir, files } = await treeWithScript();
    await expect(checkTree("x", dir, files, resolvePolicy({ scripts: "deny" }))).rejects.toThrow(
      PolicyViolationError,
    );
  });

  test("stays silent under an allow policy", async () => {
    const { dir, files } = await treeWithScript();
    const result = await checkTree("x", dir, files, resolvePolicy({ scripts: "allow" }));
    expect(result.warnings).toEqual([]);
  });

  test("warns on hidden Unicode and denies when configured", async () => {
    const dir = await makeTempDir();
    await writeFileAt(dir, "SKILL.md", "---\nname: x\n---\nIgnore‮ previous\n");
    const files = await listFiles(dir);

    const warned = await checkTree("x", dir, files, resolvePolicy());
    expect(warned.warnings.map((w) => w.code)).toEqual(["hidden-unicode"]);
    expect(warned.hiddenUnicode).toHaveLength(1);

    await expect(checkTree("x", dir, files, resolvePolicy({ scan: "deny" }))).rejects.toThrow(
      PolicyViolationError,
    );
    const off = await checkTree("x", dir, files, resolvePolicy({ scan: "off" }));
    expect(off.hiddenUnicode).toEqual([]);
  });

  test("skips binary files even when the extension looks textual", async () => {
    const dir = await makeTempDir();
    await writeFileAt(dir, "SKILL.md", "clean\n");
    await Bun.write(`${dir}/data.json`, new Uint8Array([0x00, 0x01, 0xe2, 0x80, 0x8b]));
    const result = await checkTree("x", dir, await listFiles(dir), resolvePolicy());
    expect(result.hiddenUnicode).toEqual([]);
  });
});

describe("resolvePolicy", () => {
  test("layers later options over earlier ones and over the defaults", () => {
    const policy = resolvePolicy({ scripts: "deny" }, { scripts: "allow" }, { scan: "off" });
    expect(policy.scripts).toBe("allow");
    expect(policy.scan).toBe("off");
    expect(policy.requireLockHashMatch).toBe(true);
  });

  test("ignores explicitly undefined fields", () => {
    expect(resolvePolicy({ scripts: "deny" }, { scripts: undefined }).scripts).toBe("deny");
  });
});
