/**
 * Tree fetching: who downloads, how often, and what happens to bytes that will
 * not decode.
 *
 * The case these pin is the one that took a container down. A manifest that
 * selects three skills from one repository is three entries in the lockfile,
 * and `sync()` resolves them concurrently, but all three name the same commit,
 * so all three resolve to the same cache destination and, inside giget, to the
 * same tarball path. Downloading onto one file from three tasks at once
 * produces an archive of exactly the right length whose middle is interleaved
 * garbage, and the only symptom is a zlib error naming whichever skill lost the
 * race. A warm cache hides it completely, so it only ever appeared in
 * cold-cache containers.
 *
 * `giget` is mocked rather than a server started: what is under test is how
 * many times the downloader is called and with what left on disk, not the
 * download itself.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cleanupTempDirs, makeTempDir } from "./helpers.js";
import { pathExists } from "../src/fsutil.js";
import type { PrimitiveSource } from "../src/types.js";

interface DownloadOptions {
  dir: string;
}

type Download = (input: string, options: DownloadOptions) => Promise<unknown>;

/** Swapped per test; the factory below is registered once and reads it live. */
let download: Download = async () => {
  throw new Error("no download installed for this test");
};

mock.module("giget", () => ({
  downloadTemplate: (input: string, options: DownloadOptions) => download(input, options),
}));

// Imported after the mock is registered, so the binding it closes over is ours.
const { fetchRepoTree } = await import("../src/fetch.js");

const source: PrimitiveSource = {
  type: "git",
  url: "https://github.com/acme/skills.git",
  ref: "main",
};

const COMMIT = "f6656c1256d5a8adfa37db9110046ef20bac644c";

/** The name giget derives from the source above, and therefore its cache folder. */
const TEMPLATE_NAME = "github-com-acme-skills";

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await makeTempDir("agent-outfitter-fetch-");
});

afterEach(async () => {
  await cleanupTempDirs();
});

/** A downloader that records its calls and writes a plausible tree. */
const recordingDownload = (
  onCall?: (n: number) => Promise<void> | void,
): { calls: () => number; fn: Download } => {
  let calls = 0;
  return {
    calls: () => calls,
    fn: async (_input, options) => {
      calls += 1;
      await onCall?.(calls);
      // A real extraction is slow enough that concurrent callers overlap; the
      // sleep makes that true here rather than by luck of the scheduler.
      await Bun.sleep(20);
      await mkdir(options.dir, { recursive: true });
      await writeFile(join(options.dir, "SKILL.md"), "---\nname: demo\n---\n");
      return { dir: options.dir };
    },
  };
};

describe("fetchRepoTree concurrency", () => {
  test("three callers wanting the same tree produce one download", async () => {
    const recorder = recordingDownload();
    download = recorder.fn;

    const trees = await Promise.all(
      ["skills/pdf", "skills/xlsx", "skills/mcp-builder"].map((subdir) =>
        fetchRepoTree({ ...source, subdir }, COMMIT, { cacheDir }),
      ),
    );

    // The whole bug in one assertion: three lockfile entries, one download.
    expect(recorder.calls()).toBe(1);
    // And one tree, since the subdir is applied by the caller, not here.
    expect(new Set(trees).size).toBe(1);
    expect(await pathExists(join(trees[0]!, "SKILL.md"))).toBe(true);
    expect(await pathExists(`${trees[0]!}.complete`)).toBe(true);
  });

  test("a later caller reads the cache instead of downloading again", async () => {
    const recorder = recordingDownload();
    download = recorder.fn;

    const first = await fetchRepoTree(source, COMMIT, { cacheDir });
    const second = await fetchRepoTree(source, COMMIT, { cacheDir });

    expect(second).toBe(first);
    expect(recorder.calls()).toBe(1);
  });

  test("different commits are different trees and do not share a fetch", async () => {
    const recorder = recordingDownload();
    download = recorder.fn;

    const other = "0123456789abcdef0123456789abcdef01234567";
    const [a, b] = await Promise.all([
      fetchRepoTree(source, COMMIT, { cacheDir }),
      fetchRepoTree(source, other, { cacheDir }),
    ]);

    expect(a).not.toBe(b);
    expect(recorder.calls()).toBe(2);
  });

  test("a failed fetch is not left behind for the next caller to join", async () => {
    const recorder = recordingDownload((n) => {
      if (n === 1) throw new Error("upstream said no");
    });
    download = recorder.fn;

    await expect(fetchRepoTree(source, COMMIT, { cacheDir, maxAttempts: 1 })).rejects.toThrow();
    // A joinable entry that outlived its failure would hand this caller the
    // same rejection without ever retrying.
    const tree = await fetchRepoTree(source, COMMIT, { cacheDir, maxAttempts: 1 });

    expect(recorder.calls()).toBe(2);
    expect(await pathExists(join(tree, "SKILL.md"))).toBe(true);
  });
});

describe("fetchRepoTree on a corrupt archive", () => {
  const realXdg = process.env.XDG_CACHE_HOME;
  afterEach(() => {
    if (realXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = realXdg;
  });

  // The tarball path is giget's, and on Windows it lives under the temp dir
  // rather than the cache home, so the env var below would not redirect it.
  const onWindows = process.platform === "win32";

  test.skipIf(onWindows)("retries, and drops the archive that would not decode", async () => {
    const xdg = await makeTempDir("agent-outfitter-xdg-");
    process.env.XDG_CACHE_HOME = xdg;

    // Stand in for the download giget cached last time and would reuse: while
    // this file is on disk with a matching etag, giget never refetches, so a
    // retry that leaves it in place reads the same corruption forever.
    const tarball = join(xdg, "giget", "outfitter", TEMPLATE_NAME, `${COMMIT}.tar.gz`);
    await mkdir(join(xdg, "giget", "outfitter", TEMPLATE_NAME), { recursive: true });
    await writeFile(tarball, "not actually gzip");
    await writeFile(`${tarball}.json`, `{"etag":"W/\\"stale\\""}`);

    const recorder = recordingDownload((n) => {
      if (n === 1) throw new Error("zlib: too many length or distance symbols");
    });
    download = recorder.fn;

    const retries: string[] = [];
    const tree = await fetchRepoTree(source, COMMIT, {
      cacheDir,
      maxAttempts: 3,
      onRetry: ({ reason }) => retries.push(reason),
    });

    expect(recorder.calls()).toBe(2);
    expect(retries).toEqual(["zlib: too many length or distance symbols"]);
    expect(await pathExists(tarball)).toBe(false);
    expect(await pathExists(`${tarball}.json`)).toBe(false);
    expect(await pathExists(join(tree, "SKILL.md"))).toBe(true);
  });

  test("gives up with the decode error named, once the budget is spent", async () => {
    const recorder = recordingDownload((n) => {
      throw new Error(`zlib: too many length or distance symbols (${n})`);
    });
    download = recorder.fn;

    await expect(fetchRepoTree(source, COMMIT, { cacheDir, maxAttempts: 2 })).rejects.toThrow(
      /after 2 attempts: zlib/,
    );
    expect(recorder.calls()).toBe(2);
  });
});
