/**
 * Instruction primitives: the `AGENTS.md` / `CLAUDE.md` layer.
 *
 * A skill is a folder the harness discovers; an instruction fragment is text
 * spliced into a file the harness always reads. That makes the merge, not the
 * copy, the whole problem: the target file belongs to the user, may already hold
 * their own prose, and must survive reinstalls and removals untouched outside
 * the regions we own.
 *
 * The mechanism is a marked region per fragment, in the manner of a tool
 * managing a block in a shell rc file:
 *
 * ```md
 * <!-- BEGIN agent-outfitter: house-style -->
 * ...fragment...
 * <!-- END agent-outfitter: house-style -->
 * ```
 *
 * Which makes reinstall idempotent (replace in place), removal surgical (drop
 * one region), and hand-editing safe (anything outside a region is untouchable).
 */

import { basename, join, posix } from "node:path";

import { SkillNotFoundError, SourceResolutionError } from "../errors.js";
import { isDirectory, isFile, listFiles, readTextFile } from "../fsutil.js";
import { matchesAny, unmatchedPatterns } from "../glob.js";
import { hashString } from "../hash.js";
import type { Instruction, InstructionRefEntry, ResolvedInstruction } from "../types.js";

export const MARKER_TAG = "agent-outfitter";

/** Extensions treated as instruction fragments when scanning a directory. */
const FRAGMENT_EXTENSIONS = [".md", ".markdown", ".txt"];

/** A fragment name must be safe to embed in a marker and match on later. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const assertValidInstructionName = (name: string, origin: string): void => {
  if (!NAME_RE.test(name)) {
    throw new SourceResolutionError(
      `Instruction name "${name}" (${origin}) is not usable as an identifier. Use letters, ` +
        `digits, ".", "_", or "-", starting with a letter or digit.`,
      { name, origin },
    );
  }
};

/** Derive a fragment name from its filename: `house-style.md` -> `house-style`. */
export const instructionNameFromPath = (relPath: string): string => {
  const base = basename(relPath);
  for (const ext of FRAGMENT_EXTENSIONS) {
    if (base.toLowerCase().endsWith(ext)) return base.slice(0, -ext.length);
  }
  return base;
};

export const hashInstruction = (content: string): string => hashString(content);

export interface DiscoveredInstruction extends Instruction {
  /** Path of the fragment file relative to the repo root, POSIX-separated. */
  subdir: string;
}

/**
 * Locate instruction fragments in a materialized tree.
 *
 * `baseSubdir` may address a single file or a directory of fragments. A single
 * file may be renamed via `entry.name`; a directory is filtered by `select`
 * against both the filename and the derived fragment name.
 */
export const discoverInstructions = async (
  treeRoot: string,
  baseSubdir: string,
  entry: InstructionRefEntry,
  origin: string,
): Promise<DiscoveredInstruction[]> => {
  const rel = baseSubdir.replace(/^\/+|\/+$/g, "");
  const abs = rel ? join(treeRoot, ...rel.split("/")) : treeRoot;
  const select = entry.select
    ? Array.isArray(entry.select)
      ? entry.select
      : [entry.select]
    : undefined;

  if (await isFile(abs)) {
    if (entry.select) {
      throw new SourceResolutionError(
        `${origin} points at a single file, so "select" does not apply. Drop "select", or point ` +
          `the ref at a directory of fragments.`,
        { origin },
      );
    }
    const name = entry.name ?? instructionNameFromPath(rel || basename(abs));
    assertValidInstructionName(name, origin);
    return [{ name, content: await readTextFile(abs), subdir: rel }];
  }

  if (!(await isDirectory(abs))) {
    throw new SkillNotFoundError(
      `No instruction fragment at ${origin}. Expected a markdown file, or a directory ` +
        `containing one or more.`,
      { origin, subdir: rel },
    );
  }

  if (entry.name) {
    throw new SourceResolutionError(
      `${origin} points at a directory, which yields several fragments, so "name" is ambiguous. ` +
        `Use "select" to choose files, or point the ref at one file.`,
      { origin },
    );
  }

  // Only the directory's own files: nesting would make names ambiguous.
  const files = (await listFiles(abs)).filter(
    (f) => !f.includes(posix.sep) && FRAGMENT_EXTENSIONS.some((e) => f.toLowerCase().endsWith(e)),
  );

  if (files.length === 0) {
    throw new SkillNotFoundError(
      `No instruction fragments found in ${origin}. Expected files ending in ` +
        `${FRAGMENT_EXTENSIONS.join(", ")}.`,
      { origin, subdir: rel },
    );
  }

  const found: DiscoveredInstruction[] = [];
  const names: string[] = [];
  for (const file of files) {
    const name = instructionNameFromPath(file);
    names.push(name);
    if (!matchesAny(name, select) && !matchesAny(file, select)) continue;
    assertValidInstructionName(name, `${origin}/${file}`);
    found.push({
      name,
      content: await readTextFile(join(abs, file)),
      subdir: rel ? `${rel}/${file}` : file,
    });
  }

  const missed = unmatchedPatterns([...names, ...files], select);
  if (missed.length > 0) {
    throw new SkillNotFoundError(
      `No instruction fragment in ${origin} matches [${missed.join(", ")}]. ` +
        `Available: ${names.join(", ")}.`,
      { origin, missed, available: names },
    );
  }

  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

// ---------------------------------------------------------------------------
// Marker-region merge
// ---------------------------------------------------------------------------

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const beginMarker = (name: string): string => `<!-- BEGIN ${MARKER_TAG}: ${name} -->`;
export const endMarker = (name: string): string => `<!-- END ${MARKER_TAG}: ${name} -->`;

/** Matches one managed region, including the trailing newline it owns. */
const regionRegExp = (name: string): RegExp =>
  new RegExp(
    `[ \\t]*${escapeRegExp(beginMarker(name))}[\\s\\S]*?${escapeRegExp(endMarker(name))}[ \\t]*\\r?\\n?`,
    "g",
  );

export const renderRegion = (instruction: Instruction): string =>
  `${beginMarker(instruction.name)}\n${instruction.content.replace(/\s*$/, "")}\n${endMarker(instruction.name)}\n`;

/** Names of every managed region present in a document, in order. */
export const managedRegionNames = (document: string): string[] => {
  const re = new RegExp(`<!--\\s*BEGIN ${escapeRegExp(MARKER_TAG)}:\\s*(\\S+?)\\s*-->`, "g");
  const names: string[] = [];
  for (const match of document.matchAll(re)) {
    if (match[1]) names.push(match[1]);
  }
  return names;
};

/** Extract a managed region's body, or `undefined` when it is absent. */
export const readRegion = (document: string, name: string): string | undefined => {
  const re = new RegExp(
    `${escapeRegExp(beginMarker(name))}\\r?\\n([\\s\\S]*?)\\r?\\n?${escapeRegExp(endMarker(name))}`,
  );
  return re.exec(document)?.[1];
};

export interface InstructionMergeResult {
  content: string;
  written: string[];
}

/**
 * Merge fragments into a document.
 *
 * Existing regions are replaced where they already sit, so a human who moved a
 * block keeps their ordering. New regions append. Regions named in
 * `previouslyManaged` but no longer wanted are deleted. Everything outside a
 * managed region is preserved byte for byte.
 */
export const mergeInstructions = (
  existing: string | undefined,
  instructions: readonly Instruction[],
  previouslyManaged: readonly string[],
): InstructionMergeResult => {
  let document = existing ?? "";
  const desired = new Set(instructions.map((i) => i.name));

  for (const name of previouslyManaged) {
    if (!desired.has(name)) document = document.replace(regionRegExp(name), "");
  }

  const append: string[] = [];
  for (const instruction of instructions) {
    const region = renderRegion(instruction);
    const re = regionRegExp(instruction.name);
    if (re.test(document)) {
      // Replace in place: a moved block keeps the position its author chose.
      document = document.replace(regionRegExp(instruction.name), region);
    } else {
      append.push(region);
    }
  }

  if (append.length > 0) {
    const separator = document.length === 0 || document.endsWith("\n\n") ? "" : document.endsWith("\n") ? "\n" : "\n\n";
    document = `${document}${separator}${append.join("\n")}`;
  }

  // Collapse runs of blank lines left behind by removals: three or more
  // newlines become two, and the file ends with exactly one.
  document = document.replace(/\n{3,}/g, "\n\n");
  if (document.length > 0) document = `${document.replace(/\n+$/, "")}\n`;

  return { content: document, written: instructions.map((i) => i.name) };
};

/** Build a `ResolvedInstruction` from a discovered fragment. */
export const resolveInstruction = (
  found: DiscoveredInstruction,
  meta: Omit<ResolvedInstruction, keyof DiscoveredInstruction | "contentHash">,
): ResolvedInstruction => ({
  ...found,
  ...meta,
  contentHash: hashInstruction(found.content),
});
