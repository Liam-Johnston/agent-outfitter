/**
 * Outfitting Codex: a complete, self-contained example.
 *
 * ```ts
 * import { Codex } from "@openai/codex-sdk";
 * import { setupCodex } from "./harness/codex.ts";
 *
 * const { sdk } = await setupCodex({ instructionsDir: "./instructions" });
 *
 * // sdk.env carries CODEX_HOME, where the skills were just installed. Spread it
 * // over process.env rather than passing it alone; Codex needs PATH and its own
 * // credentials from the ambient environment too.
 * const codex = new Codex({ env: { ...process.env, ...sdk.env }, config: sdk.config });
 * const thread = codex.startThread({ workingDirectory: process.cwd(), skipGitRepoCheck: true });
 * await thread.run("Use the pdf skill to summarise ./report.pdf");
 * ```
 *
 * The SDK call is left to the caller because this file is also driven by the smoke
 * test, which asserts on the options rather than starting an agent.
 */

import {
  codexTarget,
  createAgentManager,
  type AgentManager,
  type CodexSdkOptions,
  type CodexTarget,
  type InstallResult,
  type OutfitterEvent,
} from "agent-outfitter";

export interface SetupOptions {
  /** Directory holding local instruction fragments. */
  instructionsDir: string;
  /** Progress and audit stream. */
  onEvent?: (event: OutfitterEvent) => void;
}

export interface CodexSetup {
  target: CodexTarget;
  /** Kept so a later `sync()` or `verify()` needs nothing rebuilt. */
  outfitter: AgentManager;
  install: InstallResult;
  /** Ready to spread into `new Codex({ ... })`. */
  sdk: CodexSdkOptions;
}

/**
 * Install this project's primitives into Codex and return the SDK wiring.
 *
 * `codexTarget()` takes no arguments, so it uses its defaults: skills into
 * `$CODEX_HOME/skills` (falling back to `~/.codex/skills`), MCP servers into
 * `config.toml`, instructions into `AGENTS.md`. Pass `{ codexHome }` to install
 * somewhere specific, or `{ scope: "project" }` for `<project>/.agents/skills`.
 */
export const setupCodex = async (options: SetupOptions): Promise<CodexSetup> => {
  const target = codexTarget();

  const outfitter = createAgentManager({
    targets: [target],
    // `root` defaults to process.cwd(). It is where the lockfile is read and
    // written, so commit that file and `sync()` reproduces this install exactly.
    manifest: {
      version: 1,

      // `#main` is resolved to a commit once, at install time, and that commit is
      // what the lockfile pins, so the branch moving later does not change what
      // `sync()` installs.
      sources: [{ ref: "github:anthropics/skills#main", select: ["pdf", "xlsx", "mcp-builder"] }],

      // Neither server carries a secret: `bearerEnv` and `envVars` name
      // environment variables, and the values are read at the point of use rather
      // than written into config.toml.
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

      // Merged into AGENTS.md inside a marked region, leaving anything you wrote
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
        // of silently attached, which matters most for instructions, since those
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
