/** Unit coverage for the marker-region merge that makes instruction installs idempotent. */

import { afterAll, describe, expect, test } from "bun:test";

import { SkillNotFoundError, SourceResolutionError } from "../src/errors.js";
import {
  beginMarker,
  discoverInstructions,
  endMarker,
  instructionNameFromPath,
  managedRegionNames,
  mergeInstructions,
  readRegion,
  renderRegion,
} from "../src/primitives/instruction.js";
import { cleanupTempDirs, makeTempDir, writeFileAt } from "./helpers.js";

afterAll(cleanupTempDirs);

const frag = (name: string, content: string) => ({ name, content });

describe("instructionNameFromPath", () => {
  test("strips a fragment extension, keeps other dots", () => {
    expect(instructionNameFromPath("house-style.md")).toBe("house-style");
    expect(instructionNameFromPath("a/b/tone.markdown")).toBe("tone");
    expect(instructionNameFromPath("notes.txt")).toBe("notes");
    expect(instructionNameFromPath("v1.2-rules.md")).toBe("v1.2-rules");
  });
});

describe("renderRegion", () => {
  test("wraps content in matched markers and normalizes trailing space", () => {
    expect(renderRegion(frag("x", "body\n\n"))).toBe(
      `${beginMarker("x")}\nbody\n${endMarker("x")}\n`,
    );
  });
});

describe("mergeInstructions", () => {
  test("appends into an empty document", () => {
    const { content, written } = mergeInstructions(undefined, [frag("a", "Alpha.")], []);
    expect(content).toBe(`${beginMarker("a")}\nAlpha.\n${endMarker("a")}\n`);
    expect(written).toEqual(["a"]);
  });

  test("preserves the user's own prose around a managed region", () => {
    const existing = "# My notes\n\nHand-written guidance.\n";
    const { content } = mergeInstructions(existing, [frag("a", "Alpha.")], []);
    expect(content.startsWith("# My notes\n\nHand-written guidance.\n")).toBe(true);
    expect(content).toContain(beginMarker("a"));
  });

  test("is idempotent: merging the same fragment twice changes nothing", () => {
    const once = mergeInstructions("# Notes\n", [frag("a", "Alpha.")], []).content;
    const twice = mergeInstructions(once, [frag("a", "Alpha.")], ["a"]).content;
    expect(twice).toBe(once);
  });

  test("replaces a changed fragment in place rather than appending", () => {
    const first = mergeInstructions(undefined, [frag("a", "Old.")], []).content;
    const second = mergeInstructions(first, [frag("a", "New.")], ["a"]).content;
    expect(second).toContain("New.");
    expect(second).not.toContain("Old.");
    expect(managedRegionNames(second)).toEqual(["a"]);
  });

  test("keeps a region where a human moved it", () => {
    const moved = [
      beginMarker("a"),
      "Old.",
      endMarker("a"),
      "",
      "# Trailing section the user added below",
      "",
    ].join("\n");
    const merged = mergeInstructions(moved, [frag("a", "New.")], ["a"]).content;
    expect(merged.indexOf(beginMarker("a"))).toBeLessThan(merged.indexOf("# Trailing section"));
    expect(merged).toContain("New.");
  });

  test("removes a previously managed fragment that is no longer wanted", () => {
    const both = mergeInstructions(
      "# Notes\n",
      [frag("a", "Alpha."), frag("b", "Beta.")],
      [],
    ).content;
    const pruned = mergeInstructions(both, [frag("a", "Alpha.")], ["a", "b"]).content;
    expect(managedRegionNames(pruned)).toEqual(["a"]);
    expect(pruned).not.toContain("Beta.");
    expect(pruned).toContain("# Notes");
  });

  test("never touches a region it does not manage", () => {
    const foreign = `<!-- BEGIN other-tool: x -->\nnot ours\n<!-- END other-tool: x -->\n`;
    const merged = mergeInstructions(foreign, [frag("a", "Alpha.")], ["a", "x"]).content;
    expect(merged).toContain("not ours");
  });

  test("collapses blank-line runs left by a removal", () => {
    const doc = mergeInstructions(
      "# Notes\n",
      [frag("a", "A."), frag("b", "B."), frag("c", "C.")],
      [],
    ).content;
    const pruned = mergeInstructions(doc, [frag("a", "A.")], ["a", "b", "c"]).content;
    expect(pruned).not.toMatch(/\n{3,}/);
  });

  test("empties out completely when the file held nothing else", () => {
    const only = mergeInstructions(undefined, [frag("a", "Alpha.")], []).content;
    const gone = mergeInstructions(only, [], ["a"]).content;
    expect(gone.trim()).toBe("");
  });

  test("multi-line and fenced content survives a round trip", () => {
    const body = "Line one.\n\n```ts\nconst x = 1;\n```\n\n- bullet";
    const merged = mergeInstructions(undefined, [frag("a", body)], []).content;
    expect(readRegion(merged, "a")).toBe(body);
  });
});

describe("managedRegionNames / readRegion", () => {
  test("lists regions in document order and reads bodies back", () => {
    const doc = mergeInstructions(undefined, [frag("a", "A."), frag("b", "B.")], []).content;
    expect(managedRegionNames(doc)).toEqual(["a", "b"]);
    expect(readRegion(doc, "b")).toBe("B.");
    expect(readRegion(doc, "absent")).toBeUndefined();
  });
});

describe("discoverInstructions", () => {
  test("reads a single file and derives its name", async () => {
    const root = await makeTempDir();
    await writeFileAt(root, "instructions/house-style.md", "Use British spelling.\n");
    const found = await discoverInstructions(root, "instructions/house-style.md", { ref: "x" }, "o");
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("house-style");
    expect(found[0]!.content).toBe("Use British spelling.\n");
    expect(found[0]!.subdir).toBe("instructions/house-style.md");
  });

  test("honours an explicit name for a single file", async () => {
    const root = await makeTempDir();
    await writeFileAt(root, "a.md", "x");
    const found = await discoverInstructions(root, "a.md", { ref: "x", name: "renamed" }, "o");
    expect(found[0]!.name).toBe("renamed");
  });

  test("reads every fragment in a directory, sorted", async () => {
    const root = await makeTempDir();
    await writeFileAt(root, "ins/tone.md", "Be terse.");
    await writeFileAt(root, "ins/house-style.md", "British spelling.");
    await writeFileAt(root, "ins/README.notes", "ignored, wrong extension");

    const found = await discoverInstructions(root, "ins", { ref: "x" }, "o");
    expect(found.map((f) => f.name)).toEqual(["house-style", "tone"]);
  });

  test("filters a directory by select", async () => {
    const root = await makeTempDir();
    await writeFileAt(root, "ins/tone.md", "a");
    await writeFileAt(root, "ins/house-style.md", "b");
    const found = await discoverInstructions(root, "ins", { ref: "x", select: "tone" }, "o");
    expect(found.map((f) => f.name)).toEqual(["tone"]);
  });

  test("rejects select on a single file, and name on a directory", async () => {
    const root = await makeTempDir();
    await writeFileAt(root, "one.md", "a");
    await writeFileAt(root, "dir/a.md", "a");

    await expect(
      discoverInstructions(root, "one.md", { ref: "x", select: "a" }, "o"),
    ).rejects.toThrow(SourceResolutionError);
    await expect(
      discoverInstructions(root, "dir", { ref: "x", name: "forced" }, "o"),
    ).rejects.toThrow(SourceResolutionError);
  });

  test("reports a select that matches nothing, and an empty directory", async () => {
    const root = await makeTempDir();
    await writeFileAt(root, "ins/a.md", "a");
    await writeFileAt(root, "empty/.keep", "");

    await expect(
      discoverInstructions(root, "ins", { ref: "x", select: "nope" }, "o"),
    ).rejects.toThrow(/matches \[nope\].*Available: a/s);
    await expect(discoverInstructions(root, "empty", { ref: "x" }, "o")).rejects.toThrow(
      SkillNotFoundError,
    );
    await expect(discoverInstructions(root, "missing", { ref: "x" }, "o")).rejects.toThrow(
      SkillNotFoundError,
    );
  });

  test("rejects a filename that is not a usable identifier", async () => {
    const root = await makeTempDir();
    await writeFileAt(root, "ins/-leading-dash.md", "a");
    await expect(discoverInstructions(root, "ins", { ref: "x" }, "o")).rejects.toThrow(
      SourceResolutionError,
    );
  });
});

describe("whitespace hygiene", () => {
  test("a removal leaves exactly one trailing newline", () => {
    const both = mergeInstructions("# Notes\n", [frag("a", "A."), frag("b", "B.")], []).content;
    const pruned = mergeInstructions(both, [frag("a", "A.")], ["a", "b"]).content;
    expect(pruned.endsWith("-->\n")).toBe(true);
    expect(pruned).not.toMatch(/\n\n$/);
  });

  test("a document always ends with a newline", () => {
    expect(mergeInstructions("no trailing newline", [frag("a", "A.")], []).content).toMatch(/\n$/);
  });
});
