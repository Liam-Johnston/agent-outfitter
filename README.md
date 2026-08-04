# skillsmith

**A library-first agent-skill package manager.** Resolve a manifest, pin a lockfile, verify
content hashes, handle transitive dependencies, install into multiple agent harnesses — all
behind an `await`-able TypeScript API rather than a CLI.

```ts
import { Codex } from "@openai/codex-sdk";
import { createSkillManager, codexTarget } from "skillsmith";

const CODEX_HOME = "/workspace/.codex-home";

const skills = createSkillManager({
  targets: [codexTarget({ codexHome: CODEX_HOME, scope: "user" })],
  auth: (host, owner) => (owner === "acme" ? process.env.SKILLS_TOKEN : undefined),
  policy: { allowedOwners: ["acme", "anthropics"], scripts: "warn" },
});

const { installed, lockfilePath } = await skills.install({
  refs: [
    {
      source: { type: "git", url: "https://github.com/acme/agent-skills.git", ref: "v1.4.0" },
      select: ["csv-insights", "pdf-extract"],
    },
  ],
});
console.log(installed.map((s) => `${s.name}@${s.commit.slice(0, 7)}`), "→", lockfilePath);

// Codex auto-discovers what we wrote into $CODEX_HOME/skills.
const codex = new Codex({ env: { ...process.env, CODEX_HOME } });
const thread = codex.startThread({ workingDirectory: "/workspace/project", skipGitRepoCheck: true });
await thread.run("Use the csv-insights skill to summarize ./data");
```

## Why

APM, the Vercel `skills` CLI, and `skillpm` all run the same pipeline — resolve a source,
fetch skill folders, materialize them into an agent's skill directory, record a lockfile —
but all three are CLI-first, with the install logic in unexported internals. When you build
an agent harness *in process*, shelling out to a CLI means a child process, brittle agent
auto-detection, standard-location writes that ignore a custom `CODEX_HOME`, and no typed
result to branch on.

skillsmith is that pipeline as a library.

- **Library-first.** Nothing runs on import; nothing is written until you call an install method.
- **Monorepo-native.** Install one, several, or all skills from a repo holding many, with
  cherry-pick and glob selection.
- **Reproducible.** Every skill pins an exact commit plus a content hash. `sync()` is the CI
  entrypoint and fails on drift.
- **Harness-oriented.** Targets are agent *harnesses* — Claude Code and Codex first — not
  models. Whatever model the harness runs is irrelevant.
- **Safe by default.** Content-hash verification, source allowlists, hidden-Unicode scanning,
  explicit handling of bundled executable scripts. skillsmith never executes skill code.

## Install

```sh
bun add skillsmith      # or: npm i skillsmith / pnpm add skillsmith
```

Requires Node ≥ 18 (or Bun). No `git` binary needed — trees arrive as tarballs.
`openai` is an optional peer, used only by `openaiHostedTarget`.

## The API

```ts
const manager = createSkillManager(config?: SkillManagerConfig): SkillManager;
```

| Method | What it does |
|---|---|
| `resolve(input?)` | Manifest/refs → transitive graph + plan. Network reads only, no writes. |
| `install(input?)` | Fetch, verify, materialize into every target, write the lockfile. |
| `add(ref, opts?)` | Record a ref in the manifest, then install just it and its dependencies. |
| `sync(opts?)` | Deterministic reinstall strictly from the lockfile. The CI entrypoint. |
| `list(opts?)` | What's installed — lockfile ∩ target directories. |
| `remove(name, opts?)` | Delete from targets, lockfile, and (where expressible) the manifest. |
| `verify(opts?)` | Re-hash installed files against the lockfile; optional security scan. |

`resolve()` is pure in the sense that matters: it reads the network and populates a cache
directory, and returns a plan. Nothing lands in a target until you install.

```ts
// Diff before committing to anything.
const plan = await manager.resolve();
console.log(plan.order);                 // topologically sorted skill names
console.log(plan.warnings);              // policy findings, dropped MCP servers, conflicts
const dry = await manager.install({ resolution: plan, dryRun: true });
```

### Config

```ts
createSkillManager({
  root,        // where the manifest and lockfile live. Default process.cwd()
  manifest,    // path or inline object. Default: probe <root>/skills.config.*
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

`skills.config.ts` (typed, computable), `skills.config.yaml`, or `skills.config.json`. All
three parse to the same shape; the serializable forms are the ones `add()`/`remove()` can
edit in place.

```ts
// skills.config.ts
import { defineConfig, codexTarget } from "skillsmith";

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
  policy: {
    allowedHosts: ["github.com"],
    allowedOwners: ["acme", "anthropics"],
    requireLockHashMatch: true,
    scripts: "warn",              // "allow" | "warn" | "deny"
    scan: "warn",                 // hidden-Unicode scan: "off" | "warn" | "deny"
    allowTransitiveMcp: false,
    allowedMcpHosts: ["api.githubcopilot.com"],
  },
});
```

A TypeScript manifest needs a runtime that strips types (Bun, `tsx`, or Node ≥ 22.18). Use
YAML or JSON otherwise — you get a clear error, not a crash.

### Ref grammar

`<provider>:<owner>/<repo>[/<subdir>][#<ref>]` — providers `github` (`gh`), `gitlab`,
`bitbucket`, `sourcehut`, `git` (raw URL), `local` (`file`). `<ref>` is a branch, tag, or
commit; `./path` and `/abs/path` are accepted as shorthand for `local:`.

### Monorepo selection

A source root containing `SKILL.md` *is* a single skill. Otherwise skillsmith looks for a
conventional `skills/`, `.agents/skills/`, or `.claude/skills/` directory, then falls back to
the root's own child directories — the convention wins deliberately, because real monorepos
keep skills in `skills/` while also carrying a `template/` folder that is itself a valid
skill. Override with `skillsRoot` on the source. `select` accepts names or globs (`*`, `**`,
`?`, `{a,b}`), matched against both the declared skill name and its folder name; a source
with no `select` installs everything it finds. A `select` that matches nothing is an error
that lists what was available.

## Targets

Explicit and pluggable — no "detect installed agents" guesswork.

| Target | Skills land in | MCP servers land in |
|---|---|---|
| `codexTarget({ codexHome, scope, projectDir, mcpMode })` | `$CODEX_HOME/skills/<name>` (`scope: "user"`) or `<projectDir>/.agents/skills/<name>` (`"project"`) | `$CODEX_HOME/config.toml` → `[mcp_servers.<name>]` |
| `claudeTarget({ dir, mode, scope, consumer })` | `<dir>/.claude/skills/<name>`, or a plugin bundle (`mode: "plugin"`) | `.mcp.json` → `mcpServers` |
| `filesystemTarget({ dir })` | `<dir>/<name>` | `<dir>/mcp.json` (normalized shape) |
| `openaiHostedTarget({ client \| upload })` | uploaded; result carries `skillId` | — |

Install to several at once (`targets: [codex, claude]`); each gets its own `InstalledSkill`
entry and its own lockfile record.

**Skills need no config; only MCP does.** Both Codex and Claude Code auto-discover skills
from their skill directories — dropping the folder in *is* the whole install. Config files
are touched only to register MCP servers, so a manifest with no `mcp` entries writes zero
config. One caveat: the Claude **Agent SDK** (unlike the Claude Code app) does not read
filesystem skills unless you pass `settingSources: ['project']` or load them via `plugins`.
Set `consumer: "agent-sdk"` and skillsmith emits a warning telling you so.

Config writes are **merge, not clobber**. Entries you or another tool added are preserved;
skillsmith tracks the servers it manages by name in the lockfile and touches only those —
including on `remove()`.

For Codex you can skip the file entirely: `codexTarget({ mcpMode: "sdk-config" })` writes no
`config.toml` and instead exposes the same entries on `target.mcpConfigOverrides`, ready to
hand to `@openai/codex-sdk`'s `config` option.

### Custom targets

```ts
import { materializeToDir, installedHash, type SkillTarget } from "skillsmith";

const myTarget: SkillTarget = {
  name: "my-harness",
  resolveSkillsDir: (ctx) => `${ctx.root}/.my-agent/skills`,
  materialize: (input) => materializeToDir(`${input.ctx.root}/.my-agent/skills`, input),
  currentHash: (name, ctx) => installedHash(`${ctx.root}/.my-agent/skills`, name),
};
```

`currentHash` is what lets the manager skip an unchanged skill without writing. Omit it and
every install re-materializes.

## Transitive dependencies

A skill declares what it needs in its own frontmatter — other skills *and* MCP servers:

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
---
```

The resolver walks to closure across all primitive kinds, dedupes by `(kind, name)`,
detects cycles (`CycleError`), and topologically sorts skills so dependencies install first.
Relative `local:` refs anchor to the declaring skill's own folder, so a sibling is `../name`.

**Transitive MCP is gated.** A server pulled in by a dependency rather than declared in your
manifest is *dropped with a warning* unless it passes `policy.allowTransitiveMcp`,
`allowedMcpHosts`, or `allowedMcpCommands`. That's the non-interactive analogue of APM's MCP
trust prompt: a skill you install should not be able to silently attach a tool server to
your agent.

## Lockfile

`skills.lock.json` pins each skill to an exact commit plus a content hash over its file
tree, and records which MCP entries skillsmith owns in each target's config.

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
      "mcp": [],
      "transitive": false
    }
  },
  "mcp": { "github": { "transport": "http", "url": "…", "declaredBy": "manifest",
                       "configHash": "sha256-…", "trusted": true } },
  "targets": { "codex": { "skills": { "csv-insights": "/workspace/.codex-home/skills/csv-insights" },
                          "mcp": ["github"], "mcpConfigPath": "…/config.toml" } }
}
```

`contentHash` is sha256 over a canonical serialization — every file, sorted by relative
POSIX path, each length-delimited. File modes, timestamps, and directory entries are
excluded on purpose: tarball extraction does not preserve modes, so including them would
make the hash depend on *how* a tree was fetched rather than *what* it contains. Serialized
output is fully key-sorted, so a lockfile committed from two machines diffs empty.

Commit resolution happens at resolve time, via each host's REST API with git's smart-HTTP
ref advertisement as a fallback. That's what makes a moved tag harmless: `sync()` installs
the commit that was pinned.

### CI

```ts
// Commit skills.lock.json. In CI:
await skills.sync(); // fetches the pinned commits, re-hashes, fails on any drift
```

`install()` and `sync()` treat hashes differently, deliberately. A *new* commit with a new
hash is an ordinary upgrade and just updates the lockfile. The **same** commit hashing
differently means the bytes behind an immutable identifier moved — the signature of a
tampered mirror — and raises `HashMismatchError`. `sync()` enforces the lockfile's hash
outright.

## Security

Bundled scripts execute inside the agent's environment, so provenance is a first-class
concern rather than a lint:

- **Content-hash pinning** — mismatch raises `HashMismatchError` (unless
  `requireLockHashMatch: false`).
- **Source allowlists** — `policy.allowedHosts` / `allowedOwners` gate resolution before a
  byte is fetched; violations raise `PolicyViolationError`.
- **Hidden-Unicode scan** — bidi overrides, zero-width characters, and Unicode tag
  characters in text files are a prompt-injection vector a human reading the diff cannot
  see. Reported with file, line, column, and code point.
- **Script policy** — `policy.scripts: "allow" | "warn" | "deny"` controls whether skills
  bundling `scripts/` may install at all.
- **No implicit exec** — skillsmith only places files. The agent runtime executes them under
  its own sandbox and approval policy.
- **Secrets by reference** — tokens come from env-var *names*, never values, and never enter
  a manifest, a lockfile, a generated config, or a log line.

`verify()` re-hashes installed files against the lockfile and re-runs the scan, catching
in-place edits, deletions, and files that appeared from nowhere.

## Events

`onEvent` receives a discriminated union — `resolve:start`, `source:listed`, `skill:fetched`,
`skill:verified`, `skill:materialized`, `skill:skipped`, `skill:removed`, `mcp:configured`,
`lockfile:written`, `install:done`, and `warning`. Enough for a progress UI, an audit log, or
CI annotations, with no `console` coupling.

## Errors

`SkillsmithError` is the base; every subclass carries a `code` and a `detail` object:
`SourceResolutionError`, `SkillNotFoundError`, `HashMismatchError`, `PolicyViolationError`,
`CycleError`, `TargetError`, `AuthError`, `ManifestError`, `LockfileError`,
`NotImplementedError`.

## Primitive support

One `Primitive` union covers APM's full taxonomy so the manifest format is stable from day
one. Today `skill` and `mcp` install. The rest — `plugin`, `agent`, `prompt`, `instruction`,
`hook` — parse and resolve, and surface as `resolution.unsupported` plus a `not-implemented`
warning rather than an error, so a skill authored against full parity works now and starts
installing them later without a manifest change.

## Development

```sh
bun install
bun test          # 135 tests, no network required
bun run typecheck
bun run lint
bun run build     # dist/index.js + .d.ts
```

Tests use `local:` sources throughout, so the whole resolve → verify → materialize →
lockfile loop is covered offline. A fixture `SourceProvider` stands in for a git host where
commit-pinning behaviour is under test.

Releases go through Changesets and npm Trusted Publishing (OIDC) — no long-lived
`NPM_TOKEN`, provenance attached automatically. Add a changeset with `bun run changeset`.

## License

MIT
