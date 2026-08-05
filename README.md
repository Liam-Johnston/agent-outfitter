# agent-outfitter

**A library-first agent package manager.** Outfit an agent harness with the primitives it
needs — skills, MCP servers, instruction fragments — resolved from git, pinned in a lockfile,
content-hash verified, behind an `await`-able TypeScript API rather than a CLI.

```ts
import { Codex } from "@openai/codex-sdk";
import { createAgentManager, codexTarget } from "agent-outfitter";

const CODEX_HOME = "/workspace/.codex-home";

const outfitter = createAgentManager({
  targets: [codexTarget({ codexHome: CODEX_HOME, scope: "user" })],
  auth: (host, owner) => (owner === "acme" ? process.env.SKILLS_TOKEN : undefined),
  policy: { allowedOwners: ["acme", "anthropics"], scripts: "warn" },
});

const { installed, lockfilePath } = await outfitter.install({
  refs: [
    {
      source: { type: "git", url: "https://github.com/acme/agent-skills.git", ref: "v1.4.0" },
      select: ["csv-insights", "pdf-extract"],
    },
  ],
  instructions: [{ ref: "github:acme/agent-config/instructions", select: ["house-style"] }],
});
console.log(installed.map((p) => `${p.kind}:${p.name}@${p.commit.slice(0, 7)}`), "→", lockfilePath);

// Codex auto-discovers the skills; AGENTS.md and config.toml are already merged.
const codex = new Codex({ env: { ...process.env, CODEX_HOME } });
const thread = codex.startThread({ workingDirectory: "/workspace/project", skipGitRepoCheck: true });
await thread.run("Use the csv-insights skill to summarize ./data");
```

## Why

APM, the Vercel `skills` CLI, and `skillpm` all run the same pipeline — resolve a source,
fetch what it holds, materialize it where the agent looks, record a lockfile — but all three
are CLI-first, with the install logic in unexported internals. When you build an agent
harness *in process*, shelling out to a CLI means a child process, brittle agent
auto-detection, standard-location writes that ignore a custom `CODEX_HOME`, and no typed
result to branch on.

agent-outfitter is that pipeline as a library — and it isn't limited to skills. A working
agent needs its skills *and* its tool servers *and* its standing instructions, all pinned
together, so all three are primitives in one graph with one lockfile.

- **Library-first.** Nothing runs on import; nothing is written until you call an install method.
- **Multi-primitive.** Skills, MCP servers, and instruction fragments today, behind one
  resolver, one policy engine, and one lockfile.
- **Monorepo-native.** Install one, several, or all skills from a repo holding many, with
  cherry-pick and glob selection.
- **Reproducible.** Every primitive pins an exact commit plus a content hash. `sync()` is the
  CI entrypoint and fails on drift.
- **Harness-oriented.** Targets are agent *harnesses* — Claude Code and Codex first — not
  models. Whatever model the harness runs is irrelevant.
- **Merge, never clobber.** Config files and instruction files belong to you.
  agent-outfitter only ever touches the entries and regions it owns.
- **Safe by default.** Content-hash verification, source allowlists, hidden-Unicode scanning,
  trust gating on anything a dependency tries to add. It never executes skill code.

## Install

```sh
bun add agent-outfitter      # or: npm i agent-outfitter
```

Requires Node ≥ 18 (or Bun). No `git` binary needed — trees arrive as tarballs.
`openai` is an optional peer, used only by `openaiHostedTarget`.

## Primitives

| Kind | Source shape | Materializes to | Status |
|---|---|---|---|
| `skill` | `SKILL.md` folder | `$CODEX_HOME/skills/<name>`, `.claude/skills/<name>` | ✅ |
| `mcp` | manifest entry or frontmatter dep | `config.toml` `[mcp_servers.*]`, `.mcp.json` | ✅ |
| `instruction` | markdown fragment | marked region in `AGENTS.md` / `CLAUDE.md` | ✅ |
| `plugin`, `agent`, `prompt`, `hook` | — | — | parsed and recorded, not yet installed |

The deferred kinds resolve and surface as `resolution.unsupported` plus a `not-implemented`
warning rather than an error, so a manifest written against full APM parity works today and
starts installing them later without a breaking change.

## The API

```ts
const outfitter = createAgentManager(config?: AgentManagerConfig): AgentManager;
```

| Method | What it does |
|---|---|
| `resolve(input?)` | Manifest/refs → transitive graph + plan. Network reads only, no writes. |
| `install(input?)` | Fetch, verify, materialize into every target, write the lockfile. |
| `add(ref, opts?)` | Record a ref in the manifest, then install just it and its dependencies. |
| `sync(opts?)` | Deterministic reinstall strictly from the lockfile. The CI entrypoint. |
| `list(opts?)` | What's installed — lockfile ∩ target state. |
| `remove(name, opts?)` | Delete a skill or fragment from targets, lockfile, and the manifest. |
| `verify(opts?)` | Re-hash installed files and instruction regions against the lockfile. |

`resolve()` is pure in the sense that matters: it reads the network, populates a cache
directory, and returns a plan. Nothing lands in a target until you install.

```ts
// Diff before committing to anything.
const plan = await outfitter.resolve();
console.log(plan.order);          // skills, dependency-first
console.log(plan.instructions);   // fragments that passed the trust gate
console.log(plan.warnings);       // policy findings, dropped primitives, conflicts
const dry = await outfitter.install({ resolution: plan, dryRun: true });
```

`install()` returns one flat `installed` list covering every kind, each entry tagged:

```ts
const { installed } = await outfitter.install();
const skills = installed.filter((p) => p.kind === "skill");
const fragments = installed.filter((p) => p.kind === "instruction");
```

### Config

```ts
createAgentManager({
  root,        // where the manifest and lockfile live. Default process.cwd()
  manifest,    // path or inline object. Default: probe <root>/outfitter.config.*
  targets,     // adapters, or built-in names. Overridable per call
  sources,     // extra SourceProvider plugins; git + local are always present
  auth,        // (host, owner) => token | undefined
  cacheDir,    // default: the OS cache dir
  policy,      // trust + verification policy, merged over the manifest's
  onEvent,     // structured progress + audit stream
  concurrency, // max parallel source fetches. Default 6
});
```

## Manifest

`outfitter.config.ts` (typed, computable), `outfitter.config.yaml`, or
`outfitter.config.json`. All three parse to the same shape; the serializable forms are the
ones `add()`/`remove()` can edit in place.

```ts
// outfitter.config.ts
import { defineConfig, codexTarget } from "agent-outfitter";

export default defineConfig({
  version: 1,
  targets: [codexTarget({ codexHome: process.env.CODEX_HOME!, scope: "user" })],

  sources: [
    { ref: "github:acme/agent-skills#v1.4.0", select: ["csv-insights", "pdf-extract"] },
    { ref: "github:anthropics/skills/skills/pdf" },
    { ref: "github:acme/internal-skills#main", auth: { env: "SKILLS_TOKEN" } },
    { ref: "local:./skills" },
  ],

  mcp: [
    { name: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/",
      auth: { bearerEnv: "GITHUB_MCP_TOKEN" } },
    { name: "filesystem", transport: "stdio", command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"] },
  ],

  instructions: [
    { ref: "github:acme/agent-config/instructions", select: ["house-style", "review-*"] },
    { ref: "github:acme/agent-config/instructions/tone.md", name: "voice" },
    "local:./instructions",
  ],

  policy: {
    allowedHosts: ["github.com"],
    allowedOwners: ["acme", "anthropics"],
    requireLockHashMatch: true,
    scripts: "warn",                     // "allow" | "warn" | "deny"
    scan: "warn",                        // hidden-Unicode: "off" | "warn" | "deny"
    allowTransitiveMcp: false,
    allowTransitiveInstructions: false,
    allowedMcpHosts: ["api.githubcopilot.com"],
  },
});
```

A TypeScript manifest needs a runtime that strips types (Bun, `tsx`, or Node ≥ 22.18). Use
YAML or JSON otherwise — you get a clear error, not a crash.

### Ref grammar

`<provider>:<owner>/<repo>[/<subdir>][#<ref>]` — providers `github` (`gh`), `gitlab`,
`bitbucket`, `sourcehut`, `git` (raw URL), `local` (`file`). `<ref>` is a branch, tag, or
commit; `./path` and `/abs/path` are shorthand for `local:`.

### Monorepo selection

A source root containing `SKILL.md` *is* a single skill. Otherwise agent-outfitter looks for
a conventional `skills/`, `.agents/skills/`, or `.claude/skills/` directory, then falls back
to the root's own child directories — the convention wins deliberately, because real
monorepos keep skills in `skills/` while also carrying a `template/` folder that is itself a
valid skill. Override with `skillsRoot`. `select` accepts names or globs (`*`, `**`, `?`,
`{a,b}`), matched against both the declared name and the folder name; no `select` installs
everything found. A `select` matching nothing is an error listing what was available.

## Instruction fragments

An instruction ref addresses either one markdown file or a directory of them:

```ts
instructions: [
  { ref: "github:acme/agent-config/instructions" },                       // all fragments
  { ref: "github:acme/agent-config/instructions", select: ["house-*"] },  // filtered
  { ref: "github:acme/agent-config/instructions/tone.md", name: "voice" } // one, renamed
]
```

Each fragment is merged into the target's instruction file inside a marked region:

```md
# My own notes, written by hand and never touched

<!-- BEGIN agent-outfitter: house-style -->
Use British spelling. Prefer active voice.
<!-- END agent-outfitter: house-style -->
```

Which is what makes the operation safe to repeat: reinstall replaces the region in place (so a
block you moved keeps its position), removal deletes exactly one region, and anything outside
a region is preserved byte for byte. A file left with nothing but removed regions is deleted
rather than left as litter.

`verify()` re-hashes each region against the lockfile, so an edit *inside* a managed region is
reported as `instruction-drift`, and `sync()` restores the pinned text.

## Targets

Explicit and pluggable — no "detect installed agents" guesswork. Each declares which primitive
kinds it supports, so anything it can't take is reported rather than silently dropped.

| Target | Skills | MCP servers | Instructions |
|---|---|---|---|
| `codexTarget({ codexHome, scope, projectDir, mcpMode, instructionFile })` | `$CODEX_HOME/skills/<name>` or `<projectDir>/.agents/skills/<name>` | `config.toml` → `[mcp_servers.*]` | `AGENTS.md` |
| `claudeTarget({ dir, mode, scope, consumer, instructionFile })` | `<dir>/.claude/skills/<name>`, or a plugin bundle | `.mcp.json` → `mcpServers` | `CLAUDE.md` |
| `filesystemTarget({ dir, mcpFile, instructionFile })` | `<dir>/<name>` | `<dir>/mcp.json` | `<dir>/AGENTS.md` |
| `openaiHostedTarget({ client \| upload })` | uploaded, returns `skillId` | — | — |

Install to several at once (`targets: [codex, claude]`); each gets its own
`InstalledPrimitive` entries and its own lockfile record.

**Skills need no config; MCP and instructions do.** Both Codex and Claude Code auto-discover
skills from their skill directories — dropping the folder in *is* the whole install. Files are
touched only for the primitives that are not auto-discovered, so a manifest with no `mcp` and
no `instructions` writes zero config.

For Codex you can skip `config.toml` entirely: `codexTarget({ mcpMode: "sdk-config" })` writes
no file and instead exposes the entries on `target.mcpConfigOverrides`, ready for
`@openai/codex-sdk`'s `config` option.

### SDK handoff

The harness *apps* find their own skills. An **SDK running in your process** does not
always: the Claude Agent SDK reads no filesystem skills unless you pass `settingSources`
or `plugins`, and Codex needs to be pointed at the `CODEX_HOME` you installed into. That
gap is where a successful install turns into an agent that starts cleanly and silently
knows nothing.

`sdkOptions()` closes it. The target computed those paths to write to them, so it hands
the same ones back:

```ts
import { Codex } from "@openai/codex-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createAgentManager, claudeTarget, codexTarget } from "agent-outfitter";

const codexT = codexTarget({ codexHome: "/workspace/.codex-home", scope: "user" });
const claudeT = claudeTarget({ dir: "/workspace/project", consumer: "agent-sdk" });

const outfitter = createAgentManager({ targets: [codexT, claudeT] });
await outfitter.install();

// Codex: CODEX_HOME plus the MCP entries, in Codex's own config shape.
const codexSdk = codexT.sdkOptions();
const codex = new Codex({ env: { ...process.env, ...codexSdk.env }, config: codexSdk.config });

// Claude: settingSources — the option whose absence loads no skills at all.
for await (const message of query({ prompt, options: { ...claudeT.sdkOptions() } })) { … }
```

Call it after `install()` or `sync()`; the MCP entries are populated by the install. It
resolves paths against the context that install ran under, so it needs no arguments.

| | `codexTarget().sdkOptions()` | `claudeTarget().sdkOptions()` |
|---|---|---|
| Points the harness at the install | `env.CODEX_HOME` | `settingSources`, or `plugins` in `mode: "plugin"` |
| MCP servers | `config.mcp_servers` | `mcpServers` |
| Project anchor | — | `cwd` |
| Informational | `skillsDir`, `instructionPath` | `skillsDir`, `instructionPath` |

**One asymmetry worth knowing.** Files on disk keep secrets as env-var *names* —
`.mcp.json` gets `${GITHUB_MCP_TOKEN}`, which Claude Code expands when it reads the file.
Nothing performs that expansion on an in-process options object, so a placeholder there
would arrive at the SDK as a broken credential. `sdkOptions().mcpServers` therefore
carries **resolved values**: hand it to the SDK, and don't log it or write it anywhere. A
referenced variable that is unset is reported as a warning at install time rather than
becoming an opaque `401` on the agent's first tool call.

`consumer: "agent-sdk"` additionally warns at install time, because the failure it guards
against is silent — an SDK built without these options runs happily and never loads a
skill.

### Custom targets

```ts
import {
  materializeToDir, installedHash, writeInstructionFile, type AgentTarget,
} from "agent-outfitter";

const myTarget: AgentTarget = {
  name: "my-harness",
  supports: ["skill", "instruction"],
  resolveDir: (kind, ctx) =>
    kind === "instruction" ? `${ctx.root}/.my-agent/AGENTS.md` : `${ctx.root}/.my-agent/skills`,
  materialize: (input) => materializeToDir(`${input.ctx.root}/.my-agent/skills`, input),
  currentHash: (name, ctx) => installedHash(`${ctx.root}/.my-agent/skills`, name),
  writeInstructions: (input) =>
    writeInstructionFile(`${input.ctx.root}/.my-agent/AGENTS.md`, input),
};
```

`currentHash` is what lets the manager skip an unchanged skill without writing. Omit it and
every install re-materializes.

## Transitive dependencies

A skill declares what it needs in its own frontmatter — other skills, MCP servers, and
instruction fragments:

```yaml
---
name: csv-insights
description: Summarize CSV files and produce a markdown report.
dependencies:
  skills:
    - github:acme/agent-skills/skills/shared-csv-utils
  mcp:
    - name: csv-mcp
      transport: stdio
      command: npx
      args: ["-y", "@acme/csv-mcp"]
  instructions:
    - ref: github:acme/agent-skills/instructions/csv-conventions.md
---
```

The resolver walks to closure, dedupes by `(kind, name)`, detects cycles (`CycleError`), and
topologically sorts skills so dependencies install first. Relative `local:` refs anchor to the
declaring skill's own folder, so a sibling is `../name`.

**What a dependency adds is gated.** An MCP server or instruction fragment pulled in by a
skill rather than declared in your manifest is *dropped with a warning* unless it passes
`policy.allowTransitiveMcp` / `allowTransitiveInstructions` (or an allowlist). That's the
non-interactive analogue of APM's MCP trust prompt, and it matters more for instructions than
anything else: a fragment is text spliced straight into the agent's standing context, so a
skill that could add one silently could rewrite the agent's operating rules without appearing
anywhere in your manifest.

## Lockfile

`outfitter.lock.json` pins every primitive to an exact commit plus a content hash, and records
which entries and regions agent-outfitter owns in each target.

```jsonc
{
  "version": 1,
  "skills": {
    "csv-insights": {
      "source": { "type": "git", "url": "https://github.com/acme/agent-skills.git",
                  "subdir": "skills/csv-insights" },
      "ref": "v1.4.0",
      "commit": "e24616c9f0…",
      "contentHash": "sha256-9f86d0818…",
      "files": ["SKILL.md", "scripts/summarize.py"],
      "dependencies": ["shared-csv-utils"],
      "mcp": [], "transitive": false
    }
  },
  "mcp": { "github": { "transport": "http", "url": "…", "declaredBy": "manifest",
                       "configHash": "sha256-…", "trusted": true } },
  "instructions": {
    "house-style": { "source": { "…": "…" }, "subdir": "instructions/house-style.md",
                     "contentHash": "sha256-…", "declaredBy": "manifest", "trusted": true }
  },
  "targets": {
    "codex": {
      "skills": { "csv-insights": "/workspace/.codex-home/skills/csv-insights" },
      "mcp": ["github"], "mcpConfigPath": "…/config.toml",
      "instructions": ["house-style"], "instructionPath": "…/AGENTS.md"
    }
  }
}
```

A skill's `contentHash` is sha256 over a canonical serialization — every file, sorted by
relative POSIX path, each length-delimited. File modes, timestamps, and directory entries are
excluded on purpose: tarball extraction does not preserve modes, so including them would make
the hash depend on *how* a tree was fetched rather than *what* it contains. Serialized output
is fully key-sorted, so a lockfile committed from two machines diffs empty.

Commit resolution happens at resolve time via each host's REST API, with git's smart-HTTP ref
advertisement as a fallback. That's what makes a moved tag harmless: `sync()` installs the
commit that was pinned.

### CI

```ts
// Commit outfitter.lock.json. In CI:
await outfitter.sync(); // fetches pinned commits, re-hashes, fails on any drift
```

`install()` and `sync()` treat hashes differently, deliberately. A *new* commit with a new
hash is an ordinary upgrade and just updates the lockfile. The **same** commit hashing
differently means the bytes behind an immutable identifier moved — the signature of a tampered
mirror — and raises `HashMismatchError`. `sync()` enforces the lockfile outright.

## Ephemeral environments

A container that spins up for a single task, outfits an agent, and exits is the case the
library is shaped for: `resolve()` and `install()` are the two halves of exactly that
startup, and `sdkOptions()` is how the result reaches the SDK you then construct.

Two things follow from a container being *fresh*:

**The cache is cold, so every fetch is live.** There is no warm tree to fall back on and
no second attempt from a human watching a terminal, so transient network failures are
retried: three attempts with jittered exponential backoff, on 5xx, 429, 408, 425, and
transport-level errors. A 401, 403, or 404 is *not* retried — a bad token or a wrong ref
will still be bad three seconds later, and retrying only delays a clear error. Retries
surface as `source:retry` events.

**Paths must be explicit, not inherited.** `AGENT_OUTFITTER_CACHE_DIR` overrides the cache
location, which otherwise sits under `$HOME`. Pin it in the image: a container that builds
as one user and runs as another will otherwise warm a cache in one place and read from
another, and `$HOME` is the variable most likely to differ between the two.

```ts
// Container entrypoint, in-process.
const target = claudeTarget({ dir: "/workspace/project", consumer: "agent-sdk" });
const outfitter = createAgentManager({
  root: "/workspace/project",
  targets: [target],
  manifest: {
    version: 1,
    sources: [{ ref: "github:anthropics/skills#main", select: ["pdf", "xlsx"] }],
    mcp: [{ name: "github", transport: "http", url: "…", auth: { bearerEnv: "GH_MCP" } }],
  },
  onEvent: (e) => {
    if (e.type === "source:retry") log.warn({ attempt: e.attempt }, "retrying source");
  },
});

await outfitter.install();
for await (const m of query({ prompt, options: { ...target.sdkOptions() } })) { … }
```

If you commit a lockfile, prefer `sync()`: it resolves nothing, reads pinned commits
straight from the lockfile, and never touches a host's ref API — so a warm cache baked into
an image layer makes it a zero-network install.

`smoke/` holds a container test of all of this against the real network, one image per
harness, installing into the library's *default* locations and bind-mounting the result
to `test-output/` so it can be inspected from the host — see
[smoke/README.md](smoke/README.md), or run `make smoke`.

Its `smoke/app/harness/{codex,claude}.ts` are also the worked examples for each harness:
one self-contained `setupCodex()` / `setupClaude()` apiece, covering manifest through
install through SDK handoff, with no test scaffolding mixed in and no local imports to
follow. They are typechecked in CI, so they compile against the library as shipped.

## Security

Skills ship code that runs in the agent's environment and instructions shape what the agent
believes, so provenance is a first-class concern rather than a lint:

- **Content-hash pinning** — mismatch raises `HashMismatchError` (unless
  `requireLockHashMatch: false`).
- **Source allowlists** — `allowedHosts` / `allowedOwners` gate resolution before a byte is
  fetched; violations raise `PolicyViolationError`.
- **Hidden-Unicode scan** — bidi overrides, zero-width characters, and Unicode tag characters
  are a prompt-injection vector a human reading the diff cannot see. Reported with file, line,
  column, and code point. Applied to instruction fragments too, where it matters most.
- **Script policy** — `scripts: "allow" | "warn" | "deny"` controls whether skills bundling
  `scripts/` may install at all.
- **Trust gating** — nothing a dependency introduces reaches a target without the operator
  opting in.
- **No implicit exec** — agent-outfitter only places files and merges text. The agent runtime
  executes what it finds under its own sandbox and approval policy.
- **Secrets by reference** — tokens come from env-var *names*, never values, and never enter a
  manifest, a lockfile, a generated config, or a log line. The one deliberate exception is
  `sdkOptions().mcpServers`, which must carry values because nothing downstream would expand
  a placeholder; see [SDK handoff](#sdk-handoff).

## Events

`onEvent` receives a discriminated union — `resolve:start`, `source:listed`, `resolve:done`,
`source:retry`, `skill:fetched`, `skill:verified`, `skill:materialized`, `skill:skipped`,
`skill:removed`, `mcp:configured`, `instruction:written`, `instruction:removed`,
`lockfile:written`, `install:done`, and `warning`. Enough for a progress UI, an audit log, or
CI annotations, with no `console` coupling.

## Errors

`OutfitterError` is the base; every subclass carries a `code` and a `detail` object:
`SourceResolutionError`, `SkillNotFoundError`, `HashMismatchError`, `PolicyViolationError`,
`CycleError`, `TargetError`, `AuthError`, `ManifestError`, `LockfileError`,
`NotImplementedError`.

## Development

```sh
make install
make check        # typecheck + lint + 190 tests, no network required
make build        # dist/index.js + .d.ts
make smoke        # container test, both harnesses — needs Docker and network
```

Tests use `local:` sources throughout, so the whole resolve → verify → materialize → lockfile
loop is covered offline. A fixture `SourceProvider` stands in for a git host where
commit-pinning behaviour is under test, and `globalThis.fetch` is stubbed where retry
behaviour is.

What that leaves uncovered is deliberate, and is what `make smoke` exists for: the published
package resolving in a clean container, real sources over the real network, and the SDK
handoff pointing where the install actually wrote. `make check` needs no network; `make
smoke` needs Docker and one. CI runs both — the smoke test as its own job, one harness per
matrix entry in parallel, uploading the installed tree as an artifact.

Releases go through Changesets and npm Trusted Publishing (OIDC) — no long-lived `NPM_TOKEN`,
provenance attached automatically. Add a changeset with `bun run changeset`.

## License

MIT
