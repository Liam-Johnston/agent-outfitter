import { afterAll, describe, expect, test } from "bun:test";
import { chmod, rename } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, hashCanonicalJson, hashTree, HASH_PREFIX } from "../src/hash.js";
import { cleanupTempDirs, makeTempDir, writeFileAt } from "./helpers.js";

afterAll(cleanupTempDirs);

describe("hashTree", () => {
  test("is stable across runs and independent of listing order", async () => {
    const a = await makeTempDir();
    await writeFileAt(a, "SKILL.md", "hello");
    await writeFileAt(a, "scripts/run.py", "print(1)");
    await writeFileAt(a, "references/notes.md", "notes");

    const first = await hashTree(a);
    const second = await hashTree(a, first.files.toReversed());

    expect(first.contentHash.startsWith(HASH_PREFIX)).toBe(true);
    expect(second.contentHash).toBe(first.contentHash);
    expect(first.files).toEqual(["SKILL.md", "references/notes.md", "scripts/run.py"]);
  });

  test("two trees with identical content hash identically", async () => {
    const a = await makeTempDir();
    const b = await makeTempDir();
    for (const dir of [a, b]) {
      await writeFileAt(dir, "SKILL.md", "hello");
      await writeFileAt(dir, "scripts/run.py", "print(1)");
    }
    expect((await hashTree(a)).contentHash).toBe((await hashTree(b)).contentHash);
  });

  test("changes when content changes", async () => {
    const dir = await makeTempDir();
    await writeFileAt(dir, "SKILL.md", "hello");
    const before = await hashTree(dir);
    await writeFileAt(dir, "SKILL.md", "hello!");
    expect((await hashTree(dir)).contentHash).not.toBe(before.contentHash);
  });

  test("changes when a file is renamed even if the bytes are unchanged", async () => {
    const dir = await makeTempDir();
    await writeFileAt(dir, "a.md", "same");
    const before = await hashTree(dir);
    await rename(join(dir, "a.md"), join(dir, "b.md"));
    expect((await hashTree(dir)).contentHash).not.toBe(before.contentHash);
  });

  test("ignores file modes, so tarball and clone fetches agree", async () => {
    const dir = await makeTempDir();
    const file = await writeFileAt(dir, "scripts/run.sh", "#!/bin/sh\necho hi\n");
    const before = await hashTree(dir);
    await chmod(file, 0o755);
    expect((await hashTree(dir)).contentHash).toBe(before.contentHash);
  });

  test("ignores .git and node_modules", async () => {
    const dir = await makeTempDir();
    await writeFileAt(dir, "SKILL.md", "hello");
    const before = await hashTree(dir);
    await writeFileAt(dir, ".git/config", "[core]");
    await writeFileAt(dir, "node_modules/pkg/index.js", "1");
    expect((await hashTree(dir)).contentHash).toBe(before.contentHash);
  });
});

describe("canonicalJson", () => {
  test("sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: 2, c: undefined })).toBe(`{"a":2,"b":1}`);
    expect(hashCanonicalJson({ a: 1, b: 2 })).toBe(hashCanonicalJson({ b: 2, a: 1 }));
  });

  test("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(hashCanonicalJson([1, 2])).not.toBe(hashCanonicalJson([2, 1]));
  });
});
