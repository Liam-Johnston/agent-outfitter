/**
 * `outfitter.lock.json`: the reproducibility record.
 *
 * Each skill pins an exact commit plus a content hash over its file tree, so a
 * fresh `sync()` is byte-identical even if the tag it was installed from moves.
 *
 * Beyond the per-kind sections there is a `targets` section recording where each
 * primitive landed and which config/instruction entries agent-outfitter owns in
 * each target. Without it, `remove()` cannot tell its own entries from the
 * user's, and pruning would have to clobber the whole file.
 */

import { join } from "node:path";

import { z } from "zod";

import { LockfileError } from "./errors.js";
import { formatZodError } from "./manifest.js";
import { canonicalJson } from "./hash.js";
import { pathExists, readTextFile, writeFileAtomic } from "./fsutil.js";
import type { PrimitiveSource } from "./types.js";

export const LOCKFILE_NAME = "outfitter.lock.json";

const sourceSchema = z.union([
  z
    .object({
      type: z.literal("git"),
      url: z.string(),
      ref: z.string().optional(),
      subdir: z.string().optional(),
      provider: z.enum(["github", "gitlab", "bitbucket", "sourcehut", "git"]).optional(),
    })
    .strict(),
  z.object({ type: z.literal("local"), path: z.string() }).strict(),
]);

const lockSkillSchema = z
  .object({
    source: sourceSchema,
    ref: z.string(),
    commit: z.string(),
    contentHash: z.string(),
    files: z.array(z.string()),
    dependencies: z.array(z.string()).default([]),
    mcp: z.array(z.string()).default([]),
    transitive: z.boolean().default(false),
  })
  .strict();

const lockMcpSchema = z
  .object({
    transport: z.enum(["stdio", "http"]),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    envVars: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().optional(),
    auth: z.object({ bearerEnv: z.string().optional() }).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    declaredBy: z.string(),
    trusted: z.boolean().default(true),
    configHash: z.string(),
  })
  .strict();

const lockInstructionSchema = z
  .object({
    source: sourceSchema,
    ref: z.string(),
    commit: z.string(),
    subdir: z.string(),
    contentHash: z.string(),
    declaredBy: z.string(),
    trusted: z.boolean().default(true),
  })
  .strict();

const lockTargetSchema = z
  .object({
    /** skill name -> absolute install path (or target-defined identifier). */
    skills: z.record(z.string(), z.string()).default({}),
    /** MCP server names agent-outfitter wrote into this target's config. */
    mcp: z.array(z.string()).default([]),
    /** Config file agent-outfitter touched for MCP, if any. */
    mcpConfigPath: z.string().optional(),
    /** Instruction fragment names agent-outfitter wrote into this target. */
    instructions: z.array(z.string()).default([]),
    /** Instruction file agent-outfitter merged into, if any. */
    instructionPath: z.string().optional(),
    /** Upload-style targets record their remote ids here. */
    skillIds: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const lockfileSchema = z
  .object({
    version: z.literal(1),
    skills: z.record(z.string(), lockSkillSchema).default({}),
    mcp: z.record(z.string(), lockMcpSchema).default({}),
    instructions: z.record(z.string(), lockInstructionSchema).default({}),
    targets: z.record(z.string(), lockTargetSchema).default({}),
  })
  .strict();

export type Lockfile = z.infer<typeof lockfileSchema>;
export type LockSkill = z.infer<typeof lockSkillSchema>;
export type LockMcp = z.infer<typeof lockMcpSchema>;
export type LockInstruction = z.infer<typeof lockInstructionSchema>;
export type LockTarget = z.infer<typeof lockTargetSchema>;

export const emptyLockfile = (): Lockfile => ({
  version: 1,
  skills: {},
  mcp: {},
  instructions: {},
  targets: {},
});

export const lockfilePath = (root: string): string => join(root, LOCKFILE_NAME);

export const readLockfile = async (root: string): Promise<Lockfile | undefined> => {
  const path = lockfilePath(root);
  if (!(await pathExists(path))) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(await readTextFile(path));
  } catch (error) {
    throw new LockfileError(`${path} is not valid JSON: ${(error as Error).message}`, { path });
  }

  const parsed = lockfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LockfileError(`${path} is invalid: ${formatZodError(parsed.error)}`, {
      path,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
};

/**
 * Serialize deterministically: sorted keys throughout, so a lockfile committed
 * from two machines produces an empty diff.
 */
export const serializeLockfile = (lock: Lockfile): string => {
  const sortRecord = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  const ordered = {
    version: lock.version,
    skills: sortRecord(lock.skills),
    mcp: sortRecord(lock.mcp),
    instructions: sortRecord(lock.instructions),
    targets: sortRecord(lock.targets),
  };
  return `${JSON.stringify(JSON.parse(canonicalJson(ordered)), null, 2)}\n`;
};

export const writeLockfile = async (root: string, lock: Lockfile): Promise<string> => {
  const path = lockfilePath(root);
  await writeFileAtomic(path, serializeLockfile(lock));
  return path;
};

/** Rebuild a `PrimitiveSource` from its lockfile projection. */
export const lockSourceToPrimitiveSource = (source: LockSkill["source"]): PrimitiveSource =>
  source.type === "local"
    ? { type: "local", path: source.path }
    : {
        type: "git",
        url: source.url,
        ...(source.ref ? { ref: source.ref } : {}),
        ...(source.subdir ? { subdir: source.subdir } : {}),
        ...(source.provider ? { provider: source.provider } : {}),
      };

/** Project a `PrimitiveSource` for storage. Drops auth, which never enters the lockfile. */
export const primitiveSourceToLockSource = (source: PrimitiveSource): LockSkill["source"] =>
  source.type === "local"
    ? { type: "local", path: source.path }
    : {
        type: "git",
        url: source.url,
        ...(source.ref ? { ref: source.ref } : {}),
        ...(source.subdir ? { subdir: source.subdir } : {}),
        ...(source.provider ? { provider: source.provider } : {}),
      };
