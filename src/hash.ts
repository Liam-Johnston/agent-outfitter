/**
 * Content hashing.
 *
 * `contentHash` is a sha256 over a canonical serialization of a skill tree:
 * for every file, sorted by relative POSIX path, we absorb the path, the byte
 * length, and the bytes, each length-delimited. Length prefixes prevent a file
 * rename from colliding with a content change.
 *
 * Deliberately excluded: file modes, timestamps, and directory entries. Tarball
 * extraction does not preserve modes, so including them would make the hash
 * depend on *how* a tree was fetched rather than *what* it contains.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { listFiles } from "./fsutil.js";

export const HASH_PREFIX = "sha256-";

const encoder = new TextEncoder();

export const hashString = (value: string): string =>
  HASH_PREFIX + createHash("sha256").update(value, "utf8").digest("hex");

/** Stable hash of an arbitrary JSON-serializable value (object keys sorted). */
export const hashCanonicalJson = (value: unknown): string =>
  hashString(canonicalJson(value));

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
};

/**
 * Hash a directory tree.
 *
 * Pass `files` when the caller already listed them, to avoid a second walk.
 */
export const hashTree = async (
  root: string,
  files?: string[],
): Promise<{ contentHash: string; files: string[] }> => {
  const relPaths = (files ?? (await listFiles(root))).slice().sort();
  const hash = createHash("sha256");
  for (const rel of relPaths) {
    const bytes = await readFile(join(root, ...rel.split(posix.sep)));
    const header = encoder.encode(`${rel}\0${bytes.byteLength}\0`);
    hash.update(header);
    hash.update(bytes);
  }
  return { contentHash: HASH_PREFIX + hash.digest("hex"), files: relPaths };
};

/**
 * Hash several directory subtrees as one logical tree.
 *
 * Each part contributes its files under `prefix`, and the combined list is sorted
 * globally before hashing, so the result is identical to `hashTree` over a single
 * root that happens to contain those same subtrees. That equivalence is what lets
 * a bundle's hash be computed from its staged source and then re-checked against
 * destinations scattered across a project.
 */
export const hashSubtrees = async (
  parts: readonly { root: string; prefix: string }[],
): Promise<{ contentHash: string; files: string[] }> => {
  const entries: { rel: string; abs: string }[] = [];
  for (const part of parts) {
    for (const rel of await listFiles(part.root)) {
      entries.push({
        rel: part.prefix ? `${part.prefix}/${rel}` : rel,
        abs: join(part.root, ...rel.split(posix.sep)),
      });
    }
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const hash = createHash("sha256");
  for (const entry of entries) {
    const bytes = await readFile(entry.abs);
    hash.update(encoder.encode(`${entry.rel}\0${bytes.byteLength}\0`));
    hash.update(bytes);
  }
  return { contentHash: HASH_PREFIX + hash.digest("hex"), files: entries.map((e) => e.rel) };
};

/** Constant-time-ish equality for hash strings (they are not secrets, but be tidy). */
export const hashesEqual = (a: string | undefined, b: string | undefined): boolean =>
  typeof a === "string" && typeof b === "string" && a === b;
