/**
 * Outfitting a whole committed harness: AWS AI-DLC, pinned, into Claude Code.
 *
 * ```ts
 * import { setupAidlc } from "./harness/aidlc.ts";
 *
 * const { install } = await setupAidlc();
 * // The project now holds the engine, its 40 skills, and its settings.
 * ```
 *
 * A framework like this is mostly *not* skills. Measured against the tree it
 * ships, 40 files are skills and the other ~230 are engine: `tools/` the skills
 * shell into, `knowledge/` they read, `hooks/` that fire on every tool call, a
 * stage protocol, and a `settings.json` that wires all of it up. Install only the
 * skills and you get 40 skills that fail on first invocation, because every one of
 * them runs `bun .claude/tools/aidlc-orchestrate.ts`.
 *
 * So this uses four kinds at once, and the division of labour between them is the
 * point:
 *
 * - `sources`   — the skills, discovered by `SKILL.md`, hashed and pinned one by one.
 * - `bundles`   — the engine, an opaque subtree copied verbatim to declared paths.
 * - `settings`  — `.claude/settings.json`, merged key by key into whatever is there.
 * - `instructions` — `rules/aidlc.md`, spliced into `CLAUDE.md` inside a marked region.
 *
 * Nothing here runs any of the code it installs. AI-DLC compiles its own stage
 * graph on first use, through a `PostToolUse` hook it registers itself, which is
 * why agent-outfitter does not need a post-install command and does not have one.
 */

import {
  claudeTarget,
  createAgentManager,
  type AgentManager,
  type ClaudeTarget,
  type InstallResult,
  type OutfitterEvent,
} from "agent-outfitter";

export interface AidlcSetupOptions {
  /** Progress and audit stream. */
  onEvent?: (event: OutfitterEvent) => void;
}

export interface AidlcSetup {
  target: ClaudeTarget;
  outfitter: AgentManager;
  install: InstallResult;
}

/** The tag everything is pinned to. A tag is resolved to a commit once, at install. */
const REF = "v2";

/**
 * The published Claude harness inside the repository.
 *
 * AI-DLC builds one tree per harness under `dist/`, so the useful root is
 * `dist/claude` rather than the repository root. Skills need no path at all:
 * `.claude/skills` is one of the conventional roots agent-outfitter probes, so
 * pointing a source at `dist/claude` finds all 40 on its own.
 */
const HARNESS_ROOT = "dist/claude";

/**
 * The engine, as source-to-destination pairs.
 *
 * Declared rather than discovered, because none of these directories announce
 * themselves the way a skill folder does. Note that `aidlc/` lands *outside*
 * `.claude/`: a bundle can write anywhere under the target root, which is a wider
 * reach than any other kind, and the reason `policy.executableHarness` has to be
 * opted into below.
 *
 * `.claude/skills` and `.claude/settings.json` are deliberately absent: they are
 * installed as skills and settings, which gets them per-skill hashes and
 * ownership-tracked merging instead of a verbatim copy.
 */
const ENGINE_PATHS = {
  ".claude/agents": ".claude/agents",
  ".claude/aidlc-common": ".claude/aidlc-common",
  ".claude/hooks": ".claude/hooks",
  ".claude/knowledge": ".claude/knowledge",
  ".claude/scopes": ".claude/scopes",
  ".claude/sensors": ".claude/sensors",
  ".claude/tools": ".claude/tools",
  aidlc: "aidlc",
} as const;

export const setupAidlc = async (options: AidlcSetupOptions = {}): Promise<AidlcSetup> => {
  const target = claudeTarget({ consumer: "code" });

  const outfitter = createAgentManager({
    targets: [target],
    manifest: {
      version: 1,

      sources: [{ ref: `github:awslabs/aidlc-workflows/${HARNESS_ROOT}#${REF}` }],

      bundles: [
        {
          ref: `github:awslabs/aidlc-workflows/${HARNESS_ROOT}#${REF}`,
          name: "aidlc-engine",
          paths: { ...ENGINE_PATHS },
        },
      ],

      // Merged into `.claude/settings.json` key by key. A `settings.json` the
      // project already has keeps everything it holds; only the keys this
      // fragment introduces are recorded as agent-outfitter's, and only those are
      // removed again by `remove("aidlc-settings")`.
      settings: [
        {
          ref: `github:awslabs/aidlc-workflows/${HARNESS_ROOT}/.claude/settings.json#${REF}`,
          name: "aidlc-settings",
        },
      ],

      instructions: [
        { ref: `github:awslabs/aidlc-workflows/${HARNESS_ROOT}/.claude/rules#${REF}` },
      ],

      policy: {
        allowedHosts: ["github.com"],
        allowedOwners: ["awslabs"],

        /**
         * The consent this install actually requires.
         *
         * Defaults to `"deny"`, and refusing by default is the correct behaviour:
         * this harness registers 18 hooks across 8 lifecycle events, a status-line
         * command, and `permissions.allow` entries that pre-approve `Bash`. That
         * code runs whether or not anything invokes it, so it is not covered by
         * consenting to a skill's `scripts/` folder. `"warn"` installs it and says
         * what was registered; `"allow"` installs it silently.
         */
        executableHarness: "warn",

        // The engine legitimately ships executable code; `scripts` is about a
        // skill's own helper scripts, which is a different question.
        scripts: "warn",

        /**
         * `"warn"` rather than `"deny"`, on evidence.
         *
         * Four files in this engine carry a U+FEFF mid-file (in `aidlc-graph.ts`
         * and `aidlc-lib.ts` among others), which is legitimate: a zero-width
         * no-break space used inside a string literal, not a hidden directive. The
         * scanner exempts a BOM at offset 0 and nothing else, correctly, so a
         * `"deny"` here refuses the install outright.
         *
         * Which is the right trade for a repository of prose skills and the wrong
         * one for a large engine tree. `"warn"` still reports every occurrence with
         * a file and column, so the finding is reviewable rather than invisible.
         */
        scan: "warn",
      },
    },

    // Public repository, so this only lifts the anonymous API rate limit.
    auth: (host) => (host === "github.com" ? process.env.GITHUB_TOKEN : undefined),

    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  const install = await outfitter.install();
  return { target, outfitter, install };
};

/** Exported for the smoke test, which asserts against the declared paths. */
export const AIDLC_ENGINE_PATHS = ENGINE_PATHS;
export const AIDLC_REF = REF;
export const AIDLC_HARNESS_ROOT = HARNESS_ROOT;
