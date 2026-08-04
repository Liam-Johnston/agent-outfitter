/**
 * Skill discovery within a materialized source tree.
 *
 * A source may be a single skill folder or a monorepo holding many. Discovery
 * reads only each candidate's `SKILL.md` frontmatter — cheap enough to run over
 * every folder in a repo before deciding what to install.
 */

import { join } from "node:path";

import { SkillNotFoundError } from "./errors.js";
import { isDirectory, listChildDirs } from "./fsutil.js";
import { matchesAny, unmatchedPatterns } from "./glob.js";
import { isSkillDir, readSkillMd, type ParsedSkillMd } from "./primitives/skill.js";
import type { NormalizedRef } from "./types.js";

/**
 * Where skills conventionally live when the source root is a repo rather than a
 * skill. Probed in order; the first directory that exists wins.
 */
export const CONVENTIONAL_SKILL_ROOTS = ["skills", ".agents/skills", ".claude/skills"] as const;

export interface DiscoveredSkill extends ParsedSkillMd {
  name: string;
  /** Absolute path to the skill folder. */
  dir: string;
  /** Path of the skill folder relative to the repo root, POSIX-separated. */
  subdir: string;
}

const joinRel = (...parts: (string | undefined)[]): string =>
  parts
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");

/** Whether any immediate child of `dir` is a skill folder. */
const containsSkillFolder = async (dir: string): Promise<boolean> => {
  if (!(await isDirectory(dir))) return false;
  for (const child of await listChildDirs(dir)) {
    if (await isSkillDir(join(dir, child))) return true;
  }
  return false;
};

/**
 * Resolve the directory that holds skill folders.
 *
 * An explicit `skillsRoot` is taken at face value. Otherwise: a base that is
 * itself a skill is a single skill; then the conventional roots are probed; only
 * then are the base's own children treated as skills.
 *
 * That ordering matters. Real monorepos keep their skills in `skills/` while
 * *also* carrying a `template/` or `examples/` folder with a `SKILL.md` in it.
 * Checking immediate children first would find the template and silently miss
 * every actual skill, so the convention has to win.
 */
const locateSkillsRoot = async (
  treeRoot: string,
  ref: NormalizedRef,
): Promise<{ dir: string; rel: string; single: boolean }> => {
  const subdir = ref.source.type === "git" ? ref.source.subdir : undefined;
  const baseRel = joinRel(subdir, ref.skillsRoot);
  const baseDir = baseRel ? join(treeRoot, ...baseRel.split("/")) : treeRoot;

  if (ref.skillsRoot) {
    return { dir: baseDir, rel: baseRel, single: await isSkillDir(baseDir) };
  }

  if (await isSkillDir(baseDir)) return { dir: baseDir, rel: baseRel, single: true };

  for (const candidate of CONVENTIONAL_SKILL_ROOTS) {
    const dir = join(baseDir, ...candidate.split("/"));
    if (await containsSkillFolder(dir)) {
      return { dir, rel: joinRel(baseRel, candidate), single: false };
    }
  }

  return { dir: baseDir, rel: baseRel, single: false };
};

export const discoverSkills = async (
  treeRoot: string,
  ref: NormalizedRef,
  origin: string,
): Promise<DiscoveredSkill[]> => {
  const { dir, rel, single } = await locateSkillsRoot(treeRoot, ref);

  if (single) {
    const parsed = await readSkillMd(dir, origin);
    const skill: DiscoveredSkill = { ...parsed, dir, subdir: rel };
    if (!matchesAny(skill.name, ref.select)) {
      throw new SkillNotFoundError(
        `${origin} is the single skill "${skill.name}", which does not match ` +
          `select [${(ref.select ?? []).join(", ")}].`,
        { origin, name: skill.name, select: ref.select },
      );
    }
    return [skill];
  }

  const children = await listChildDirs(dir);
  const found: DiscoveredSkill[] = [];
  const available: string[] = [];

  for (const child of children) {
    const childDir = join(dir, child);
    if (!(await isSkillDir(childDir))) continue;
    const childOrigin = `${origin}/${child}`;
    const parsed = await readSkillMd(childDir, childOrigin);
    available.push(parsed.name);
    // Both the folder name and the declared name are selectable: authors often
    // pick a folder name and a display name that differ by a prefix.
    if (matchesAny(parsed.name, ref.select) || matchesAny(child, ref.select)) {
      found.push({ ...parsed, dir: childDir, subdir: joinRel(rel, child) });
    }
  }

  if (available.length === 0) {
    throw new SkillNotFoundError(
      `No skills found in ${origin}. Expected a SKILL.md at the source root, in an immediate ` +
        `child directory, or under one of ${CONVENTIONAL_SKILL_ROOTS.join(", ")}. ` +
        `Set "skillsRoot" on the source to point at the right directory.`,
      { origin, searched: rel || "." },
    );
  }

  const missed = unmatchedPatterns([...available, ...children], ref.select);
  if (missed.length > 0) {
    throw new SkillNotFoundError(
      `No skill in ${origin} matches [${missed.join(", ")}]. Available: ${available.join(", ")}.`,
      { origin, missed, available },
    );
  }

  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

/** Relative-path join used by the resolver when rebuilding subdir paths. */
export const relJoin = joinRel;
