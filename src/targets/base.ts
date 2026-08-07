/** Shared behaviour for targets that materialize skills onto a filesystem. */

import { dirname, isAbsolute, join, posix, resolve } from "node:path";

import { TargetError } from "../errors.js";
import { hashSubtrees, hashTree } from "../hash.js";
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
import { mergeSettings } from "../primitives/settings.js";
import { readIfExists, writeConfigIfChanged } from "./mcp-config.js";
import type {
  BundleMaterializeInput,
  BundleMaterializeOutput,
  InstructionWriteInput,
  InstructionWriteOutput,
  MaterializeInput,
  MaterializeOutput,
  ResolvedBundle,
  SettingsRemoveInput,
  SettingsWriteInput,
  SettingsWriteOutput,
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

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

/**
 * Copy each of a bundle's declared subtrees to its destination, atomically.
 *
 * Atomicity matters as much here as for a skill, and for the same reason applied
 * to a bigger blast radius: the agent scans these directories, and a half-written
 * engine is worse than an absent one. Each destination is staged beside itself and
 * renamed into place, and exec bits are re-derived because tarball extraction
 * drops file modes.
 *
 * `resolveDest` is the target's own rule for turning a declared relative path into
 * an absolute one, which is the only thing that differs between targets here.
 */
export const materializeBundlePaths = async (
  input: BundleMaterializeInput,
  resolveDest: (dest: string) => string,
): Promise<BundleMaterializeOutput> => {
  const out: Record<string, string> = {};

  for (const [sourcePath, dest] of Object.entries(input.bundle.paths)) {
    const from = sourcePath
      ? join(input.stagedDir, ...sourcePath.split(posix.sep))
      : input.stagedDir;
    const to = resolveDest(dest);
    try {
      await replaceDirAtomic(from, to);
    } catch (error) {
      throw new TargetError(
        `Failed to install bundle "${input.bundle.name}" path "${sourcePath || "."}" into ` +
          `${to}: ${(error as Error).message}`,
        { bundle: input.bundle.name, source: sourcePath, dest: to },
      );
    }
    await restoreExecBits(to);
    out[sourcePath] = to;
  }

  return { paths: out };
};

/**
 * Combined hash of a bundle's destinations, or `undefined` when any is missing.
 *
 * Hashed as one logical tree keyed by the *source* paths, which is what makes the
 * result comparable to the `contentHash` computed at resolve time even though the
 * files now live in several unrelated directories.
 */
export const installedBundleHash = async (
  bundle: ResolvedBundle,
  resolveDest: (dest: string) => string,
): Promise<string | undefined> => {
  const parts: { root: string; prefix: string }[] = [];
  for (const [sourcePath, dest] of Object.entries(bundle.paths)) {
    const abs = resolveDest(dest);
    if (!(await isDirectory(abs))) return undefined;
    parts.push({ root: abs, prefix: sourcePath });
  }
  if (parts.length === 0) return undefined;
  const { contentHash } = await hashSubtrees(parts);
  return contentHash;
};

export const unmaterializeBundlePaths = async (
  paths: Record<string, string>,
  resolveDest: (dest: string) => string,
): Promise<void> => {
  for (const dest of Object.values(paths)) {
    // Recorded destinations are already absolute; declared ones are not.
    const abs = isAbsolute(dest) ? dest : resolveDest(dest);
    if (await isDirectory(abs)) await removeDir(abs);
  }
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Merge settings fragments into a target's settings file.
 *
 * The mirror of `writeInstructionFile`, and the same discipline: read what is
 * there, merge only the keys we own, and write only when the bytes changed.
 */
export const writeSettingsFile = async (
  path: string,
  input: SettingsWriteInput,
): Promise<SettingsWriteOutput> => {
  const merged = mergeSettings(
    await readIfExists(path),
    input.settings,
    input.previouslyManaged,
    path,
  );
  for (const warning of merged.warnings) input.ctx.warn(warning);

  // An empty object means every owned key went away and nothing else was in the
  // file; leaving `{}` behind would be litter.
  if (merged.content.trim() === "{}") {
    await removeFile(path);
    return { path, written: [], owned: {} };
  }
  await ensureDir(dirname(path));
  await writeConfigIfChanged(path, merged.content);
  return { path, written: merged.written, owned: merged.owned };
};

export const removeSettingsFromFile = async (
  path: string,
  input: SettingsRemoveInput,
): Promise<void> => {
  const existing = await readIfExists(path);
  if (existing === undefined) return;
  const merged = mergeSettings(existing, [], input.previouslyManaged, path);
  for (const warning of merged.warnings) input.ctx.warn(warning);
  if (merged.content.trim() === "{}") {
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
