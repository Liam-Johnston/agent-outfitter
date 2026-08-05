/**
 * Assertions for the container smoke test.
 *
 * Deliberately dependency-free: the point of the exercise is to prove that
 * *agent-outfitter* works in a fresh container, so anything else installed
 * alongside it is a variable that could mask or cause a failure. A test runner
 * would also swallow the ordering, and the ordering is the interesting part:
 * each check below only means something if the ones before it passed.
 */

import { stat } from "node:fs/promises";

const results: { ok: boolean; label: string; detail?: string }[] = [];

const GREEN = "[32m";
const RED = "[31m";
const DIM = "[2m";
const RESET = "[0m";

export const check = (label: string, ok: boolean, detail?: string): boolean => {
  results.push({ ok, label, ...(detail ? { detail } : {}) });
  const mark = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`  ${mark} ${label}${!ok && detail ? `\n      ${DIM}${detail}${RESET}` : ""}`);
  return ok;
};

export const checkFile = async (label: string, path: string): Promise<boolean> => {
  try {
    const info = await stat(path);
    return check(label, info.isFile() && info.size > 0, `${path} is empty or not a file`);
  } catch {
    return check(label, false, `${path} does not exist`);
  }
};

export const checkDir = async (label: string, path: string): Promise<boolean> => {
  try {
    return check(label, (await stat(path)).isDirectory(), `${path} is not a directory`);
  } catch {
    return check(label, false, `${path} does not exist`);
  }
};

export const checkContains = (
  label: string,
  haystack: string,
  needle: string,
): boolean => check(label, haystack.includes(needle), `expected to find ${JSON.stringify(needle)}`);

export const checkAbsent = (label: string, haystack: string, needle: string): boolean =>
  check(label, !haystack.includes(needle), `did not expect to find ${JSON.stringify(needle)}`);

export const section = (title: string): void => {
  console.log(`\n${title}`);
};

/** Print a summary and exit non-zero on any failure, so `make` fails loudly. */
export const finish = (harness: string) => {
  const failed = results.filter((r) => !r.ok);
  const total = results.length;
  console.log("");
  if (failed.length === 0) {
    console.log(`${GREEN}PASS${RESET} ${harness}: ${total}/${total} checks passed`);
    process.exit(0);
  }
  console.log(`${RED}FAIL${RESET} ${harness}: ${failed.length} of ${total} checks failed`);
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ""}`);
  process.exit(1);
};
