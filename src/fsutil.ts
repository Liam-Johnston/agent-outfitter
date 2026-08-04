/** Filesystem helpers: directory walks, atomic writes/swaps, exec-bit restoration. */

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import {
  chmod,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";

/** Directories never carried into an installed skill. */
const IGNORED_DIRS = new Set([".git", ".github", "node_modules", ".DS_Store"]);

/** Expand a leading `~` to the current user's home directory. */
export const expandTilde = (p: string): string =>
  p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;

export const pathExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

export const isDirectory = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
};

export const isFile = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
};

/**
 * All files under `root`, as relative POSIX paths, sorted.
 *
 * Sorting is what makes the content hash reproducible across filesystems that
 * disagree about `readdir` ordering.
 */
export const listFiles = async (root: string): Promise<string[]> => {
  const out: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(relative(root, abs).split(sep).join(posix.sep));
      }
    }
  };

  await walk(root);
  return out.sort();
};

/** Immediate child directory names, sorted. */
export const listChildDirs = async (root: string): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
};

export const ensureDir = async (p: string): Promise<void> => {
  await mkdir(p, { recursive: true });
};

const tempSuffix = (): string => `.skillsmith-${randomBytes(6).toString("hex")}.tmp`;

/** Write a file by writing a sibling temp file and renaming over the target. */
export const writeFileAtomic = async (target: string, data: string | Uint8Array): Promise<void> => {
  await ensureDir(dirname(target));
  const tmp = `${target}${tempSuffix()}`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
};

/**
 * Replace `target` with a copy of `sourceDir`.
 *
 * The copy lands in a sibling temp directory first, so an interrupted copy can
 * never leave a half-written skill where the agent would discover it.
 */
export const replaceDirAtomic = async (sourceDir: string, target: string): Promise<void> => {
  await ensureDir(dirname(target));
  const staging = `${target}${tempSuffix()}`;
  const backup = `${target}${tempSuffix()}`;
  await rm(staging, { recursive: true, force: true });
  try {
    await cp(sourceDir, staging, { recursive: true, dereference: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const hadPrevious = await pathExists(target);
  if (hadPrevious) await rename(target, backup);
  try {
    await rename(staging, target);
  } catch (error) {
    if (hadPrevious) await rename(backup, target).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  if (hadPrevious) await rm(backup, { recursive: true, force: true }).catch(() => {});
};

export const removeDir = async (p: string): Promise<void> => {
  await rm(p, { recursive: true, force: true });
};

const startsWithShebang = async (p: string): Promise<boolean> => {
  let handle;
  try {
    handle = await open(p, "r");
    const buf = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buf, 0, 2, 0);
    return bytesRead === 2 && buf[0] === 0x23 && buf[1] === 0x21; // "#!"
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
};

/**
 * Restore the executable bit on bundled scripts.
 *
 * Tarball extraction (giget/nanotar) writes files with default permissions, so
 * the mode a skill author committed is lost in transit. Rather than trust the
 * archive, we re-derive intent: anything under `scripts/` or carrying a shebang
 * is made executable. That also keeps `contentHash` mode-independent, so a tree
 * fetched via tarball hashes identically to one cloned with git.
 *
 * Returns the relative paths that were made executable.
 */
export const restoreExecBits = async (dir: string, files?: string[]): Promise<string[]> => {
  const relPaths = files ?? (await listFiles(dir));
  const changed: string[] = [];
  for (const rel of relPaths) {
    const abs = join(dir, ...rel.split(posix.sep));
    const inScripts = rel === "scripts" || rel.startsWith("scripts/");
    if (!inScripts && !(await startsWithShebang(abs))) continue;
    try {
      const current = await stat(abs);
      const mode = current.mode | 0o111;
      if (mode !== current.mode) {
        await chmod(abs, mode);
      }
      changed.push(rel);
    } catch {
      // A file that vanished between listing and chmod is not worth failing on.
    }
  }
  return changed;
};

export const readTextFile = async (p: string): Promise<string> => readFile(p, "utf8");

export const readJsonFile = async <T>(p: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};
