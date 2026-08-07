/**
 * Static checks run on a staged skill tree before it is materialized.
 *
 * Two things matter here. Bundled scripts run inside the agent's environment,
 * so their presence is surfaced (and can be refused). And a skill's text is fed
 * straight into a model's context, which makes invisible Unicode (bidi
 * overrides, zero-width joiners, Unicode tag characters) a prompt-injection
 * vector that a human reviewer reading the diff cannot see.
 */

import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { PolicyViolationError } from "./errors.js";
import { settingsRegistrations } from "./primitives/settings.js";
import type {
  ResolvedBundle,
  ResolvedPolicy,
  ResolvedSettings,
  OutfitterWarning,
} from "./types.js";

/**
 * Characters that render as nothing (or reorder what follows) in a diff view.
 *
 * Excludes U+FEFF at offset 0, which is a legitimate BOM, handled below.
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

/**
 * Files a *skill* is expected to keep its executables in.
 *
 * A convention, not a detection: it is how skill authors package helper scripts,
 * and it is all the skill case needs. It is emphatically not enough for a bundle,
 * which is what `executableFiles` exists for.
 */
export const scriptFiles = (files: readonly string[]): string[] =>
  files.filter((f) => f.startsWith("scripts/"));

/**
 * Extensions that mean "this file is meant to be run".
 *
 * Extension-based rather than path-based, because a committed harness scatters
 * its code by role (`tools/`, `hooks/`, `sensors/`) rather than collecting it
 * under one folder. A prefix check would report an engine of 80 TypeScript
 * entrypoints as script-free, which is exactly the hole this closes.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".py",
  ".rb",
  ".pl",
  ".php",
  ".lua",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
  ".com",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".jar",
  ".bin",
  ".app",
  ".applescript",
  ".osascript",
]);

export const executableFiles = (files: readonly string[]): string[] =>
  files.filter((f) => EXECUTABLE_EXTENSIONS.has(extensionOf(f)));

/**
 * Files a command line appears to invoke.
 *
 * A hook command is a shell string, so this is a substring match rather than
 * parsing: the point is to name the files an operator should read before
 * consenting, and over-reporting a path that merely appears in a command is
 * harmless where missing one is not.
 */
export const commandReferencedFiles = (
  files: readonly string[],
  commands: readonly string[],
): string[] => {
  const joined = commands.join("\n");
  return files.filter((f) => joined.includes(f));
};

export interface TreeCheckResult {
  warnings: OutfitterWarning[];
  hiddenUnicode: HiddenUnicodeFinding[];
  scripts: string[];
}

/**
 * Apply `policy.scripts` and `policy.scan` to one staged tree.
 *
 * `label` names the kind in messages ("Skill", "Bundle"), so the same checks read
 * correctly whichever primitive is being staged.
 *
 * Throws `PolicyViolationError` on a `"deny"` policy; otherwise returns
 * warnings for the caller to surface.
 */
export const checkTree = async (
  label: string,
  name: string,
  root: string,
  files: readonly string[],
  policy: ResolvedPolicy,
): Promise<TreeCheckResult> => {
  const warnings: OutfitterWarning[] = [];
  const scripts = scriptFiles(files);

  if (scripts.length > 0) {
    if (policy.scripts === "deny") {
      throw new PolicyViolationError(
        `${label} "${name}" bundles executable scripts (${scripts.join(", ")}) and ` +
          `policy.scripts is "deny".`,
        { name, scripts },
      );
    }
    if (policy.scripts === "warn") {
      warnings.push({
        code: "scripts-present",
        subject: name,
        message:
          `${label} "${name}" bundles ${scripts.length} file(s) under scripts/. These run inside ` +
          `the agent's environment. Review them before trusting this source.`,
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
          `${label} "${name}" contains hidden Unicode characters and policy.scan is "deny": ${summary}`,
          { name, findings: hiddenUnicode },
        );
      }
      warnings.push({
        code: "hidden-unicode",
        subject: name,
        message:
          `${label} "${name}" contains ${hiddenUnicode.length} hidden Unicode character(s), ` +
          `a known prompt-injection vector: ${summary}`,
        detail: { findings: hiddenUnicode },
      });
    }
  }

  return { warnings, hiddenUnicode, scripts };
};

// ---------------------------------------------------------------------------
// Executable harnesses
// ---------------------------------------------------------------------------

/** What a bundle-plus-settings install would put in place, and run. */
export interface HarnessSummary {
  bundles: string[];
  /** Total files the bundles install. */
  files: number;
  /** Those of them that are executable, by extension. */
  executables: string[];
  /** Hook registrations the settings fragments add. */
  hooks: number;
  /** Lifecycle events those hooks attach to. */
  events: string[];
  /** Commands the hooks and status line run. */
  commands: string[];
  /** `permissions.allow` entries the settings fragments add. */
  permissionsAllow: string[];
  statusLine: boolean;
  /** True when there is anything here to gate at all. */
  executable: boolean;
}

export const summarizeHarness = (
  bundles: readonly ResolvedBundle[],
  settings: readonly ResolvedSettings[],
): HarnessSummary => {
  const registrations = settingsRegistrations(settings);
  const files = bundles.flatMap((bundle) => bundle.files);
  const executables = executableFiles(files);
  const referenced = commandReferencedFiles(files, registrations.commands);
  const all = [...new Set([...executables, ...referenced])].sort();

  return {
    bundles: bundles.map((bundle) => bundle.name),
    files: files.length,
    executables: all,
    hooks: registrations.hooks,
    events: registrations.events,
    commands: registrations.commands,
    permissionsAllow: registrations.permissionsAllow,
    statusLine: registrations.statusLine,
    executable:
      all.length > 0 ||
      registrations.hooks > 0 ||
      registrations.statusLine ||
      registrations.permissionsAllow.length > 0,
  };
};

const describeHarness = (summary: HarnessSummary): string => {
  const parts: string[] = [];
  if (summary.files > 0) {
    parts.push(
      `${summary.files} file(s)` +
        (summary.executables.length > 0
          ? `, ${summary.executables.length} of them executable (${summary.executables.slice(0, 5).join(", ")}` +
            `${summary.executables.length > 5 ? ", …" : ""})`
          : ""),
    );
  }
  if (summary.hooks > 0) {
    parts.push(
      `${summary.hooks} hook registration(s) across ${summary.events.length} event(s) ` +
        `(${summary.events.join(", ")})`,
    );
  }
  if (summary.statusLine) parts.push(`a statusLine command`);
  if (summary.permissionsAllow.length > 0) {
    parts.push(
      `${summary.permissionsAllow.length} permissions.allow entr${summary.permissionsAllow.length === 1 ? "y" : "ies"} ` +
        `(${summary.permissionsAllow.join(", ")})`,
    );
  }
  return parts.join("; ");
};

/**
 * Gate an executable harness on `policy.executableHarness`.
 *
 * The message names what would be registered, not just that something would be,
 * because the decision an operator is being asked to make is "do I trust this
 * code to run on every tool call", and that is unanswerable from a count of files.
 *
 * Throws `PolicyViolationError` under `"deny"`; returns a warning under `"warn"`.
 */
export const checkExecutableHarness = (
  summary: HarnessSummary,
  policy: ResolvedPolicy,
): OutfitterWarning[] => {
  if (!summary.executable || policy.executableHarness === "allow") return [];

  const subject = summary.bundles.join(", ") || "settings";
  const described = describeHarness(summary);

  if (policy.executableHarness === "deny") {
    throw new PolicyViolationError(
      `This install would put an executable agent harness in place: ${described}. ` +
        `Hooks run automatically on every matching tool call, and permissions.allow entries ` +
        `pre-approve tools without prompting, so policy.executableHarness defaults to "deny". ` +
        `Review the source, then set policy.executableHarness to "warn" or "allow".`,
      {
        bundles: summary.bundles,
        files: summary.files,
        executables: summary.executables,
        hooks: summary.hooks,
        events: summary.events,
        commands: summary.commands,
        permissionsAllow: summary.permissionsAllow,
        statusLine: summary.statusLine,
      },
    );
  }

  return [
    {
      code: "executable-harness",
      subject,
      message:
        `Installing an executable agent harness: ${described}. This code runs inside the ` +
        `agent's environment, and its hooks fire without being invoked. Review the source you ` +
        `pinned.`,
      detail: {
        bundles: summary.bundles,
        files: summary.files,
        executables: summary.executables,
        hooks: summary.hooks,
        events: summary.events,
        permissionsAllow: summary.permissionsAllow,
        statusLine: summary.statusLine,
      },
    },
  ];
};
