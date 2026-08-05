/**
 * Example manifest, in the TypeScript form.
 *
 * Copy to your project root as `outfitter.config.ts`. Because it is code, target
 * directories and selections can be computed, which is the point of preferring
 * it over YAML when you have a container path or an env var to thread through.
 */

import { claudeTarget, codexTarget, defineConfig } from "agent-outfitter";

export default defineConfig({
  version: 1,

  targets: [
    codexTarget({
      codexHome: process.env.CODEX_HOME ?? "/workspace/.codex-home",
      scope: "user",
    }),
    // The same primitives, also dropped into a project checkout for Claude Code.
    claudeTarget({ dir: process.cwd(), consumer: "code" }),
  ],

  // Skills: folders the harness discovers on its own.
  sources: [
    { ref: "github:anthropics/skills#main", select: ["pdf", "xlsx", "docx"] },
    { ref: "github:anthropics/skills/skills/mcp-builder" },
    { ref: "github:acme/internal-skills#main", auth: { env: "SKILLS_TOKEN" } },
    { ref: "local:./skills" },
  ],

  // MCP servers: configured into each target, never copied as files.
  mcp: [
    {
      name: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      auth: { bearerEnv: "GITHUB_MCP_TOKEN" },
    },
    {
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    },
  ],

  // Instruction fragments: merged into AGENTS.md / CLAUDE.md inside marked
  // regions, so your own prose in those files is never disturbed.
  instructions: [
    // A whole directory of fragments, filtered.
    { ref: "github:acme/agent-config/instructions", select: ["house-style", "review-*"] },
    // A single file, renamed.
    { ref: "github:acme/agent-config/instructions/tone.md", name: "voice" },
    // Fragments kept in this repo.
    "local:./instructions",
  ],

  policy: {
    allowedHosts: ["github.com"],
    allowedOwners: ["acme", "anthropics"],
    requireLockHashMatch: true,
    scripts: "warn",
    scan: "warn",
    // A dependency cannot silently attach a tool server, or rewrite the
    // agent's standing instructions, without the operator opting in.
    allowTransitiveMcp: false,
    allowTransitiveInstructions: false,
    allowedMcpHosts: ["api.githubcopilot.com"],
  },
});
