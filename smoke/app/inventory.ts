/**
 * A full listing of what actually landed on disk.
 *
 * Read by walking the filesystem rather than by reporting what `install()`
 * returned — the point is to be able to confirm the install's own account of
 * itself, so taking its word for the file list would defeat the exercise.
 *
 * Nothing is truncated. A long listing is the price of being able to look at the
 * output and see that a skill arrived whole, rather than inferring it from a
 * count.
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const DIM = "[2m";
const BOLD = "[1m";
const RESET = "[0m";

export interface FileEntry {
  /** Path relative to the directory the walk started from, POSIX-separated. */
  rel: string;
  bytes: number;
}

/** Every file under `root`, recursively, sorted by path. Directories are not listed. */
export const walkFiles = async (root: string): Promise<FileEntry[]> => {
  const out: FileEntry[] = [];

  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Missing directory: the caller's assertions will report it.
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(abs);
      } else if (entry.isFile()) {
        out.push({
          rel: relative(root, abs).split(sep).join("/"),
          bytes: (await stat(abs)).size,
        });
      }
    }
  };

  await visit(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const PAD = 62;

/**
 * Print one directory's files, grouped under their top-level folder.
 *
 * Grouping by first path segment is what makes a per-skill listing readable: the
 * skills directory holds one folder per skill, and the interesting question is
 * always "did *this* skill arrive complete", not "what is in the directory".
 */
export const printTree = (root: string, files: readonly FileEntry[]): void => {
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  const groups = new Map<string, FileEntry[]>();
  for (const file of files) {
    const [head] = file.rel.split("/");
    const key = head ?? file.rel;
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }

  console.log(
    `  ${BOLD}${root}${RESET} ${DIM}(${groups.size} entries, ${files.length} files, ` +
      `${formatBytes(total)})${RESET}`,
  );

  for (const [name, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const groupBytes = group.reduce((sum, f) => sum + f.bytes, 0);
    console.log(
      `    ${name}/ ${DIM}— ${group.length} files, ${formatBytes(groupBytes)}${RESET}`,
    );
    for (const file of group) {
      // Strip the group prefix; it is already the line above.
      const shown = file.rel.slice(name.length + 1) || file.rel;
      const pad = " ".repeat(Math.max(1, PAD - shown.length));
      console.log(`      ${shown}${pad}${DIM}${formatBytes(file.bytes)}${RESET}`);
    }
  }
};

/** Print a flat list of individual files, for config and instruction files. */
export const printFiles = async (label: string, paths: readonly string[]): Promise<void> => {
  console.log(`  ${BOLD}${label}${RESET}`);
  for (const path of paths) {
    let size: string;
    try {
      size = formatBytes((await stat(path)).size);
    } catch {
      size = "MISSING";
    }
    const pad = " ".repeat(Math.max(1, PAD + 4 - path.length));
    console.log(`    ${path}${pad}${DIM}${size}${RESET}`);
  }
};
