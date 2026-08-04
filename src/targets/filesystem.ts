/**
 * Generic filesystem target.
 *
 * Writes `<dir>/<name>` per skill and a normalized `<dir>/mcp.json`. Use it for
 * a harness agent-outfitter has no dedicated adapter for, or as the base for one:
 * spread it and override `resolveDir` / `writeMcpServers`.
 */

import { join } from "node:path";

import { ensureDir } from "../fsutil.js";
import {
  installedHash,
  materializeToDir,
  removeInstructionsFromFile,
  resolveAgainstRoot,
  unmaterializeFromDir,
  writeInstructionFile,
} from "./base.js";
import {
  mergeMcpJson,
  readIfExists,
  toNormalizedMcpEntry,
  writeConfigIfChanged,
} from "./mcp-config.js";
import type {
  AgentTarget,
  InstructionWriteInput,
  InstructionWriteOutput,
  MaterializeInput,
  MaterializeOutput,
  McpWriteInput,
  McpWriteOutput,
  PrimitiveKind,
  TargetContext,
} from "../types.js";

export interface FilesystemTargetOptions {
  /** Directory to write skills into. Relative paths resolve against the manager root. */
  dir: string;
  /** MCP config filename within `dir`. Default `"mcp.json"`. */
  mcpFile?: string;
  /** Instruction filename within `dir`. Default `"AGENTS.md"`. */
  instructionFile?: string;
  name?: string;
}

export const filesystemTarget = (options: FilesystemTargetOptions): AgentTarget => {
  const mcpFile = options.mcpFile ?? "mcp.json";
  const instructionFile = options.instructionFile ?? "AGENTS.md";
  const dirFor = (ctx: TargetContext): string => resolveAgainstRoot(ctx, options.dir);
  const instructionPath = (ctx: TargetContext): string => join(dirFor(ctx), instructionFile);

  return {
    name: options.name ?? "filesystem",
    supports: ["skill", "mcp", "instruction"],

    resolveDir(kind: PrimitiveKind, ctx: TargetContext): string {
      if (kind === "mcp") return join(dirFor(ctx), mcpFile);
      if (kind === "instruction") return instructionPath(ctx);
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

    async writeInstructions(input: InstructionWriteInput): Promise<InstructionWriteOutput> {
      return writeInstructionFile(instructionPath(input.ctx), input);
    },

    async removeInstructions(names: string[], ctx: TargetContext): Promise<void> {
      await removeInstructionsFromFile(instructionPath(ctx), names);
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
