/**
 * Example manifest, in the TypeScript form.
 *
 * Copy to your project root as `skills.config.ts`. Because it is code, target
 * directories and selections can be computed — which is the point of preferring
 * it over YAML when you have a container path or an env var to thread through.
 */

import { claudeTarget, codexTarget, defineConfig } from "skillsmith";

export default defineConfig({
  version: 1,

  targets: [
    codexTarget({
      codexHome: process.env.CODEX_HOME ?? "/workspace/.codex-home",
      scope: "user",
    }),
    // Also drop the same skills into a project checkout for Claude Code.
    claudeTarget({ dir: process.cwd(), consumer: "code" }),
  ],

  sources: [
    // Cherry-pick from a monorepo, pinned to a tag.
    { ref: "github:anthropics/skills#main", select: ["pdf", "xlsx", "docx"] },

    // A single skill addressed by its subdir.
    { ref: "github:anthropics/skills/skills/mcp-builder" },

    // Everything under a private repo, authenticated by env-var *name*.
    { ref: "github:acme/internal-skills#main", auth: { env: "SKILLS_TOKEN" } },

    // Skills kept in this repo.
    { ref: "local:./skills" },
  ],

  // Configured into each target's MCP config; never copied as files.
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

  policy: {
    allowedHosts: ["github.com"],
    allowedOwners: ["acme", "anthropics"],
    requireLockHashMatch: true,
    scripts: "warn",
    scan: "warn",
    // A dependency cannot silently attach a tool server to the agent.
    allowTransitiveMcp: false,
    allowedMcpHosts: ["api.githubcopilot.com"],
  },
});
