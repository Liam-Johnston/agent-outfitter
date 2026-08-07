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

  // Bundles: opaque subtrees copied verbatim to declared destinations. How a
  // committed harness installs, since `tools/`, `knowledge/`, and `hooks/`
  // announce nothing about themselves the way a skill folder does. Declared
  // rather than discovered, so `select:` globs do not apply to them.
  bundles: [
    {
      ref: "github:awslabs/aidlc-workflows/dist/claude#v2",
      name: "aidlc-engine",
      paths: {
        ".claude/tools": ".claude/tools",
        ".claude/hooks": ".claude/hooks",
        ".claude/knowledge": ".claude/knowledge",
        // A bundle may write outside `.claude/`, which is the wider reach that
        // `executableHarness` below exists to gate.
        aidlc: "aidlc",
      },
    },
  ],

  // Settings: merged into `.claude/settings.json` key by key, so a settings file
  // you wrote yourself keeps everything it holds. Ownership is recorded in the
  // lockfile, which is what lets remove() unwind exactly these keys.
  settings: [
    {
      ref: "github:awslabs/aidlc-workflows/dist/claude/.claude/settings.json#v2",
      name: "aidlc",
    },
    // Inline, for the handful of keys that belong to this project rather than to
    // anything fetched. Needs a name: there is no filename to derive one from.
    { name: "local-overrides", settings: { env: { AWS_REGION: "eu-west-2" } } },
  ],

  policy: {
    allowedHosts: ["github.com"],
    allowedOwners: ["acme", "anthropics", "awslabs"],
    requireLockHashMatch: true,
    scripts: "warn",
    // Bundles that install executable files, and settings fragments that register
    // hooks or a status line, default to "deny": that code runs on every matching
    // tool call whether or not anything invoked it. "warn" installs and names what
    // was registered; "allow" installs silently.
    executableHarness: "warn",
    scan: "warn",
    // A dependency cannot silently attach a tool server, or rewrite the
    // agent's standing instructions, without the operator opting in. Bundles and
    // settings have no transitive form at all: only this manifest can declare one.
    allowTransitiveMcp: false,
    allowTransitiveInstructions: false,
    allowedMcpHosts: ["api.githubcopilot.com"],
  },
});
