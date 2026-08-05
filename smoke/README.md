# Container smoke test

Proves that a fresh, single-task container can outfit an agent and hand the
result to a harness SDK — the deployment shape the library is built for, and the
one the unit tests deliberately do not cover.

```sh
make smoke          # both harnesses
make smoke-codex    # Codex only
make smoke-claude   # Claude only
make smoke-output   # list what the last run left on disk
make smoke-clean    # drop the image, build cache, and output
```

Needs Docker and network access. Takes roughly a minute, most of it building the
image; the install itself runs in a few seconds on a cold cache.

Each run bind-mounts its output, so the installed tree survives the container and
can be opened from the host:

```
test-output/codex/.codex/skills/{pdf,xlsx,mcp-builder}/
test-output/codex/.codex/{config.toml,AGENTS.md}
test-output/codex/outfitter.lock.json

test-output/claude/.claude/skills/{pdf,xlsx,mcp-builder}/
test-output/claude/{.mcp.json,CLAUDE.md}
test-output/claude/outfitter.lock.json
```

Those paths are not configured anywhere — they are where the library puts things
when you pass it nothing, which is the point. `test-output/` is gitignored and
cleared at the start of every run, so it always holds exactly one run's result.

## What it actually proves

The unit suite runs entirely on `local:` sources and never leaves the process, so
four classes of failure are invisible to it. Each is something a container hits on
its first run:

1. **The published package doesn't resolve.** The image installs
   agent-outfitter from a tarball produced by `bun pm pack`, into an otherwise
   empty container — so `exports`, the `files` list, and the dependency closure
   are all exercised as a real consumer meets them, not as this repo's own
   tsconfig sees them.
2. **Real sources don't resolve.** Skills come from `anthropics/skills` over the
   network, which covers commit pinning against a live REST API, tarball
   extraction, and content hashing of trees nobody wrote as a fixture.
3. **The harness can't see what was installed.** The check that matters. A wrong
   install path fails loudly; a wrong *SDK option* produces an agent that starts
   normally and silently knows nothing. So the test asserts that
   `target.sdkOptions()` points at the same files the install reported writing.
4. **The install's account of itself is wrong.** Every file is listed off the
   filesystem and reconciled against the lockfile, so a skill that arrived
   partially — or a tree carrying something the content hash never covered — is
   caught rather than reported as a successful install.

## Layout

| Path | Role |
|---|---|
| **`app/harness/codex.ts`** | **`setupCodex()` — copy this to outfit Codex.** |
| **`app/harness/claude.ts`** | **`setupClaude()` — copy this to outfit Claude.** |
| `app/setup.ts` | The test: calls one of the above, then checks the result. |
| `app/assert.ts` | Dependency-free assertions; exits non-zero on any failure. |
| `app/inventory.ts` | Walks the target directories and prints every file installed. |
| `instructions/` | A local instruction fragment, so that primitive stays hermetic. |
| `Dockerfile` | Two stages: pack the library, install it into a clean image. |
| `docker-compose.yml` | The same image twice, differing only by `HARNESS` and its mount. |

The two bold files are meant to be read and lifted; the rest is test scaffolding.
Each is self-contained — manifest, MCP servers, policy, auth, install, SDK handoff,
in one file you can read top to bottom — and they duplicate rather than share, so
copying one gets you everything. `setup.ts` contains no outfitting logic of its own,
which is the point of the split: an example carrying test scaffolding is one nobody
can lift cleanly, and assertions living inside the thing they assert on tend to start
agreeing with it.

## Using these as a starting point

Take the one you need — it is a single file with no local imports:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { setupClaude } from "./harness/claude.ts";

const { sdk } = await setupClaude({ instructionsDir: "./instructions" });
for await (const message of query({ prompt, options: { ...sdk } })) { … }
```

```ts
import { Codex } from "@openai/codex-sdk";
import { setupCodex } from "./harness/codex.ts";

const { sdk } = await setupCodex({ instructionsDir: "./instructions" });
const codex = new Codex({ env: { ...process.env, ...sdk.env }, config: sdk.config });
```

To adapt: change `sources` to your own repository, edit the `mcp` and `policy`
blocks, drop `auth` if every source you use is public, and — if you need somewhere
other than the defaults — pass `codexTarget({ codexHome })` or
`claudeTarget({ dir })`. Both functions also return the `AgentManager`, so a later
`sync()` or `verify()` needs nothing rebuilt.

The two files are near-identical, which is itself a claim under test: if outfitting
Codex and outfitting Claude Code needed materially different wrapper code, the target
abstraction would not be earning its place. What genuinely differs is the SDK
handoff, and each file documents its own.

Because these are examples rather than only tests, they are typechecked by
`bun run typecheck:smoke` (part of `make check` and of CI) against `src` via a path
mapping — Bun strips types without checking them, so nothing else in the pipeline
would notice an example that does not compile.

## What gets checked

38 assertions per harness, in the order a wrapper depends on them:

- **Install** — every requested skill resolved, pinned to a 40-character commit;
  MCP servers and the instruction fragment resolved; lockfile written.
- **Default locations** — the resolved skills directory, instruction file, and
  lockfile path each match a literal (`$HOME/.codex/skills`, `<cwd>/.claude/skills`,
  and so on), rather than being compared to whatever the target computed. Nothing
  configures these; the assertions are what make "default" a claim instead of an
  assumption.
- **Files** — the skills directory and each `SKILL.md` exist, and every path in
  the install result sits under `sdkOptions().skillsDir`.
- **Inventory** — every installed file is printed with its size, read back off
  the filesystem rather than reported from the install result, then reconciled
  against the file list the lockfile hashed each skill over. Nothing is
  truncated; the listing runs to 75 files across the three skills. A file missing
  from the directory or present but unaccounted for in the lockfile fails the
  run, which is what makes the listing evidence rather than decoration — a
  content hash guarding a tree that is not the tree on disk guards nothing.
- **Instructions** — the fragment landed inside a managed region, and prose
  written to the file *before* the install survived it byte for byte.
- **MCP config** — `config.toml` gained `[mcp_servers.*]` (Codex) or `.mcp.json`
  gained `mcpServers` (Claude), with tokens referenced by env-var name and no
  secret value anywhere in the file.
- **SDK handoff** — Codex gets a `CODEX_HOME` matching the install and both
  servers in `config.mcp_servers`; Claude gets `settingSources: ["project"]`, a
  `cwd` at the project root, and MCP entries whose env references are resolved to
  real values, since a `${VAR}` placeholder would reach an in-process SDK as a
  broken credential.
- **Reproducibility** — `verify()` reports no issues, and a second `sync()`
  re-materializes nothing and skips every skill instead.

## Confirming it can fail

A test suite that has never failed is not yet evidence. Both of these should
fail, with a non-zero exit.

Unset the token the Claude handoff resolves:

```sh
docker compose -f smoke/docker-compose.yml run --rm -e GITHUB_MCP_TOKEN= claude
echo $?   # 1, with "http auth header resolved to a value" marked failed
```

Plant a file the lockfile does not account for:

```sh
rm -rf test-output/claude && mkdir -p test-output/claude
docker compose -f smoke/docker-compose.yml run --rm -e KEEP_OUTPUT=1 \
  --entrypoint sh claude -c '
    mkdir -p /workspace/out/.claude/skills
    echo stray > /workspace/out/.claude/skills/STRAY.md
    bun run /workspace/app/setup.ts'
# 1, with "lockfile totals 75, directory holds 76"
```

Both preliminaries matter. `KEEP_OUTPUT=1` is needed because the run otherwise
clears its output directory first and would delete the planted file before
installing; clearing `test-output/claude` by hand instead is what keeps the result
a *single* failure, since skills left over from an earlier run would be skipped
rather than installed and trip four more assertions on the way past. The stray file
also has to sit beside the skill folders rather than inside one: each skill is
materialized by atomic directory replacement, so anything within a skill folder is
simply replaced.

## In CI

`.github/workflows/ci.yml` runs this as a `smoke` job, separate from `build` so the
fast checks are not held behind a Docker build. One matrix entry per harness, so
Codex and Claude run in parallel, with `fail-fast: false` — "Codex passed, Claude
did not" localizes a problem much faster than a single cancelled run. The installed
tree is uploaded as `smoke-output-codex` / `smoke-output-claude`, on failure as well
as success, since that tree is the evidence for *why* an assertion failed and it is
gone once the runner is recycled.

Two things the workflow has to get right, both of which fail silently otherwise:

- **`user:` in the compose file** is set from the invoking uid/gid (via
  `SMOKE_UID` / `SMOKE_GID`, exported by the Makefile). Docker Desktop remaps
  ownership on a bind mount; a Linux runner does not, so without this the output is
  root-owned and the runner can neither upload nor delete it. The image makes
  `/workspace/out` and `/workspace/.cache` mode-1777 to suit an arbitrary uid, which
  has no `/etc/passwd` entry to chown to.
- **`include-hidden-files: true`** on the artifact upload. Almost everything
  installed sits under `.codex/` or `.claude/`, and `actions/upload-artifact`
  excludes dotted paths by default — the artifact would otherwise contain the
  lockfile and nothing else.

The job depends on `anthropics/skills#main` staying resolvable with the `pdf`,
`xlsx`, and `mcp-builder` skills present. That is a real external dependency: an
upstream rename would fail CI for a reason unrelated to this repository. Pinning the
ref to a tag would remove the risk, at the cost of no longer exercising
ref-to-commit resolution — a full SHA short-circuits that path entirely.

## Notes

- `GITHUB_MCP_TOKEN` is a dummy value. It is never contacted — it exists to prove
  that a token reaches an in-process SDK as a value while staying a *name* in
  every file written to disk.
- Setting `GITHUB_TOKEN` is optional and only lifts the anonymous GitHub API rate
  limit, which a shared CI runner can exhaust.
- **No install location is configured.** The targets are built bare —
  `codexTarget()`, `claudeTarget({ consumer: "agent-sdk" })` — and the manager is
  given no `root`, so every path comes from the library's own defaults
  (`$HOME/.codex`, and the working directory for Claude). The output is steered
  onto the mount by setting `HOME` and `WORKDIR` to it in the image, which keeps
  the default resolution logic under test rather than bypassing it with arguments.
  Three assertions pin the resolved paths against literals.
- `CODEX_HOME` is deliberately left unset, since setting it would override the
  default being tested. The run aborts if it is set, or if `HOME` and the working
  directory disagree.
- `XDG_CACHE_HOME` points outside the mount so neither agent-outfitter's tree
  cache nor giget's tarball cache lands on the host. Following `HOME` they would
  end up inside it and persist between runs, which would make the reported "cold
  cache" untrue and bury the installed tree. This is still the default cache
  resolution path, not an override: `AGENT_OUTFITTER_CACHE_DIR` is unset.
