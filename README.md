# agent-outfitter

Install agent skills, MCP servers, and instruction fragments from git into Claude Code, Codex,
or any harness you write an adapter for. It is a TypeScript library, not a CLI: you import a
function, `await` it, and get a typed result. Every primitive is pinned to an exact commit and
a content hash in a lockfile.

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
| `remove(name, opts?)` | Delete a skill or fragment from targets, lockfile, and manifest. |
| `verify(opts?)` | Re-hash installed files and instruction regions against the lockfile. |

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

  policy: {
    allowedHosts: ["github.com"],
    allowedOwners: ["acme", "anthropics"],
    requireLockHashMatch: true,
    scripts: "warn",                     // "allow" | "warn" | "deny"
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

## Targets

Each target declares which primitive kinds it supports, so anything it cannot take is reported
rather than dropped in silence.

| Target | Skills | MCP servers | Instructions |
|---|---|---|---|
| `codexTarget({ codexHome, scope, projectDir, mcpMode, instructionFile })` | `$CODEX_HOME/skills/<name>` or `<projectDir>/.agents/skills/<name>` | `config.toml` `[mcp_servers.*]` | `AGENTS.md` |
| `claudeTarget({ dir, mode, scope, consumer, instructionFile })` | `<dir>/.claude/skills/<name>`, or a plugin bundle | `.mcp.json` `mcpServers` | `CLAUDE.md` |
| `filesystemTarget({ dir, mcpFile, instructionFile })` | `<dir>/<name>` | `<dir>/mcp.json` | `<dir>/AGENTS.md` |
| `openaiHostedTarget({ client \| upload })` | uploaded, returns `skillId` | not supported | not supported |

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
  "targets": {
    "claude": {
      "skills": { "pdf": "/workspace/project/.claude/skills/pdf" },
      "mcp": ["github"], "mcpConfigPath": "/workspace/project/.mcp.json",
      "instructions": ["house-style"], "instructionPath": "/workspace/project/CLAUDE.md"
    }
  }
}
```

A skill's `contentHash` is sha256 over a canonical serialization: every file, sorted by
relative POSIX path, each length-delimited. File modes, timestamps, and directory entries are
excluded on purpose, because tarball extraction does not preserve modes and including them
would make the hash depend on how a tree was fetched rather than what it contains. Serialized
output is fully key-sorted, so a lockfile committed from two machines diffs empty.

Commit resolution happens at resolve time through each host's REST API, falling back to git's
smart-HTTP ref advertisement. That is why a moved tag is harmless: `sync()` installs the commit
that was pinned.

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
`mcp:configured`, `instruction:written`, `instruction:removed`, `lockfile:written`,
`install:done`, `warning`.

Warning codes: `duplicate-skill`, `scripts-present`, `hidden-unicode`, `transitive-mcp-dropped`,
`transitive-instruction-dropped`, `mcp-conflict`, `instruction-conflict`, `not-implemented`,
`target-config`, `manifest`, `source`.

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
