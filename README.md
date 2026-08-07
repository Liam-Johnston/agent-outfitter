# agent-outfitter

[![npm](https://img.shields.io/npm/v/agent-outfitter.svg)](https://www.npmjs.com/package/agent-outfitter)

Install agent skills, MCP servers, instruction fragments, and whole committed harnesses from
git into Claude Code, Codex, or any harness you write an adapter for. It is a TypeScript
library, not a CLI: you import a function, `await` it, and get a typed result. Every primitive
is pinned to an exact commit and a content hash in a lockfile.

```ts
// Run from /workspace/project. claudeTarget() with no arguments installs into
// the working directory's .claude/, which is where Claude Code looks.
import { createAgentManager, claudeTarget } from "agent-outfitter";

const outfitter = createAgentManager({
  targets: [claudeTarget()],
  manifest: {
    version: 1,
    sources: [{ ref: "github:anthropics/skills#main", select: ["pdf", "xlsx"] }],
  },
});

const { installed, lockfilePath } = await outfitter.install();

for (const p of installed) console.log(p.kind, p.name, p.path);
// skill pdf  /workspace/project/.claude/skills/pdf
// skill xlsx /workspace/project/.claude/skills/xlsx
console.log(lockfilePath);
// /workspace/project/outfitter.lock.json
```

Claude Code picks those skills up on its next run. Nothing else to configure.

## Install

```sh
bun add agent-outfitter      # or: npm i agent-outfitter
```

Node >= 18 or Bun. No `git` binary required, since trees are fetched as tarballs. `openai` is
an optional peer dependency, used only by `openaiHostedTarget`.

## Why a library

APM, Vercel's `skills` CLI, and `skillpm` run the same pipeline: resolve a source, fetch what
it holds, write it where the agent looks, record a lockfile. All three are CLI-first, with that
pipeline living in unexported internals. Shelling out to one from a process that is building an
agent gets you a child process, agent auto-detection you cannot override, writes to standard
locations that ignore your `CODEX_HOME`, and stdout to parse instead of a typed result.

This is the same pipeline as an importable function, covering more than skills. A working agent
needs its skills, its tool servers, and its standing instructions pinned together, so all three
are primitives in one graph behind one lockfile.

- Nothing runs on import. Nothing is written until you call `install()`, `add()`, or `sync()`.
- Every primitive pins an exact commit plus a content hash. `sync()` reinstalls from the
  lockfile and fails on drift.
- Targets are named explicitly. There is no "detect installed agents" step.
- Config files and instruction files are merged, never rewritten. Only the entries and marked
  regions agent-outfitter owns are touched.
- Skill code is never executed. Files are copied and text is merged, nothing more.

## Quick start

Both examples below are condensed from `smoke/app/harness/`, which is typechecked in CI and
run against the real network by `make smoke`.

### Claude Agent SDK

The Agent SDK loads no filesystem skills unless you pass `settingSources`, so an install alone
is not enough. `sdkOptions()` returns the options that point the SDK at what was just written.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createAgentManager, claudeTarget } from "agent-outfitter";

const target = claudeTarget({ dir: "/workspace/project", consumer: "agent-sdk" });

const outfitter = createAgentManager({
  root: "/workspace/project",
  targets: [target],
  manifest: {
    version: 1,
    sources: [{ ref: "github:anthropics/skills#main", select: ["pdf", "xlsx", "mcp-builder"] }],
    mcp: [
      {
        name: "github",
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
        auth: { bearerEnv: "GITHUB_MCP_TOKEN" },
      },
    ],
    instructions: ["local:./instructions"],
    policy: { allowedOwners: ["anthropics"], scripts: "warn", scan: "deny" },
  },
});

await outfitter.install();

for await (const message of query({
  prompt: "Summarize ./report.pdf using the pdf skill",
  options: { ...target.sdkOptions() },
})) {
  console.log(message);
}
```

Targeting the Claude Code app instead of the SDK? Pass `consumer: "code"` and ignore
`sdkOptions()` entirely. The app reads the files directly.

### Codex

```ts
import { Codex } from "@openai/codex-sdk";
import { createAgentManager, codexTarget } from "agent-outfitter";

const target = codexTarget({ codexHome: "/workspace/.codex-home", scope: "user" });

const outfitter = createAgentManager({
  targets: [target],
  manifest: {
    version: 1,
    sources: [{ ref: "github:anthropics/skills#main", select: ["pdf", "xlsx"] }],
  },
});

await outfitter.install();

// sdk.env carries CODEX_HOME. Spread it over process.env rather than passing it
// alone, since Codex also needs PATH and its own credentials.
const sdk = target.sdkOptions();
const codex = new Codex({ env: { ...process.env, ...sdk.env }, config: sdk.config });

const thread = codex.startThread({ workingDirectory: "/workspace/project", skipGitRepoCheck: true });
await thread.run("Use the xlsx skill to chart ./data.xlsx");
```

### What lands on disk

Running the Claude example above, with a stdio `filesystem` server added alongside the `github`
one, produces this:

```
/workspace/project/.claude/skills/pdf/          SKILL.md, reference.md, forms.md, scripts/*
/workspace/project/.claude/skills/xlsx/
/workspace/project/.claude/skills/mcp-builder/
/workspace/project/.mcp.json                    mcpServers entries, merged
/workspace/project/CLAUDE.md                    one managed region, rest untouched
/workspace/project/outfitter.lock.json
```

`.mcp.json` keeps tokens as env-var names, so the file is safe to commit:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" }
    },
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace/project"],
      "env": { "HOME": "${HOME}" }
    }
  }
}
```

The Codex target writes the same two servers into `config.toml`:

```toml
[mcp_servers.github]
url = "https://api.githubcopilot.com/mcp/"
bearer_token_env_var = "GITHUB_MCP_TOKEN"

[mcp_servers.filesystem]
command = "npx"
args = [ "-y", "@modelcontextprotocol/server-filesystem", "/workspace/project" ]
env_vars = [ "HOME" ]
```

And `CLAUDE.md` gains a marked region, with everything you wrote by hand left alone:

```md
# House rules

Written by a human. Survives every install.

<!-- BEGIN agent-outfitter: house-style -->
Use British spelling. Prefer active voice.
<!-- END agent-outfitter: house-style -->
```

## Primitives

| Kind | Source shape | Materializes to | Status |
|---|---|---|---|
| `skill` | `SKILL.md` folder | `$CODEX_HOME/skills/<name>`, `.claude/skills/<name>` | supported |
| `mcp` | manifest entry or frontmatter dependency | `config.toml` `[mcp_servers.*]`, `.mcp.json` | supported |
| `instruction` | markdown fragment | marked region in `AGENTS.md` / `CLAUDE.md` | supported |
| `bundle` | declared subtree | the paths the manifest declares, anywhere under the target root | supported |
| `settings` | JSON fragment, or inline | ownership-tracked merge into `.claude/settings.json` | supported |
| `plugin`, `agent`, `prompt`, `hook` | | | parsed and recorded, not installed |

Deferred kinds surface in `resolution.unsupported` with a `not-implemented` warning instead of
throwing, so a manifest written for full APM parity works today and starts installing those
kinds later without a breaking change.

## The API

```ts
const outfitter = createAgentManager(config?: AgentManagerConfig): AgentManager;
```

| Method | What it does |
|---|---|
| `resolve(input?)` | Manifest and refs to a transitive graph plus a plan. Reads the network, writes nothing. |
| `install(input?)` | Fetch, verify, materialize into every target, write the lockfile. |
| `add(ref, opts?)` | Record a ref in the manifest, then install it and its dependencies. |
| `sync(opts?)` | Reinstall strictly from the lockfile. The CI entrypoint. |
| `list(opts?)` | What is installed: lockfile entries confirmed against target state. |
| `remove(name, opts?)` | Delete a skill, fragment, bundle, or settings fragment from targets, lockfile, and manifest. |
| `verify(opts?)` | Re-hash installed files, instruction regions, bundle trees, and owned settings keys against the lockfile. |

```ts
// Diff before committing to anything. resolve() populates the cache and returns
// a plan; no target is touched until you install.
const plan = await outfitter.resolve();
plan.order;                    // ["shared-csv-utils", "csv-insights"], dependency-first
plan.skills.get("csv-insights"); // source, commit, files, dependencies
plan.warnings;                 // policy findings, dropped primitives, conflicts
await outfitter.install({ resolution: plan, dryRun: true });

// One flat installed list across every kind, each entry tagged.
const { installed } = await outfitter.install();
const skills = installed.filter((p) => p.kind === "skill");
const fragments = installed.filter((p) => p.kind === "instruction");
const engine = installed.find((p) => p.kind === "bundle");   // engine?.paths holds each destination

// Add one skill and write it into the manifest.
await outfitter.add("github:anthropics/skills/skills/docx");

// What is on disk right now.
for (const p of await outfitter.list()) console.log(p.target, p.kind, p.name, p.path);

// Has anything been edited since install?
const report = await outfitter.verify();
if (!report.ok) {
  for (const issue of report.issues) console.error(issue.kind, issue.name, issue.path);
  // instruction-drift house-style /workspace/project/CLAUDE.md
  await outfitter.sync(); // restores the pinned text
}

// Drop a skill from every target, the lockfile, and the manifest.
await outfitter.remove("xlsx");
```

Useful `install()` options: `only: ["pdf"]` to install a subset, `force: true` to
re-materialize even when the hash already matches, `prune: true` to remove skills that are in
the lockfile but no longer resolved, `dryRun: true` to plan without writing.

### Config

```ts
createAgentManager({
  root,        // where the manifest and lockfile live. Default process.cwd()
  manifest,    // path or inline object. Default: probe <root>/outfitter.config.*
  targets,     // adapters, or built-in names. Overridable per call
  sources,     // extra SourceProvider plugins; git and local are always present
  auth,        // (host, owner) => token | undefined
  cacheDir,    // default: the OS cache dir
  policy,      // trust and verification policy, merged over the manifest's
  onEvent,     // structured progress and audit stream
  concurrency, // max parallel source fetches. Default 6
});
```

## Manifest

Inline objects work, as above. For a checked-in manifest, use `outfitter.config.ts` (typed and
computable), `outfitter.config.yaml`, or `outfitter.config.json`. All three parse to the same
shape, and the two serializable forms are the ones `add()` and `remove()` can edit in place.

```ts
// outfitter.config.ts
import { defineConfig, claudeTarget, codexTarget } from "agent-outfitter";

export default defineConfig({
  version: 1,
  targets: [
    codexTarget({ codexHome: process.env.CODEX_HOME ?? "/workspace/.codex-home", scope: "user" }),
    claudeTarget({ dir: process.cwd(), consumer: "code" }),
  ],

  sources: [
    { ref: "github:anthropics/skills#main", select: ["pdf", "xlsx", "docx"] },
    { ref: "github:anthropics/skills/skills/mcp-builder" },
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

  bundles: [
    {
      ref: "github:awslabs/aidlc-workflows/dist/claude#v2",
      name: "aidlc-engine",
      paths: {
        ".claude/tools": ".claude/tools",       // <source subtree>: <destination>
        ".claude/hooks": ".claude/hooks",
        ".claude/knowledge": ".claude/knowledge",
        aidlc: "aidlc",                         // may land outside .claude/
      },
    },
  ],

  settings: [
    { ref: "github:awslabs/aidlc-workflows/dist/claude/.claude/settings.json#v2", name: "aidlc" },
    { name: "local-overrides", settings: { env: { AWS_REGION: "eu-west-2" } } },
  ],

  policy: {
    allowedHosts: ["github.com"],
    allowedOwners: ["acme", "anthropics"],
    requireLockHashMatch: true,
    scripts: "warn",                     // "allow" | "warn" | "deny"
    executableHarness: "deny",           // bundles that install code: default "deny"
    scan: "warn",                        // hidden Unicode: "off" | "warn" | "deny"
    allowTransitiveMcp: false,
    allowTransitiveInstructions: false,
    allowedMcpHosts: ["api.githubcopilot.com"],
  },
});
```

A TypeScript manifest needs a runtime that strips types (Bun, `tsx`, or Node >= 22.18). If yours
does not, you get a clear error rather than a crash. Use YAML or JSON instead; see
`examples/outfitter.config.yaml` for the equivalent file.

### Ref grammar

```
<provider>:<owner>/<repo>[/<subdir>][#<ref>]
```

Providers are `github` (or `gh`), `gitlab`, `bitbucket`, `sourcehut`, `git` for a raw URL, and
`local` (or `file`). The `#<ref>` part is a branch, tag, or commit SHA. Paths starting with
`./` or `/` are shorthand for `local:`.

```
github:anthropics/skills#main                      whole repo at main
github:anthropics/skills/skills/pdf                one skill folder
gh:acme/agent-skills#v1.4.0                        a tag
gh:acme/internal-skills#e24616c                    a commit
git:https://git.acme.dev/agents/skills.git#main    any git host
local:./skills                                     a directory in this repo
./skills                                           the same thing
```

### Picking skills out of a monorepo

A source root containing `SKILL.md` is itself a single skill. Otherwise agent-outfitter looks
for a `skills/`, `.agents/skills/`, or `.claude/skills/` directory, then falls back to the
root's own child directories. The convention wins first because real monorepos keep skills in
`skills/` while also carrying something like a `template/` folder that is a valid skill on its
own. Override the search with `skillsRoot`.

`select` takes names or globs (`*`, `**`, `?`, `{a,b}`), matched against both the declared name
and the folder name. Omitting it installs everything found. A `select` that matches nothing is
an error listing what was available.

```ts
{ ref: "github:acme/agent-skills#v1.4.0", select: ["csv-*", "pdf-extract"] }
{ ref: "github:acme/agent-skills#v1.4.0", skillsRoot: "packages/skills" }
```

## Instruction fragments

An instruction ref addresses either one markdown file or a directory of them:

```ts
instructions: [
  { ref: "github:acme/agent-config/instructions" },                       // all fragments
  { ref: "github:acme/agent-config/instructions", select: ["house-*"] },  // filtered
  { ref: "github:acme/agent-config/instructions/tone.md", name: "voice" } // one, renamed
]
```

Each fragment is merged into the target's instruction file inside a `BEGIN agent-outfitter` /
`END agent-outfitter` region, which is what makes the operation safe to repeat. Reinstalling
replaces the region in place, so a block you moved keeps its position. Removing a fragment
deletes exactly one region. Anything outside a region is preserved byte for byte, and a file
left with nothing but removed regions is deleted rather than left as litter.

`verify()` re-hashes each region against the lockfile, so an edit inside a managed region is
reported as `instruction-drift` and `sync()` restores the pinned text.

## Whole harnesses

A framework like [AWS AI-DLC](https://github.com/awslabs/aidlc-workflows) is mostly *not* skills.
Of the tree it ships for Claude, 40 files are skills and the other ~230 are engine: `tools/` the
skills shell into, `knowledge/` they read, `hooks/` that fire on every tool call, a stage
protocol, and a `settings.json` wiring it together. Install only the skills and you get 40 skills
that fail on first invocation, because every one of them runs
`bun .claude/tools/aidlc-orchestrate.ts`.

Two kinds close that gap.

### `bundle`: a declared subtree

A skill is *discovered*: agent-outfitter probes for `SKILL.md` folders, and the skill's own name
decides where it lands. A bundle has no marker file and no frontmatter, which is exactly why it
is needed, and it is why a bundle must be **declared** instead:

```ts
bundles: [
  {
    ref: "github:awslabs/aidlc-workflows/dist/claude#v2",
    name: "aidlc-engine",                     // defaults to the repository name
    paths: {
      ".claude/tools": ".claude/tools",       // <source subtree>: <destination>
      ".claude/knowledge": ".claude/knowledge",
      aidlc: "aidlc",
    },
  },
]
```

Each subtree is copied verbatim, atomically: staged beside its destination and renamed into
place, so an agent scanning the directory never sees a half-written engine. Exec bits are
re-derived afterwards, because tarball extraction drops file modes.

The consequences of being declared rather than discovered are worth stating plainly. A bundle
cannot be picked out by `select:` glob, cannot be a dependency edge, and cannot be pulled in by a
skill's frontmatter: there is no transitive form of a bundle, deliberately, because a bundle
writes to a path of its own choosing. Destinations must stay under the target root, so an
absolute path, a `~`, or any `..` segment is refused when the manifest is validated rather than
normalized into something safe-looking. Two bundles claiming one destination is an error, not a
first-wins warning, since either way round one would silently replace the other.

The lockfile records a hash per declared path as well as one over the whole bundle, so
`verify()` names the directory that drifted rather than just the bundle.

### `settings`: an ownership-tracked merge

Instruction fragments get marker comments, so the file itself says which regions are managed.
JSON has nowhere to put a marker, so ownership is recorded in the lockfile instead, key by key.
That record is the whole mechanism: without it, removal could only clobber.

```ts
settings: [
  { ref: "github:awslabs/aidlc-workflows/dist/claude/.claude/settings.json#v2", name: "aidlc" },
  { name: "local-overrides", settings: { env: { AWS_REGION: "eu-west-2" } } },  // inline
]
```

Four regions, three merge semantics:

| Region | Semantics |
|---|---|
| `env.*` | key-level: one value per key |
| `permissions.allow[]`, `deny[]`, `ask[]` | set union, tracked by exact string |
| `hooks.<Event>[].hooks[]` | set union, tracked by event + matcher + command |
| `model`, `statusLine`, `effortLevel`, … | whole-value, and **not** mergeable |

A scalar cannot be merged. Two fragments both declaring `model` is a conflict, not something to
reconcile, and so is one fragment declaring a key the user already set by hand. Both warn with
`settings-conflict` and leave the file's own value alone, because guessing wrong there silently
changes which model an agent runs.

Hooks are the real work. Ownership is tracked at the innermost `{ type, command }` element, and a
matcher group is pruned only when it empties *and* agent-outfitter created it — a group the user
wrote may hold their own hooks beside ours. An entry whose `command` we cannot read is skipped
rather than guessed at: an element whose identity cannot be recorded could never be removed again.

The result is that a hand-written `settings.json` survives install, reinstall, and removal:

```ts
await outfitter.install();          // their keys untouched, ours added
await outfitter.remove("aidlc");    // ours gone, their file byte-identical to what they wrote
```

`verify()` re-derives the owned slice of the file and hashes it, so an edited hook command or a
changed `model` is reported as `settings-drift`, while anything the user does elsewhere in the
file is correctly ignored.

### The trust gate

`bundle` and `settings` together can install executable code and register it into lifecycle
events, which is a larger claim than any other kind makes. It gets its own policy axis, and it
is **off by default**:

```ts
policy: { executableHarness: "deny" }   // the default. "warn" installs and reports; "allow" is silent.
```

Under `"deny"` the install fails before a byte is written, naming what it would have put in
place:

```
PolicyViolationError: This install would put an executable agent harness in place:
227 file(s), 54 of them executable (.claude/hooks/aidlc-audit-logger.ts, …);
18 hook registration(s) across 8 event(s) (PostToolUse, PreToolUse, PreCompact, …);
a statusLine command; 8 permissions.allow entries (Bash, Bash(...), Edit, Glob, …).
Hooks run automatically on every matching tool call, and permissions.allow entries pre-approve
tools without prompting, so policy.executableHarness defaults to "deny".
```

This is a separate axis from `scripts` rather than an extension of it, because the two describe
different things. `scripts` is about files under a skill's `scripts/` folder, which run when a
skill tells the agent to run them. An executable harness registers code that fires on every tool
call whether or not anything asked for it, plus a status-line command, plus `permissions.allow`
entries that pre-approve `Bash`. Consenting to the former implies nothing about the latter.

Detection is extension-based (`.ts`, `.sh`, `.py`, `.ps1`, …) plus any file a hook or status-line
command names, not a path prefix: a committed harness scatters its code by role, so
`scriptFiles()`-style prefix matching would report an engine of 54 executables as script-free.

### What is deliberately absent

AI-DLC compiles a stage graph after install, and there is **no post-install hook for it**. "Skill
code is never executed. Files are copied and text is merged, nothing more" is a large part of why
this library is safe to point at a third-party repository, and it is not worth trading for a
convenience the framework does not need: AI-DLC self-compiles through its own `PostToolUse` hook
on first use. Install the files; let the harness compile itself.

`make smoke-aidlc` installs the real thing in a fresh container and checks all of the above,
including that an operator's own `settings.json` comes back byte-identical after `remove()`.

## Targets

Each target declares which primitive kinds it supports, so anything it cannot take is reported
rather than dropped in silence.

| Target | Skills | MCP servers | Instructions | Bundles | Settings |
|---|---|---|---|---|---|
| `codexTarget({ codexHome, scope, projectDir, mcpMode, instructionFile })` | `$CODEX_HOME/skills/<name>` or `<projectDir>/.agents/skills/<name>` | `config.toml` `[mcp_servers.*]` | `AGENTS.md` | not supported | not supported |
| `claudeTarget({ dir, mode, scope, consumer, instructionFile })` | `<dir>/.claude/skills/<name>`, or a plugin bundle | `.mcp.json` `mcpServers` | `CLAUDE.md` | declared paths under `<dir>` | `<dir>/.claude/settings.json` |
| `filesystemTarget({ dir, mcpFile, instructionFile })` | `<dir>/<name>` | `<dir>/mcp.json` | `<dir>/AGENTS.md` | declared paths under `<dir>` | not supported |
| `openaiHostedTarget({ client \| upload })` | uploaded, returns `skillId` | not supported | not supported | not supported | not supported |

`settings` is Claude-specific on purpose: `.claude/settings.json` is one harness's schema, not a
general shape, so a generic target reports it as unwritable rather than inventing a location.

Called with no arguments, `codexTarget()` uses `$CODEX_HOME` then `~/.codex`, and
`claudeTarget()` uses the manager root. Install to several at once and each gets its own
`InstalledPrimitive` entries and its own lockfile record:

```ts
createAgentManager({ targets: [codexTarget(), claudeTarget({ dir: process.cwd() })] });
```

Skills need no configuration at all. Both Codex and Claude Code discover them from their skill
directories, so dropping the folder in is the whole install. Config files are written only for
primitives that are not auto-discovered, which means a manifest with no `mcp` and no
`instructions` writes zero config.

For Codex you can skip `config.toml` altogether. `codexTarget({ mcpMode: "sdk-config" })`
writes no file and exposes the entries on `target.mcpConfigOverrides`, ready to pass to
`@openai/codex-sdk`'s `config` option.

### SDK handoff

The harness apps find their own skills. An SDK running in your process does not always: the
Claude Agent SDK reads no filesystem skills unless you pass `settingSources` or `plugins`, and
Codex has to be pointed at the `CODEX_HOME` you installed into. Miss either and the install
succeeds while the agent starts up knowing nothing.

`sdkOptions()` closes that gap. The target already computed those paths in order to write to
them, so it hands the same ones back.

```ts
const codexT = codexTarget({ codexHome: "/workspace/.codex-home", scope: "user" });
const claudeT = claudeTarget({ dir: "/workspace/project", consumer: "agent-sdk" });

const outfitter = createAgentManager({ targets: [codexT, claudeT] });
await outfitter.install();

const codexSdk = codexT.sdkOptions();
const codex = new Codex({ env: { ...process.env, ...codexSdk.env }, config: codexSdk.config });

for await (const message of query({ prompt, options: { ...claudeT.sdkOptions() } })) {
  // ...
}
```

Call it after `install()` or `sync()`, since the MCP entries are populated by the install. It
resolves paths against the context that install ran under, so it takes no arguments.

| | `codexTarget().sdkOptions()` | `claudeTarget().sdkOptions()` |
|---|---|---|
| Points the harness at the install | `env.CODEX_HOME` | `settingSources`, or `plugins` in `mode: "plugin"` |
| MCP servers | `config.mcp_servers` | `mcpServers` |
| Project anchor | not applicable | `cwd` |
| Informational | `skillsDir`, `instructionPath` | `skillsDir`, `instructionPath` |

One asymmetry to know about. Files on disk keep secrets as env-var names, so `.mcp.json` gets
`${GITHUB_MCP_TOKEN}` and Claude Code expands it on read. Nothing performs that expansion on an
in-process options object, so a placeholder there would reach the SDK as a broken credential.
`sdkOptions().mcpServers` therefore carries resolved values: hand it to the SDK, and do not log
it or write it anywhere. A referenced variable that is unset is reported as a warning at
install time rather than becoming an opaque 401 on the agent's first tool call.

Setting `consumer: "agent-sdk"` also emits a `target-config` warning at install time, naming
the directory skills were written to and what the SDK needs in order to see them.

### Writing a target

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

## Dependencies between primitives

A skill declares what it needs in its own frontmatter:

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

The resolver walks to closure, dedupes by `(kind, name)`, raises `CycleError` on a cycle, and
topologically sorts skills so dependencies install first. A relative `local:` ref anchors to
the declaring skill's own folder, so a sibling is `../name`.

What a dependency adds is gated. An MCP server or instruction fragment pulled in by a skill
rather than declared in your manifest is dropped with a warning unless it passes
`policy.allowTransitiveMcp` or `allowTransitiveInstructions`, or an allowlist. This is the
non-interactive equivalent of APM's MCP trust prompt, and it matters most for instructions: a
fragment is text spliced straight into the agent's standing context, so a skill that could add
one silently could rewrite the agent's operating rules without appearing in your manifest.

```ts
policy: {
  allowTransitiveMcp: true,
  allowedMcpHosts: ["api.githubcopilot.com"], // still gated by host
  allowTransitiveInstructions: false,         // never, from a dependency
}
```

## Lockfile

`outfitter.lock.json` pins every primitive to an exact commit plus a content hash, and records
which entries and regions agent-outfitter owns in each target. Real output, trimmed:

```jsonc
{
  "version": 1,
  "skills": {
    "pdf": {
      "source": { "type": "git", "provider": "github",
                  "url": "https://github.com/anthropics/skills.git",
                  "subdir": "skills/pdf", "ref": "main" },
      "ref": "main",
      "commit": "b29e7cf65e5cb78a5ac33d582270551bc74a14eb",
      "contentHash": "sha256-8da60dcc59ddbd4d2057f217416a6cf5c8b1e17ed671548d25ace5846afbab7b",
      "files": ["LICENSE.txt", "SKILL.md", "forms.md", "reference.md",
                "scripts/fill_fillable_fields.py"],
      "dependencies": [],
      "mcp": [],
      "transitive": false
    }
  },
  "mcp": {
    "github": { "transport": "http", "url": "https://api.githubcopilot.com/mcp/",
                "auth": { "bearerEnv": "GITHUB_MCP_TOKEN" },
                "declaredBy": "manifest", "trusted": true,
                "configHash": "sha256-209e256d5dc5bab0f4149972ba27c06736c456f24039339be448aea982c77e2c" }
  },
  "instructions": {
    "house-style": { "source": { "type": "local", "path": "/workspace/project/instructions" },
                     "subdir": "house-style.md", "declaredBy": "manifest", "trusted": true,
                     "contentHash": "sha256-5f0974d3d720822b337a769a29591c6e4191635f7600caa481505d0689c57dc2" }
  },
  "bundles": {
    "aidlc-engine": {
      "source": { "type": "git", "provider": "github",
                  "url": "https://github.com/awslabs/aidlc-workflows.git",
                  "subdir": "dist/claude", "ref": "v2" },
      "commit": "6c1e0a0b0f7b4d2a91c3e5d7f8a1b2c3d4e5f607",
      "contentHash": "sha256-1f9c…",
      "paths": { ".claude/tools": ".claude/tools", "aidlc": "aidlc" },
      // One hash per declared path, so verify() names the tree that drifted.
      "pathHashes": { ".claude/tools": "sha256-4ab1…", "aidlc": "sha256-77de…" },
      "files": [".claude/tools/aidlc-orchestrate.ts", "aidlc/active-space"],
      "declaredBy": "manifest", "trusted": true
    }
  },
  "settings": {
    "aidlc": { "source": { "type": "git", "provider": "github",
                           "url": "https://github.com/awslabs/aidlc-workflows.git",
                           "subdir": "dist/claude/.claude/settings.json", "ref": "v2" },
               "commit": "6c1e0a0b0f7b4d2a91c3e5d7f8a1b2c3d4e5f607",
               "subdir": "dist/claude/.claude/settings.json",
               "contentHash": "sha256-b0d2…", "inline": false,
               "declaredBy": "manifest", "trusted": true }
  },
  "targets": {
    "claude": {
      "skills": { "pdf": "/workspace/project/.claude/skills/pdf" },
      "mcp": ["github"], "mcpConfigPath": "/workspace/project/.mcp.json",
      "instructions": ["house-style"], "instructionPath": "/workspace/project/CLAUDE.md",
      "bundles": { "aidlc-engine": { ".claude/tools": "/workspace/project/.claude/tools",
                                     "aidlc": "/workspace/project/aidlc" } },
      // Exactly which keys in settings.json are agent-outfitter's, per fragment.
      // This is what makes removal surgical rather than a clobber.
      "settings": {
        "aidlc": {
          "env": ["AWS_REGION", "CLAUDE_CODE_USE_BEDROCK"],
          "permissions": { "allow": ["Bash", "Edit", "Glob", "Read"] },
          "hooks": ["PostToolUse Write|Edit bun \"$CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-x.ts\""],
          "hookGroups": ["PostToolUse Write|Edit"],
          "scalars": ["companyAnnouncements", "effortLevel", "model", "statusLine"],
          "hash": "sha256-2c5f…"
        }
      },
      "settingsPath": "/workspace/project/.claude/settings.json"
    }
  }
}
```

An inline settings fragment carries its own `content` in the lockfile, since there is no commit to
re-read it from and `sync()` must not have to consult the manifest.

A skill's `contentHash` is sha256 over a canonical serialization: every file, sorted by
relative POSIX path, each length-delimited. File modes, timestamps, and directory entries are
excluded on purpose, because tarball extraction does not preserve modes and including them
would make the hash depend on how a tree was fetched rather than what it contains. Serialized
output is fully key-sorted, so a lockfile committed from two machines diffs empty.

Commit resolution happens at resolve time through each host's REST API, falling back to git's
smart-HTTP ref advertisement. That is why a moved tag is harmless: `sync()` installs the commit
that was pinned.

The lockfile stays at `version: 1`, and every schema level is strict. A current reader accepts an
older lockfile, because the new sections default to empty, but an **older reader rejects a
lockfile written by this version**. At 0.x that is the right trade against an upgrade-on-read
path; upgrade in lockstep, or pin.

### CI

Commit `outfitter.lock.json`, then:

```ts
const result = await outfitter.sync();
console.log(`${result.installed.length} installed, ${result.skipped.length} unchanged`);
```

`sync()` fetches the pinned commits, re-hashes, and fails on any drift. `install()` and
`sync()` treat hashes differently on purpose. A new commit with a new hash is an ordinary
upgrade and just updates the lockfile. The same commit hashing differently means the bytes
behind an immutable identifier moved, which is the signature of a tampered mirror, and raises
`HashMismatchError`.

## Containers

A container that spins up for one task, outfits an agent, and exits is the shape this library
is built for. `resolve()` and `install()` are the two halves of that startup, and
`sdkOptions()` is how the result reaches the SDK you construct next.

Two things follow from the container being fresh.

The cache is cold, so every fetch is live. There is no warm tree to fall back on and nobody
watching a terminal to retry, so transient failures are retried three times with jittered
exponential backoff, on 5xx, 429, 408, 425, and transport-level errors. A 401, 403, or 404 is
not retried, since a bad token or a wrong ref will still be bad three seconds later. Retries
surface as `source:retry` events.

Paths must be explicit rather than inherited. `AGENT_OUTFITTER_CACHE_DIR` overrides the cache
location, which otherwise sits under `$HOME`. Pin it in the image: a container that builds as
one user and runs as another will warm a cache in one place and read from another, and `$HOME`
is the variable most likely to differ between the two.

```dockerfile
ENV AGENT_OUTFITTER_CACHE_DIR=/opt/outfitter-cache
```

```ts
// Container entrypoint, in process.
const target = claudeTarget({ dir: "/workspace/project", consumer: "agent-sdk" });
const outfitter = createAgentManager({
  root: "/workspace/project",
  targets: [target],
  manifest: {
    version: 1,
    sources: [{ ref: "github:anthropics/skills#main", select: ["pdf", "xlsx"] }],
    mcp: [{ name: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/",
            auth: { bearerEnv: "GH_MCP" } }],
  },
  onEvent: (e) => {
    if (e.type === "source:retry") log.warn({ attempt: e.attempt, of: e.of }, "retrying source");
  },
});

await outfitter.install();
for await (const m of query({ prompt, options: { ...target.sdkOptions() } })) { /* ... */ }
```

If you commit a lockfile, prefer `sync()` here. It resolves nothing, reads pinned commits
straight from the lockfile, and never calls a host's ref API, so a warm cache baked into an
image layer makes it a zero-network install.

`smoke/` holds a container test of all of this against the real network, one image per harness,
installing into the library's default locations and bind-mounting the result to `test-output/`
so it can be inspected from the host. Run `make smoke`, or read
[smoke/README.md](smoke/README.md).

`smoke/app/harness/codex.ts` and `smoke/app/harness/claude.ts` are the full worked examples for
each harness: one self-contained `setupCodex()` or `setupClaude()` covering manifest through
install through SDK handoff, with no test scaffolding and no local imports to follow. Both are
typechecked in CI, so they compile against the library as shipped.

## Security

Skills ship code that runs in the agent's environment, and instructions shape what the agent
believes. Both are checked before they reach a target.

- Content-hash pinning. A mismatch raises `HashMismatchError`, unless
  `requireLockHashMatch: false`.
- Source allowlists. `allowedHosts` and `allowedOwners` gate resolution before a byte is
  fetched; violations raise `PolicyViolationError`.
- Hidden-Unicode scanning. Bidi overrides, zero-width characters, and Unicode tag characters
  are a prompt-injection vector that a human reading the diff cannot see. Findings are reported
  with file, line, column, and code point, and instruction fragments are scanned too.
- Script policy. `scripts: "allow" | "warn" | "deny"` controls whether skills bundling
  `scripts/` may install at all.
- Executable-harness policy. `executableHarness` gates bundles that install executable files and
  settings fragments that register hooks, a status line, or `permissions.allow` entries. It
  **defaults to `"deny"`**, and the refusal names the files, hook registrations, events, and
  pre-approvals it would have put in place. See [the trust gate](#the-trust-gate).
- Bundle destinations are contained. Declared paths must stay under the target root; absolute
  paths, `~`, and `..` segments are refused at manifest validation, not normalized.
- No source-declared harnesses. Bundles and settings can only be declared by the consumer's
  manifest. A fetched repository cannot nominate its own bundle or add a settings fragment,
  because either would let it register code into the harness it was installed into.
- Trust gating. Nothing a dependency introduces reaches a target without the operator opting
  in.
- No implicit execution. agent-outfitter places files and merges text. The agent runtime
  executes what it finds, under its own sandbox and approval policy.
- Secrets by reference. Tokens come from env-var names, never values, and never enter a
  manifest, a lockfile, a generated config, or a log line. The one exception is
  `sdkOptions().mcpServers`, which must carry values because nothing downstream would expand a
  placeholder. See [SDK handoff](#sdk-handoff).

## Events

`onEvent` receives a discriminated union, enough for a progress UI, an audit log, or CI
annotations, with no `console` coupling.

```ts
createAgentManager({
  onEvent: (e) => {
    switch (e.type) {
      case "skill:materialized": log.info({ target: e.target }, `installed ${e.name}`); break;
      case "skill:skipped":      log.debug(`unchanged ${e.name}`); break;
      case "warning":            log.warn({ code: e.warning.code }, e.warning.message); break;
      case "install:done":       log.info(`${e.installed} installed, ${e.skipped} skipped`); break;
    }
  },
});
```

The full set: `resolve:start`, `source:listed`, `source:retry`, `resolve:done`,
`skill:fetched`, `skill:verified`, `skill:materialized`, `skill:skipped`, `skill:removed`,
`mcp:configured`, `instruction:written`, `instruction:removed`, `bundle:fetched`,
`bundle:materialized`, `bundle:skipped`, `bundle:removed`, `settings:written`,
`settings:removed`, `lockfile:written`, `install:done`, `warning`.

Warning codes: `duplicate-skill`, `scripts-present`, `hidden-unicode`, `transitive-mcp-dropped`,
`transitive-instruction-dropped`, `mcp-conflict`, `instruction-conflict`, `settings-conflict`,
`executable-harness`, `not-implemented`, `target-config`, `manifest`, `source`.

## Errors

`OutfitterError` is the base class, and every subclass carries a `code` and a `detail` object:
`SourceResolutionError`, `SkillNotFoundError`, `HashMismatchError`, `PolicyViolationError`,
`CycleError`, `TargetError`, `AuthError`, `ManifestError`, `LockfileError`,
`NotImplementedError`.

```ts
import { HashMismatchError, PolicyViolationError } from "agent-outfitter";

try {
  await outfitter.sync();
} catch (err) {
  if (err instanceof HashMismatchError) log.error(err.detail, "pinned bytes changed");
  else if (err instanceof PolicyViolationError) log.error(err.detail, "source not allowed");
  else throw err;
}
```

## Development

```sh
make install
make check        # typecheck + lint + 190 tests, no network required
make build        # dist/index.js and .d.ts
make smoke        # container test, both harnesses. Needs Docker and network
```

Tests use `local:` sources throughout, so the whole resolve, verify, materialize, lockfile loop
is covered offline. A fixture `SourceProvider` stands in for a git host where commit pinning is
under test, and `globalThis.fetch` is stubbed where retry behaviour is.

What that leaves uncovered is what `make smoke` exists for: the published package resolving in
a clean container, real sources over the real network, and the SDK handoff pointing at where
the install actually wrote. CI runs both, with the smoke test as its own job and one harness
per matrix entry in parallel, uploading the installed tree as an artifact.

Releases go through Changesets and npm Trusted Publishing over OIDC, so there is no long-lived
`NPM_TOKEN` and provenance is attached automatically. Add a changeset with `bun run changeset`.

## License

MIT
