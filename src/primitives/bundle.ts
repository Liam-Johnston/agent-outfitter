/**
 * Bundle primitives: opaque subtrees installed verbatim.
 *
 * A skill announces itself. It has a `SKILL.md`, a name, a description, and
 * frontmatter that can declare dependencies, so agent-outfitter can find one by
 * probing and decide where it goes. A committed-harness framework announces
 * nothing: `tools/`, `knowledge/`, `hooks/`, a stage protocol. Those are just
 * directories, and the harness that reads them knows their paths by convention.
 *
 * So a bundle is *declared*, not discovered: the manifest states which subtrees
 * to copy and where to put them. That buys the ability to install a framework
 * whole, and costs the things discovery paid for. A bundle cannot be selected by
 * glob, cannot be a dependency edge, and cannot be pulled in by a skill.
 *
 * Nothing here executes anything. Files are copied and hashed, and the harness
 * compiles itself on first use if it needs to.
 */

import { join, posix } from "node:path";

import { SkillNotFoundError, SourceResolutionError } from "../errors.js";
import { isDirectory, listFiles } from "../fsutil.js";
import { hashSubtrees, hashTree } from "../hash.js";
import { sourceRepoPath } from "../refs.js";
import type { BundlePaths, PrimitiveSource } from "../types.js";

/** Source-path spellings that address the tree root. */
const ROOT_ALIASES = new Set(["", ".", "./"]);

/**
 * Canonical form of a declared path: POSIX separators, no leading `./`, no
 * trailing slash. The tree root normalizes to `""`.
 */
export const normalizeBundlePath = (path: string): string => {
  const posixed = path.split("\\").join(posix.sep);
  if (ROOT_ALIASES.has(posixed)) return "";
  return posixed.replace(/^\.\//, "").replace(/\/+$/, "");
};

export const normalizeBundlePaths = (paths: BundlePaths): BundlePaths => {
  const out: BundlePaths = {};
  for (const [source, dest] of Object.entries(paths)) {
    out[normalizeBundlePath(source)] = normalizeBundlePath(dest);
  }
  return out;
};

/**
 * Derive a bundle's name from its source: the repository (or folder) name.
 *
 * A bundle has no frontmatter to carry a name, and its destination paths are the
 * wrong thing to name it after, since there are several of them. The repository
 * is what an operator would call it.
 */
export const bundleNameFromSource = (source: PrimitiveSource): string => {
  const path = source.type === "local" ? source.path : (sourceRepoPath(source) ?? source.url);
  const leaf = path
    .split(/[/\\]/)
    .filter((segment) => segment.length > 0 && segment !== ".")
    .pop();
  if (!leaf) {
    throw new SourceResolutionError(
      `Could not derive a name for the bundle at ${path}. Give the manifest entry an explicit ` +
        `"name".`,
      { path },
    );
  }
  return leaf.replace(/\.git$/, "");
};

export interface StagedBundle {
  /** Every file the bundle installs, relative to the staged root. */
  files: string[];
  /** Hash over every file in every declared subtree. */
  contentHash: string;
  /** Per-source-path hash, so each destination can be verified on its own. */
  pathHashes: Record<string, string>;
}

/**
 * Read a bundle's declared subtrees out of a staged source tree.
 *
 * Every declared source path must exist and be a directory. A missing one is a
 * hard failure rather than a warning: a harness installed with a hole in it
 * produces skills that fail on first invocation, which is a far worse outcome
 * than refusing the install.
 */
export const stageBundle = async (
  base: string,
  paths: BundlePaths,
  origin: string,
): Promise<StagedBundle> => {
  const normalized = normalizeBundlePaths(paths);
  const parts: { root: string; prefix: string }[] = [];
  const pathHashes: Record<string, string> = {};

  for (const sourcePath of Object.keys(normalized).sort()) {
    const abs = sourcePath ? join(base, ...sourcePath.split(posix.sep)) : base;
    if (!(await isDirectory(abs))) {
      throw new SkillNotFoundError(
        `Bundle ${origin} declares the path "${sourcePath || "."}", which is not a directory ` +
          `in the source. Check the ref's subdir and the spelling of the path.`,
        { origin, path: sourcePath },
      );
    }
    parts.push({ root: abs, prefix: sourcePath });
    const { contentHash } = await hashTree(abs, await listFiles(abs));
    pathHashes[sourcePath] = contentHash;
  }

  const { contentHash, files } = await hashSubtrees(parts);
  return { files, contentHash, pathHashes };
};

/**
 * Refuse two bundles that would write to the same place.
 *
 * Skills that collide only *might* be a mistake, so they warn and the first wins.
 * A destination collision cannot be resolved that way: both bundles were told
 * exactly where to write, and whichever ran second would silently replace the
 * other's tree. There is no first-wins reading of that which is not a lie.
 */
export const assertBundleDestinationsDistinct = (
  bundles: Iterable<{ name: string; paths: BundlePaths }>,
): void => {
  const claimed = new Map<string, { bundle: string; source: string }>();
  for (const bundle of bundles) {
    for (const [source, dest] of Object.entries(normalizeBundlePaths(bundle.paths))) {
      const existing = claimed.get(dest);
      if (existing) {
        throw new SourceResolutionError(
          `Bundles "${existing.bundle}" and "${bundle.name}" both install to "${dest}". A bundle ` +
            `writes to a declared path, so two claims on one destination would mean one silently ` +
            `replacing the other. Give them separate destinations.`,
          { destination: dest, bundles: [existing.bundle, bundle.name] },
        );
      }
      claimed.set(dest, { bundle: bundle.name, source });
    }
  }
};
