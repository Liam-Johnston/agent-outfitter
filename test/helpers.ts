/** Fixture helpers: build throwaway skill repos and workspaces on disk. */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const roots: string[] = [];

export const makeTempDir = async (prefix = "skillsmith-test-"): Promise<string> => {
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
