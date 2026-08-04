/**
 * Source-provider plugin surface, plus the commit-pinning behaviour that makes
 * a lockfile reproducible.
 *
 * The fixture provider stands in for a mirror or artifact store: it answers with
 * a *fixed* commit while the tree behind it can change, which is exactly the
 * condition `install()` must refuse.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { HashMismatchError, SourceResolutionError } from "../src/errors.js";
import { parseRefAdvertisement, parsePktLines, selectRefCommit } from "../src/fetch.js";
import { createAgentManager } from "../src/manager.js";
import { readLockfile } from "../src/lockfile.js";
import { selectProvider, type SourceProvider } from "../src/sources/index.js";
import { filesystemTarget } from "../src/targets/index.js";
import { cleanupTempDirs, makeTempDir, writeSkillRepo } from "./helpers.js";

afterAll(cleanupTempDirs);

const FIXED_COMMIT = "a".repeat(40);

/** Serves a local directory as if it were a git repo pinned to one commit. */
const fixtureProvider = (treeRoot: string, commit = FIXED_COMMIT): SourceProvider => ({
  name: "fixture",
  supports: (source) => source.type === "git" && source.url.includes("fixture.test"),
  resolveRevision: async () => commit,
  materializeTree: async () => treeRoot,
});

describe("provider selection", () => {
  test("a custom provider takes precedence over the built-ins", () => {
    const custom = fixtureProvider("/tmp/x");
    const source = { type: "git" as const, url: "https://fixture.test/a/b.git" };
    expect(selectProvider(source, [custom]).name).toBe("fixture");
    expect(selectProvider({ type: "git", url: "https://github.com/a/b.git" }, [custom]).name).toBe(
      "git",
    );
  });

  test("an unhandled source type is reported clearly", () => {
    expect(() =>
      selectProvider({ type: "svn" } as never, []),
    ).toThrow(SourceResolutionError);
  });
});

describe("commit pinning", () => {
  const setup = async (commit = FIXED_COMMIT) => {
    const base = await makeTempDir();
    const repo = join(base, "repo");
    const root = join(base, "project");
    await writeSkillRepo(repo, { a: { description: "One." } });

    const manager = createAgentManager({
      root,
      cacheDir: join(base, "cache"),
      sources: [fixtureProvider(repo, commit)],
      targets: [filesystemTarget({ dir: "installed" })],
    });
    return { base, repo, root, manager };
  };

  test("records the resolved commit in the lockfile", async () => {
    const { root, manager } = await setup();
    await manager.install({ refs: ["git:https://fixture.test/acme/skills.git#v1.0.0"] });

    const lock = await readLockfile(root);
    expect(lock!.skills.a!.commit).toBe(FIXED_COMMIT);
    expect(lock!.skills.a!.ref).toBe("v1.0.0");
    expect(lock!.skills.a!.source).toMatchObject({
      type: "git",
      url: "https://fixture.test/acme/skills.git",
      subdir: "skills/a",
    });
  });

  test("refuses an install whose bytes changed under an unchanged commit", async () => {
    const { repo, manager } = await setup();
    const refs = ["git:https://fixture.test/acme/skills.git#v1.0.0"];
    await manager.install({ refs });

    // Same commit, different content: a mirror moved the bytes behind a pin.
    await writeSkillRepo(repo, { a: { description: "Swapped." } });
    await expect(manager.install({ refs })).rejects.toThrow(HashMismatchError);
  });

  test("a new commit is an ordinary upgrade", async () => {
    const first = await setup();
    const refs = ["git:https://fixture.test/acme/skills.git#v1.0.0"];
    await first.manager.install({ refs });

    await writeSkillRepo(first.repo, { a: { description: "Version two." } });
    const upgraded = createAgentManager({
      root: first.root,
      cacheDir: join(first.base, "cache"),
      sources: [fixtureProvider(first.repo, "b".repeat(40))],
      targets: [filesystemTarget({ dir: "installed" })],
    });

    const result = await upgraded.install({ refs });
    expect(result.installed.map((s) => s.name)).toEqual(["a"]);
    expect((await readLockfile(first.root))!.skills.a!.commit).toBe("b".repeat(40));
  });

  test("requireLockHashMatch: false allows the swap through", async () => {
    const { base, repo, root } = await setup();
    const refs = ["git:https://fixture.test/acme/skills.git#v1.0.0"];
    const lax = createAgentManager({
      root,
      cacheDir: join(base, "cache"),
      sources: [fixtureProvider(repo)],
      targets: [filesystemTarget({ dir: "installed" })],
      policy: { requireLockHashMatch: false },
    });
    await lax.install({ refs });
    await writeSkillRepo(repo, { a: { description: "Swapped." } });
    await expect(lax.install({ refs })).resolves.toBeDefined();
  });
});

describe("git smart-HTTP ref parsing", () => {
  const pkt = (line: string): string =>
    `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;

  test("parses pkt-line framing and skips flush packets", () => {
    const payload = `${pkt("# service=git-upload-pack\n")}0000${pkt("first\n")}${pkt("second\n")}`;
    expect(parsePktLines(payload)).toEqual(["# service=git-upload-pack", "first", "second"]);
  });

  test("builds a ref map, ignoring the capability list", () => {
    const sha = "1".repeat(40);
    const payload =
      `${pkt("# service=git-upload-pack\n")}0000` +
      `${pkt(`${sha} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`)}` +
      `${pkt(`${"2".repeat(40)} refs/heads/main\n`)}` +
      `${pkt(`${"3".repeat(40)} refs/tags/v1\n`)}` +
      `${pkt(`${"4".repeat(40)} refs/tags/v1^{}\n`)}`;

    const refs = parseRefAdvertisement(payload);
    expect(refs.get("HEAD")).toBe(sha);
    expect(refs.get("refs/heads/main")).toBe("2".repeat(40));
  });

  test("prefers the peeled commit of an annotated tag", () => {
    const refs = new Map([
      ["refs/tags/v1", "3".repeat(40)],
      ["refs/tags/v1^{}", "4".repeat(40)],
      ["refs/heads/main", "2".repeat(40)],
      ["HEAD", "1".repeat(40)],
    ]);
    expect(selectRefCommit(refs, "v1")).toBe("4".repeat(40));
    expect(selectRefCommit(refs, "main")).toBe("2".repeat(40));
    expect(selectRefCommit(refs, undefined)).toBe("1".repeat(40));
    expect(selectRefCommit(refs, "nope")).toBeUndefined();
  });

  test("falls back to main or master when HEAD is absent", () => {
    expect(selectRefCommit(new Map([["refs/heads/master", "9".repeat(40)]]), undefined)).toBe(
      "9".repeat(40),
    );
  });
});
