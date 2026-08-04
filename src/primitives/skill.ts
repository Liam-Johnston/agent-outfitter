/**
 * `SKILL.md` reading.
 *
 * A skill is a folder whose root holds `SKILL.md`: YAML frontmatter followed by
 * instructions. skillsmith consumes `name`, `description`, and `dependencies`;
 * everything else in the frontmatter is preserved verbatim in `meta` so that
 * agent-specific fields survive a round trip.
 */

import { basename, join } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { SkillNotFoundError, SourceResolutionError } from "../errors.js";
import { isFile, readTextFile } from "../fsutil.js";
import { formatZodError, mcpDependencySchema } from "../manifest.js";
import type {
  NamedMcpServer,
  Primitive,
  PrimitiveKind,
  SkillDependencies,
  SkillRef,
} from "../types.js";

export const SKILL_FILE = "SKILL.md";

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/;

/** A skill name must be usable as a single directory segment. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const structuredRefSchema = z.object({
  source: z.unknown(),
  select: z.union([z.string(), z.array(z.string())]).optional(),
  skillsRoot: z.string().optional(),
});

/**
 * Primitive kinds the manifest format reserves but M1 does not install.
 *
 * They are accepted and surfaced as `unsupported` primitives rather than
 * rejected, so a skill authored against full APM parity still resolves today
 * and starts installing them when M3 lands — no manifest change required.
 */
const FUTURE_KINDS = ["plugins", "agents", "prompts", "instructions", "hooks"] as const;

const futureEntrySchema = z.union([z.string(), z.object({ name: z.string() }).loose()]);

const dependenciesSchema = z
  .object({
    skills: z.array(z.union([z.string(), structuredRefSchema])).optional(),
    mcp: z.array(mcpDependencySchema).optional(),
    plugins: z.array(futureEntrySchema).optional(),
    agents: z.array(futureEntrySchema).optional(),
    prompts: z.array(futureEntrySchema).optional(),
    instructions: z.array(futureEntrySchema).optional(),
    hooks: z.array(futureEntrySchema).optional(),
  })
  .strict();

/** `dependencies:` accepts the structured map or a bare list of skill refs. */
const dependenciesInputSchema = z.union([
  dependenciesSchema,
  z.array(z.union([z.string(), structuredRefSchema])),
]);

export interface ParsedSkillMd {
  name?: string;
  description: string;
  meta: Record<string, unknown>;
  dependencies: SkillDependencies;
  body: string;
}

export const parseFrontmatter = (
  content: string,
  origin: string,
): { data: Record<string, unknown>; body: string } => {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { data: {}, body: content };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch (error) {
    throw new SourceResolutionError(
      `Invalid YAML frontmatter in ${origin}: ${(error as Error).message}`,
      { origin },
    );
  }
  if (parsed === null || parsed === undefined) return { data: {}, body: match[2] ?? "" };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SourceResolutionError(`Frontmatter in ${origin} must be a YAML mapping.`, { origin });
  }
  return { data: parsed as Record<string, unknown>, body: match[2] ?? "" };
};

export const parseSkillMd = (content: string, origin: string): ParsedSkillMd => {
  const { data, body } = parseFrontmatter(content, origin);
  const { name, description, dependencies, ...meta } = data;

  if (name !== undefined && typeof name !== "string") {
    throw new SourceResolutionError(`"name" in ${origin} must be a string.`, { origin });
  }
  if (description !== undefined && typeof description !== "string") {
    throw new SourceResolutionError(`"description" in ${origin} must be a string.`, { origin });
  }

  return {
    ...(name ? { name } : {}),
    description: description ?? "",
    meta,
    dependencies: parseDependencies(dependencies, origin),
    body,
  };
};

const SINGULAR_KIND: Record<(typeof FUTURE_KINDS)[number], PrimitiveKind> = {
  plugins: "plugin",
  agents: "agent",
  prompts: "prompt",
  instructions: "instruction",
  hooks: "hook",
};

const parseDependencies = (value: unknown, origin: string): SkillDependencies => {
  const empty: SkillDependencies = { skills: [], mcp: [], unsupported: [] };
  if (value === undefined || value === null) return empty;

  const parsed = dependenciesInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new SourceResolutionError(
      `Invalid "dependencies" in ${origin}: ${formatZodError(parsed.error)}`,
      { origin, issues: parsed.error.issues },
    );
  }

  if (Array.isArray(parsed.data)) {
    return { ...empty, skills: parsed.data as SkillRef[] };
  }

  const unsupported: Primitive[] = [];
  for (const key of FUTURE_KINDS) {
    for (const entry of parsed.data[key] ?? []) {
      const name = typeof entry === "string" ? entry : entry.name;
      unsupported.push({ kind: SINGULAR_KIND[key], name } as Primitive);
    }
  }

  return {
    skills: (parsed.data.skills ?? []) as SkillRef[],
    mcp: (parsed.data.mcp ?? []) as NamedMcpServer[],
    unsupported,
  };
};

export const assertValidSkillName = (name: string, origin: string): void => {
  if (!NAME_RE.test(name)) {
    throw new SourceResolutionError(
      `Skill name "${name}" (${origin}) is not a valid directory segment. ` +
        `Use letters, digits, ".", "_", or "-", starting with a letter or digit.`,
      { name, origin },
    );
  }
};

/** True when `dir` is itself a skill folder. */
export const isSkillDir = async (dir: string): Promise<boolean> => isFile(join(dir, SKILL_FILE));

/** Read and validate the `SKILL.md` at the root of `dir`. */
export const readSkillMd = async (
  dir: string,
  origin: string,
): Promise<ParsedSkillMd & { name: string }> => {
  const file = join(dir, SKILL_FILE);
  if (!(await isFile(file))) {
    throw new SkillNotFoundError(`No ${SKILL_FILE} found in ${origin}.`, { dir, origin });
  }
  const parsed = parseSkillMd(await readTextFile(file), `${origin}/${SKILL_FILE}`);
  const name = parsed.name ?? basename(dir);
  assertValidSkillName(name, origin);
  return { ...parsed, name };
};
