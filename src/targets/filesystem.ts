/**
 * Generic filesystem target.
 *
 * Writes `<dir>/<name>` per skill and a normalized `<dir>/mcp.json`. Use it for
 * a harness skillsmith has no dedicated adapter for, or as the base for one:
 * spread it and override `resolveSkillsDir` / `writeMcpServers`.
 */

import { join } from "node:path";

import { ensureDir } from "../fsutil.js";
import {
  installedHash,
  materializeToDir,
  resolveAgainstRoot,
  unmaterializeFromDir,
} from "./base.js";
import {
  mergeMcpJson,
  readIfExists,
  toNormalizedMcpEntry,
  writeConfigIfChanged,
} from "./mcp-config.js";
import type {
  MaterializeInput,
  MaterializeOutput,
  McpWriteInput,
  McpWriteOutput,
  SkillTarget,
  TargetContext,
} from "../types.js";

export interface FilesystemTargetOptions {
  /** Directory to write skills into. Relative paths resolve against the manager root. */
  dir: string;
  /** MCP config filename within `dir`. Default `"mcp.json"`. */
  mcpFile?: string;
  name?: string;
}

export const filesystemTarget = (options: FilesystemTargetOptions): SkillTarget => {
  const mcpFile = options.mcpFile ?? "mcp.json";
  const dirFor = (ctx: TargetContext): string => resolveAgainstRoot(ctx, options.dir);

  return {
    name: options.name ?? "filesystem",

    resolveSkillsDir(ctx: TargetContext): string {
      return dirFor(ctx);
    },

    async materialize(input: MaterializeInput): Promise<MaterializeOutput> {
      const dir = dirFor(input.ctx);
      await ensureDir(dir);
      return materializeToDir(dir, input);
    },

    async currentHash(name: string, ctx: TargetContext): Promise<string | undefined> {
      return installedHash(dirFor(ctx), name);
    },

    async unmaterialize(name: string, ctx: TargetContext): Promise<void> {
      await unmaterializeFromDir(dirFor(ctx), name);
    },

    async writeMcpServers(input: McpWriteInput): Promise<McpWriteOutput> {
      const path = join(dirFor(input.ctx), mcpFile);
      if (input.servers.length === 0 && input.previouslyManaged.length === 0) {
        return { path, written: [] };
      }
      const merged = mergeMcpJson(
        await readIfExists(path),
        input.servers,
        input.previouslyManaged,
        path,
        toNormalizedMcpEntry,
      );
      await ensureDir(dirFor(input.ctx));
      await writeConfigIfChanged(path, merged.content);
      return { path, written: merged.written };
    },

    async removeMcpServers(names: string[], ctx: TargetContext): Promise<void> {
      const path = join(dirFor(ctx), mcpFile);
      const existing = await readIfExists(path);
      if (existing === undefined) return;
      const merged = mergeMcpJson(existing, [], names, path, toNormalizedMcpEntry);
      await writeConfigIfChanged(path, merged.content);
    },
  };
};
