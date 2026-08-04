/**
 * OpenAI hosted-skill target.
 *
 * Unlike every other adapter this one *uploads* rather than copies: the staged
 * tree is posted to the platform and the returned `skill_id` is what a Responses
 * call references via `skill_reference`. There is nothing on disk afterwards, so
 * the manager falls back to the lockfile for skip/verify decisions.
 *
 * The upload call is injectable. Supplying `upload` pins the exact wire format
 * you need; supplying `client` uses the default `POST /skills` request, which
 * assumes an `openai`-SDK-shaped client exposing a low-level `post`.
 */

import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { TargetError } from "../errors.js";
import type {
  MaterializeInput,
  MaterializeOutput,
  ResolvedSkill,
  SkillTarget,
  TargetContext,
} from "../types.js";

/** Structural subset of the `openai` client this target needs. */
export interface OpenAiLikeClient {
  post(path: string, options: { body: unknown }): Promise<unknown>;
}

export interface HostedSkillFile {
  path: string;
  /** UTF-8 for text files, base64 for anything with non-UTF-8 bytes. */
  content: string;
  encoding: "utf-8" | "base64";
}

export interface HostedUploadInput {
  skill: ResolvedSkill;
  stagedDir: string;
  files: HostedSkillFile[];
  ctx: TargetContext;
}

export type HostedUpload = (input: HostedUploadInput) => Promise<{ skillId: string }>;

export interface OpenAiHostedTargetOptions {
  /** An `openai` client (or anything with a compatible `post`). */
  client?: OpenAiLikeClient;
  /** Full control over the upload request. Takes precedence over `client`. */
  upload?: HostedUpload;
  /** API path used by the default uploader. Default `"/skills"`. */
  path?: string;
  name?: string;
}

/** Read a file as UTF-8 when it round-trips cleanly, base64 otherwise. */
const readAsHostedFile = async (root: string, rel: string): Promise<HostedSkillFile> => {
  const bytes = await readFile(join(root, ...rel.split(posix.sep)));
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").equals(bytes)) {
    return { path: rel, content: text, encoding: "utf-8" };
  }
  return { path: rel, content: bytes.toString("base64"), encoding: "base64" };
};

const defaultUpload =
  (client: OpenAiLikeClient, path: string): HostedUpload =>
  async ({ skill, files }) => {
    const response = (await client.post(path, {
      body: {
        name: skill.name,
        description: skill.description,
        version: skill.commit || undefined,
        files: files.map((f) => ({ path: f.path, content: f.content, encoding: f.encoding })),
      },
    })) as { id?: string; skill_id?: string } | undefined;

    const skillId = response?.id ?? response?.skill_id;
    if (!skillId) {
      throw new TargetError(
        `Hosted skill upload for "${skill.name}" returned no skill id. ` +
          `Pass an "upload" function to control the request shape.`,
        { skill: skill.name },
      );
    }
    return { skillId };
  };

export const openaiHostedTarget = (options: OpenAiHostedTargetOptions): SkillTarget => {
  const upload =
    options.upload ??
    (options.client ? defaultUpload(options.client, options.path ?? "/skills") : undefined);

  if (!upload) {
    throw new TargetError(
      `openaiHostedTarget requires either a "client" or an "upload" function.`,
    );
  }

  return {
    name: options.name ?? "openai-hosted",

    resolveSkillsDir(): string {
      // Nothing lands on disk; the identifier keeps diagnostics readable.
      return "openai://skills";
    },

    async materialize(input: MaterializeInput): Promise<MaterializeOutput> {
      const files = await Promise.all(
        input.skill.files.map((rel) => readAsHostedFile(input.stagedDir, rel)),
      );
      const { skillId } = await upload({
        skill: input.skill,
        stagedDir: input.stagedDir,
        files,
        ctx: input.ctx,
      });
      return { path: `openai://skills/${skillId}`, skillId };
    },
  };
};
