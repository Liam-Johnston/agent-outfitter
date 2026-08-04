/** Shared behaviour for targets that materialize skills onto a filesystem. */

import { isAbsolute, join, resolve } from "node:path";

import { TargetError } from "../errors.js";
import { hashTree } from "../hash.js";
import {
  expandTilde,
  isDirectory,
  pathExists,
  removeDir,
  replaceDirAtomic,
  restoreExecBits,
} from "../fsutil.js";
import type { MaterializeInput, MaterializeOutput, TargetContext } from "../types.js";

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

/** Resolve a configured directory: expand `~`, anchor relative paths at the manager root. */
export const resolveAgainstRoot = (ctx: TargetContext, path: string): string => {
  const expanded = expandTilde(path);
  return isAbsolute(expanded) ? expanded : resolve(ctx.root, expanded);
};
