/**
 * Outfitting Claude — a complete, self-contained example.
 *
 * ```ts
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { setupClaude } from "./harness/claude.ts";
 *
 * const { sdk } = await setupClaude({ instructionsDir: "./instructions" });
 *
 * for await (const message of query({ prompt, options: { ...sdk } })) {
 *   // …
 * }
 * ```
 *
 * **Spreading `sdk` is not optional for the Agent SDK.** Unlike the Claude Code
 * app, it loads no filesystem skills unless `settingSources` is set — so an SDK
 * built without it starts cleanly and silently knows nothing about anything that
 * was just installed. That is the easiest thing to get wrong here, and the reason
 * `sdkOptions()` exists rather than leaving you to assemble it by hand.
 *
 * Targeting the Claude Code *app* instead? Pass `consumer: "code"` below and ignore
 * `sdk` entirely — the app reads the files directly and needs no configuration.
 *
 * The SDK call is left to the caller because this file is also driven by the smoke
 * test, which asserts on the options rather than starting an agent.
 */

import {
  claudeTarget,
  createAgentManager,
  type AgentManager,
  type ClaudeSdkOptions,
  type ClaudeTarget,
  type InstallResult,
  type OutfitterEvent,
} from "agent-outfitter";

export interface SetupOptions {
  /** Directory holding local instruction fragments. */
  instructionsDir: string;
  /** Progress and audit stream. */
  onEvent?: (event: OutfitterEvent) => void;
}

export interface ClaudeSetup {
  target: ClaudeTarget;
  /** Kept so a later `sync()` or `verify()` needs nothing rebuilt. */
  outfitter: AgentManager;
  install: InstallResult;
  /** Ready to spread into `query({ options: { ... } })`. */
  sdk: ClaudeSdkOptions;
}

/**
 * Install this project's primitives into Claude and return the SDK wiring.
 *
 * `consumer: "agent-sdk"` is not a path — it tells the target which Claude surface
 * will read these skills, so `sdkOptions()` returns the right `settingSources` and
 * a warning is raised if the install lands somewhere the SDK would not look.
 * Everything else is a default: skills into `<root>/.claude/skills`, MCP servers
 * into `.mcp.json`, instructions into `CLAUDE.md`. Pass `{ dir }` to target a
 * different project directory, or `{ scope: "user" }` for `~/.claude`.
 */
export const setupClaude = async (options: SetupOptions): Promise<ClaudeSetup> => {
  const target = claudeTarget({ consumer: "agent-sdk" });

  const outfitter = createAgentManager({
    targets: [target],
    // `root` defaults to process.cwd(). It is both where the lockfile lives and
    // what project-scoped skills are installed relative to, so commit that file
    // and `sync()` reproduces this install exactly.
    manifest: {
      version: 1,

      // `#main` is resolved to a commit once, at install time, and that commit is
      // what the lockfile pins — so the branch moving later does not change what
      // `sync()` installs.
      sources: [{ ref: "github:anthropics/skills#main", select: ["pdf", "xlsx", "mcp-builder"] }],

      // Neither server carries a secret: `bearerEnv` and `envVars` name
      // environment variables. In `.mcp.json` they stay as `${NAME}` placeholders,
      // which Claude Code expands on read; `sdkOptions()` resolves them to values,
      // because nothing expands a placeholder in an in-process options object.
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
          args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
          envVars: ["HOME"],
        },
      ],

      // Merged into CLAUDE.md inside a marked region, leaving anything you wrote
      // in that file untouched. A `github:` ref would share them across projects.
      instructions: [`local:${options.instructionsDir}`],

      policy: {
        allowedHosts: ["github.com"],
        allowedOwners: ["anthropics"],
        // These skills legitimately ship helper scripts, so warn rather than refuse.
        scripts: "warn",
        scan: "deny",
        // A skill can declare its own MCP servers and instruction fragments. With
        // these false, anything it tries to add is dropped with a warning instead
        // of silently attached — which matters most for instructions, since those
        // go straight into the agent's standing context.
        allowTransitiveMcp: false,
        allowTransitiveInstructions: false,
      },
    },

    // Only needed for private sources; for a public repo a token merely lifts the
    // anonymous API rate limit. Returning undefined means "fetch anonymously".
    auth: (host) => (host === "github.com" ? process.env.GITHUB_TOKEN : undefined),

    onEvent: options.onEvent,
  });

  const install = await outfitter.install();

  // Read after installing: the MCP entries are populated by the install, and the
  // paths resolve against the root it ran under.
  return { target, outfitter, install, sdk: target.sdkOptions() };
};
