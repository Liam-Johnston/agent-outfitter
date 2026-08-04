/**
 * Static checks run on a staged skill tree before it is materialized.
 *
 * Two things matter here. Bundled scripts run inside the agent's environment,
 * so their presence is surfaced (and can be refused). And a skill's text is fed
 * straight into a model's context, which makes invisible Unicode — bidi
 * overrides, zero-width joiners, Unicode tag characters — a prompt-injection
 * vector that a human reviewer reading the diff cannot see.
 */

import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { PolicyViolationError } from "./errors.js";
import type { ResolvedPolicy, SkillWarning } from "./types.js";

/**
 * Characters that render as nothing (or reorder what follows) in a diff view.
 *
 * Excludes U+FEFF at offset 0, which is a legitimate BOM — handled below.
 */
const HIDDEN_CHARS: ReadonlyArray<[start: number, end: number, label: string]> = [
  [0x00ad, 0x00ad, "soft hyphen"],
  [0x061c, 0x061c, "arabic letter mark"],
  [0x180e, 0x180e, "mongolian vowel separator"],
  [0x200b, 0x200f, "zero-width / directional mark"],
  [0x202a, 0x202e, "bidi override"],
  [0x2060, 0x2064, "invisible operator"],
  [0x2066, 0x2069, "bidi isolate"],
  [0xfeff, 0xfeff, "zero-width no-break space"],
  [0xe0000, 0xe007f, "unicode tag character"],
];

const TEXT_EXTENSIONS = new Set([
  "",
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".csv",
  ".tsv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rb",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".sql",
  ".rs",
  ".go",
  ".java",
  ".env",
]);

const extensionOf = (relPath: string): string => {
  const base = relPath.slice(relPath.lastIndexOf(posix.sep) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
};

const classify = (codePoint: number): string | undefined => {
  for (const [start, end, label] of HIDDEN_CHARS) {
    if (codePoint >= start && codePoint <= end) return label;
  }
  return undefined;
};

export interface HiddenUnicodeFinding {
  file: string;
  line: number;
  column: number;
  codePoint: string;
  label: string;
}

export const scanTextForHiddenUnicode = (
  text: string,
  file: string,
): HiddenUnicodeFinding[] => {
  const findings: HiddenUnicodeFinding[] = [];
  let line = 1;
  let column = 0;
  let offset = 0;

  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (char === "\n") {
      line += 1;
      column = 0;
      offset += char.length;
      continue;
    }
    column += 1;
    // A BOM at the very start of the file is conventional, not an attack.
    if (!(codePoint === 0xfeff && offset === 0)) {
      const label = classify(codePoint);
      if (label) {
        findings.push({
          file,
          line,
          column,
          codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
          label,
        });
      }
    }
    offset += char.length;
  }

  return findings;
};

/** Scan every text file in a staged tree. Binary files are skipped. */
export const scanTreeForHiddenUnicode = async (
  root: string,
  files: readonly string[],
): Promise<HiddenUnicodeFinding[]> => {
  const findings: HiddenUnicodeFinding[] = [];
  for (const rel of files) {
    if (!TEXT_EXTENSIONS.has(extensionOf(rel))) continue;
    const bytes = await readFile(join(root, ...rel.split(posix.sep)));
    // A NUL byte means it is not really text, whatever the extension says.
    if (bytes.includes(0)) continue;
    findings.push(...scanTextForHiddenUnicode(bytes.toString("utf8"), rel));
  }
  return findings;
};

export const scriptFiles = (files: readonly string[]): string[] =>
  files.filter((f) => f.startsWith("scripts/"));

export interface TreeCheckResult {
  warnings: SkillWarning[];
  hiddenUnicode: HiddenUnicodeFinding[];
  scripts: string[];
}

/**
 * Apply `policy.scripts` and `policy.scan` to one staged skill tree.
 *
 * Throws `PolicyViolationError` on a `"deny"` policy; otherwise returns
 * warnings for the caller to surface.
 */
export const checkTree = async (
  name: string,
  root: string,
  files: readonly string[],
  policy: ResolvedPolicy,
): Promise<TreeCheckResult> => {
  const warnings: SkillWarning[] = [];
  const scripts = scriptFiles(files);

  if (scripts.length > 0) {
    if (policy.scripts === "deny") {
      throw new PolicyViolationError(
        `Skill "${name}" bundles executable scripts (${scripts.join(", ")}) and ` +
          `policy.scripts is "deny".`,
        { name, scripts },
      );
    }
    if (policy.scripts === "warn") {
      warnings.push({
        code: "scripts-present",
        subject: name,
        message:
          `Skill "${name}" bundles ${scripts.length} file(s) under scripts/. These run inside ` +
          `the agent's environment — review them before trusting this source.`,
        detail: { scripts },
      });
    }
  }

  let hiddenUnicode: HiddenUnicodeFinding[] = [];
  if (policy.scan !== "off") {
    hiddenUnicode = await scanTreeForHiddenUnicode(root, files);
    if (hiddenUnicode.length > 0) {
      const summary = hiddenUnicode
        .slice(0, 5)
        .map((f) => `${f.file}:${f.line}:${f.column} ${f.codePoint} (${f.label})`)
        .join(", ");
      if (policy.scan === "deny") {
        throw new PolicyViolationError(
          `Skill "${name}" contains hidden Unicode characters and policy.scan is "deny": ${summary}`,
          { name, findings: hiddenUnicode },
        );
      }
      warnings.push({
        code: "hidden-unicode",
        subject: name,
        message:
          `Skill "${name}" contains ${hiddenUnicode.length} hidden Unicode character(s) — ` +
          `a known prompt-injection vector: ${summary}`,
        detail: { findings: hiddenUnicode },
      });
    }
  }

  return { warnings, hiddenUnicode, scripts };
};
