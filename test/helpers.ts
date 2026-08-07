/** Fixture helpers: build throwaway skill repos and workspaces on disk. */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const roots: string[] = [];

export const makeTempDir = async (prefix = "agent-outfitter-test-"): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

export const cleanupTempDirs = async (): Promise<void> => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
};

export const writeFileAt = async (root: string, rel: string, content: string): Promise<string> => {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  return abs;
};

export interface SkillSpec {
  name?: string;
  description?: string;
  /** Raw YAML lines inserted into the frontmatter verbatim. */
  frontmatter?: string;
  body?: string;
  /** Extra files, relative to the skill folder. */
  files?: Record<string, string>;
}

export const skillMd = (spec: SkillSpec): string => {
  const lines = ["---"];
  if (spec.name) lines.push(`name: ${spec.name}`);
  lines.push(`description: ${spec.description ?? "A test skill."}`);
  if (spec.frontmatter) lines.push(spec.frontmatter.trimEnd());
  lines.push("---", "");
  lines.push(spec.body ?? "Do the thing.");
  return `${lines.join("\n")}\n`;
};

/** Create `<root>/<dir>/SKILL.md` plus any extra files. */
export const writeSkill = async (
  root: string,
  dir: string,
  spec: SkillSpec,
): Promise<string> => {
  await writeFileAt(root, join(dir, "SKILL.md"), skillMd(spec));
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    await writeFileAt(root, join(dir, rel), content);
  }
  return join(root, dir);
};

/** A monorepo laid out as `skills/<name>/SKILL.md`. */
export const writeSkillRepo = async (
  root: string,
  skills: Record<string, SkillSpec>,
): Promise<string> => {
  for (const [name, spec] of Object.entries(skills)) {
    await writeSkill(root, join("skills", name), { name, ...spec });
  }
  return root;
};

// ---------------------------------------------------------------------------
// A committed-harness fixture
// ---------------------------------------------------------------------------

/**
 * A `settings.json` shaped like the one a real framework ships.
 *
 * 13 hook registrations across 9 events, with four matcher groups under
 * `PostToolUse` alone, plus each of the other regions the merge has to handle:
 * `env`, `permissions.allow`, scalars, a `statusLine` command, and a long opaque
 * string. Written out in full rather than generated, because the thing under test
 * is behaviour against a real shape, and a generated fixture tends to be a
 * restatement of the code's own assumptions.
 */
export const HARNESS_SETTINGS = {
  model: "opus",
  companyAnnouncements: `Engine build ${"-".repeat(2400)} end`,
  statusLine: { type: "command", command: "bun .claude/tools/aidlc-status.ts" },
  env: {
    AIDLC_HOME: ".aidlc",
    AIDLC_STRICT: "1",
  },
  permissions: {
    allow: [
      "Bash(bun .claude/tools/aidlc-orchestrate.ts:*)",
      "Read(.aidlc/**)",
      "Write(.aidlc/**)",
      "Bash(git status:*)",
    ],
  },
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "bun .claude/hooks/guard-bash.ts" }] },
      { matcher: "Task", hooks: [{ type: "command", command: "bun .claude/hooks/guard-task.ts" }] },
    ],
    PostToolUse: [
      {
        matcher: "Write|Edit",
        hooks: [{ type: "command", command: "bun .claude/hooks/aidlc-runtime-compile.ts" }],
      },
      { matcher: "Bash", hooks: [{ type: "command", command: "bun .claude/hooks/audit-bash.ts" }] },
      { matcher: "Task", hooks: [{ type: "command", command: "bun .claude/hooks/stage-advance.ts" }] },
      { matcher: "*", hooks: [{ type: "command", command: "bun .claude/sensors/observe.ts" }] },
    ],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "bun .claude/hooks/intake.ts" }] }],
    SessionStart: [{ hooks: [{ type: "command", command: "bun .claude/hooks/session-start.ts" }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: "bun .claude/hooks/session-end.ts" }] }],
    Stop: [{ hooks: [{ type: "command", command: "bun .claude/hooks/stop.ts" }] }],
    SubagentStop: [{ hooks: [{ type: "command", command: "bun .claude/hooks/subagent-stop.ts" }] }],
    PreCompact: [{ hooks: [{ type: "command", command: "bun .claude/hooks/pre-compact.ts" }] }],
    Notification: [{ hooks: [{ type: "command", command: "bun .claude/hooks/notify.ts" }] }],
  },
} as const;

/** Every hook registration in `HARNESS_SETTINGS`, as `[event, matcher, command]`. */
export const HARNESS_REGISTRATIONS: [event: string, matcher: string, command: string][] =
  Object.entries(HARNESS_SETTINGS.hooks).flatMap(([event, groups]) =>
    (groups as readonly { matcher?: string; hooks: readonly { command: string }[] }[]).flatMap(
      (group) =>
        group.hooks.map(
          (entry) => [event, group.matcher ?? "", entry.command] as [string, string, string],
        ),
    ),
  );

/** The source-to-destination map a manifest would declare for the fixture below. */
export const HARNESS_BUNDLE_PATHS = {
  ".claude/agents": ".claude/agents",
  ".claude/hooks": ".claude/hooks",
  ".claude/tools": ".claude/tools",
  ".claude/sensors": ".claude/sensors",
  ".claude/scopes": ".claude/scopes",
  ".claude/knowledge": ".claude/knowledge",
  ".claude/aidlc-common": ".claude/aidlc-common",
  aidlc: "aidlc",
} as const;

/**
 * A repository laid out like a committed-harness framework.
 *
 * Deliberately mixed: skills that shell into the engine, executable engine files
 * at several prefixes (none of them `scripts/`), data and knowledge files that are
 * not executable, a settings fragment, and an instruction fragment. That mix is
 * what the bundle and trust-gate behaviour has to be right about.
 */
export const writeHarnessRepo = async (root: string): Promise<string> => {
  const orchestrate = "bun .claude/tools/aidlc-orchestrate.ts";

  for (const name of ["aidlc-plan", "aidlc-build"]) {
    await writeSkill(root, join("skills", name), {
      name,
      description: `Run the ${name} stage.`,
      body: `Invoke the engine:\n\n\`\`\`sh\n${orchestrate} ${name}\n\`\`\`\n`,
    });
  }

  await writeFileAt(
    root,
    ".claude/tools/aidlc-orchestrate.ts",
    "#!/usr/bin/env bun\nexport const orchestrate = (): string => \"ok\";\n",
  );
  await writeFileAt(root, ".claude/tools/aidlc-status.ts", "export const status = () => \"idle\";\n");
  await writeFileAt(root, ".claude/tools/aidlc-graph.ts", "export const graph = () => [];\n");
  await writeFileAt(root, ".claude/tools/data/stages.json", '{\n  "stages": ["plan", "build"]\n}\n');

  for (const [, , command] of HARNESS_REGISTRATIONS) {
    const rel = command.replace(/^bun /, "");
    await writeFileAt(root, rel, `export const run = (): void => {};\n`);
  }

  await writeFileAt(root, ".claude/knowledge/patterns.md", "# Patterns\n\nWrite tests first.\n");
  await writeFileAt(root, ".claude/knowledge/glossary.md", "# Glossary\n\nUnit: a stage.\n");
  await writeFileAt(root, ".claude/agents/planner.md", "---\nname: planner\n---\n\nPlan.\n");
  await writeFileAt(root, ".claude/scopes/default.md", "# Default scope\n");
  await writeFileAt(root, ".claude/aidlc-common/stage-protocol.md", "# Stage protocol\n\nStep 1.\n");
  await writeFileAt(root, "aidlc/spaces/default/README.md", "# Default space\n");
  await writeFileAt(root, "rules/aidlc.md", "Follow the stage protocol.\n");
  await writeFileAt(
    root,
    ".claude/settings.json",
    `${JSON.stringify(HARNESS_SETTINGS, null, 2)}\n`,
  );

  return root;
};
