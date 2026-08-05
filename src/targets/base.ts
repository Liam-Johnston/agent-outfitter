/** Shared behaviour for targets that materialize skills onto a filesystem. */

import { dirname, isAbsolute, join, resolve } from "node:path";

import { TargetError } from "../errors.js";
import { hashTree } from "../hash.js";
import {
  ensureDir,
  expandTilde,
  isDirectory,
  pathExists,
  removeDir,
  removeFile,
  replaceDirAtomic,
  restoreExecBits,
} from "../fsutil.js";
import { defaultCacheDir } from "../paths.js";
import { mergeInstructions } from "../primitives/instruction.js";
import { readIfExists, writeConfigIfChanged } from "./mcp-config.js";
import type {
  InstructionWriteInput,
  InstructionWriteOutput,
  MaterializeInput,
  MaterializeOutput,
  TargetContext,
} from "../types.js";

/**
 * Copy a staged skill into `<skillsDir>/<name>`, atomically.
 *
 * The copy lands in a sibling temp directory and is renamed into place, so an
 * agent scanning the skills directory never observes a partial skill. Exec bits
 * are re-derived afterwards because tarball extraction drops file modes.
 */
export const materializeToDir = async (
  skillsDir: string,
  input: MaterializeInput,
): Promise<MaterializeOutput> => {
  const dest = join(skillsDir, input.skill.name);
  try {
    await replaceDirAtomic(input.stagedDir, dest);
  } catch (error) {
    throw new TargetError(
      `Failed to install skill "${input.skill.name}" into ${dest}: ${(error as Error).message}`,
      { skill: input.skill.name, dest },
    );
  }
  await restoreExecBits(dest, input.skill.files);
  return { path: dest };
};

export const unmaterializeFromDir = async (skillsDir: string, name: string): Promise<void> => {
  const dest = join(skillsDir, name);
  if (await isDirectory(dest)) await removeDir(dest);
};

/** Hash of what is currently installed, or `undefined` when nothing is. */
export const installedHash = async (
  skillsDir: string,
  name: string,
): Promise<string | undefined> => {
  const dest = join(skillsDir, name);
  if (!(await pathExists(dest))) return undefined;
  const { contentHash } = await hashTree(dest);
  return contentHash;
};

/**
 * Merge instruction fragments into a target's instruction file.
 *
 * Shared by every filesystem-backed target, because the only thing that differs
 * between Codex and Claude here is which filename the harness reads.
 */
export const writeInstructionFile = async (
  path: string,
  input: InstructionWriteInput,
): Promise<InstructionWriteOutput> => {
  const merged = mergeInstructions(
    await readIfExists(path),
    input.instructions,
    input.previouslyManaged,
  );
  // An empty result means every managed region was removed and nothing else was
  // in the file; leaving an empty file behind would be litter.
  if (merged.content.trim().length === 0) {
    await removeFile(path);
    return { path, written: [] };
  }
  await ensureDir(dirname(path));
  await writeConfigIfChanged(path, merged.content);
  return { path, written: merged.written };
};

export const removeInstructionsFromFile = async (
  path: string,
  names: readonly string[],
): Promise<void> => {
  const existing = await readIfExists(path);
  if (existing === undefined) return;
  const merged = mergeInstructions(existing, [], names);
  if (merged.content.trim().length === 0) {
    await removeFile(path);
    return;
  }
  await writeConfigIfChanged(path, merged.content);
};

/** Resolve a configured directory: expand `~`, anchor relative paths at the manager root. */
export const resolveAgainstRoot = (ctx: TargetContext, path: string): string => {
  const expanded = expandTilde(path);
  return isAbsolute(expanded) ? expanded : resolve(ctx.root, expanded);
};

export interface ContextCapture {
  /** Record the context the manager just handed this target. */
  capture(ctx: TargetContext): void;
  /** The context to resolve paths against: explicit, else last seen, else a default. */
  resolve(override?: TargetContext): TargetContext;
}

/**
 * Remembers the `TargetContext` a target last ran under.
 *
 * `sdkOptions()` must resolve the same paths the install resolved, and those
 * depend on the manager's root, which the caller of `sdkOptions()` has no
 * reason to reconstruct by hand. So each target records the context the manager
 * gave it and reuses that. The fallback applies only when `sdkOptions()` is
 * called before any install has run, and uses the same `cwd` default the manager
 * itself would have picked, so the two cannot disagree.
 */
export const createContextCapture = (): ContextCapture => {
  let last: TargetContext | undefined;
  return {
    capture: (ctx) => {
      last = ctx;
    },
    resolve: (override) =>
      override ??
      last ?? {
        root: process.cwd(),
        cacheDir: defaultCacheDir(),
        emit: () => {},
        warn: () => {},
      },
  };
};
