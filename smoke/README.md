# Container smoke test

A fresh container installs the published package, outfits an agent from real
sources over the network, and hands the result to a harness SDK. That is the
deployment shape the library is built for, and the one the unit tests do not
cover.

```sh
make smoke          # every harness
make smoke-codex    # Codex only
make smoke-claude   # Claude only
make smoke-aidlc    # a whole committed harness: AWS AI-DLC, from a pinned tag
make smoke-output   # list what the last run left on disk
make smoke-clean    # drop the image, build cache, and output
```

Needs Docker and network access. Takes roughly a minute, most of it building the
image. The install itself runs in a few seconds on a cold cache.

Each run bind-mounts its output, so the installed tree survives the container and
can be opened from the host:

```
test-output/codex/.codex/skills/{pdf,xlsx,mcp-builder,ce-work}/
test-output/codex/.codex/{config.toml,AGENTS.md}
test-output/codex/outfitter.lock.json

test-output/claude/.claude/skills/{pdf,xlsx,mcp-builder,ce-work}/
test-output/claude/{.mcp.json,CLAUDE.md}
test-output/claude/outfitter.lock.json

test-output/aidlc/.claude/skills/aidlc-*/            # 39 skills
test-output/aidlc/.claude/{tools,hooks,knowledge,agents,scopes,sensors,aidlc-common}/
test-output/aidlc/.claude/settings.json              # merged, not written over
test-output/aidlc/{aidlc/,CLAUDE.md,outfitter.lock.json}
```

Nothing configures those paths. They are where the library puts things when you
pass it nothing. `test-output/` is gitignored and cleared at the start of every
run, so it always holds exactly one run's result.

## What it proves

The unit suite runs entirely on `local:` sources and never leaves the process,
which hides four classes of failure. A container hits all four on its first run.

1. **The published package does not resolve.** The image installs
   agent-outfitter from a tarball produced by `bun pm pack`, into an otherwise
   empty container, so `exports`, the `files` list, and the dependency closure
   are exercised the way a consumer meets them rather than the way this repo's
   own tsconfig sees them.
2. **Real sources do not resolve.** Skills come from `anthropics/skills` and
   `EveryInc/compound-engineering-plugin` over the network, which covers commit
   pinning against a live REST API, tarball extraction, and content hashing of
   trees nobody wrote as a fixture. The two repositories are laid out
   differently, so both ref shapes get exercised: a directory of skills narrowed
   by `select`, and a ref pointing straight at one skill's folder inside a
   repository that is a plugin rather than a skills collection.
3. **The harness cannot see what was installed.** This is the check that matters.
   A wrong install path fails loudly. A wrong SDK option produces an agent that
   starts normally and knows nothing, so the test asserts that
   `target.sdkOptions()` points at the same files the install reported writing.
4. **The install misreports itself.** Every file is listed off the filesystem and
   reconciled against the lockfile, so a skill that arrived partially, or a tree
   carrying something the content hash never covered, is caught instead of
   reported as a successful install.

## Layout

| Path | Role |
|---|---|
| **`app/harness/codex.ts`** | **`setupCodex()`. Copy this to outfit Codex.** |
| **`app/harness/claude.ts`** | **`setupClaude()`. Copy this to outfit Claude.** |
| **`app/harness/aidlc.ts`** | **`setupAidlc()`. Copy this to install a whole committed harness.** |
| `app/setup.ts` | The test for the two skill-shaped harnesses: calls one, checks the result. |
| `app/aidlc.ts` | The test for the committed-harness install. Its own entrypoint. |
| `app/assert.ts` | Dependency-free assertions; exits non-zero on any failure. |
| `app/inventory.ts` | Walks the target directories and prints every file installed. |
| `instructions/` | A local instruction fragment, so that primitive stays hermetic. |
| `Dockerfile` | Two stages: pack the library, install it into a clean image. |
| `docker-compose.yml` | The same image twice, differing only by `HARNESS` and its mount. |

The bold files are meant to be read and lifted. Each is self-contained,
covering manifest, MCP servers, policy, auth, install, and SDK handoff in one
file you can read top to bottom, and they duplicate each other rather than share
a helper, so copying one gets you everything. `setup.ts` holds no outfitting
logic of its own: an example carrying test scaffolding is one nobody can lift
cleanly, and assertions living inside the thing they assert on drift towards
agreeing with it.

### The committed-harness run

`smoke-aidlc` is a different shape of claim from the other two. They ask "did the
default paths resolve, and does `sdkOptions()` point at them". This one asks
whether a framework arrives *complete*, and whether it leaves the operator's own
files intact:

- All four kinds land together: 39 skills, the ~227-file engine as a bundle, the
  settings fragment, and an instruction fragment, each pinned to one commit.
- The engine is reconciled file by file against the lockfile's recorded list, and
  the engine is asserted to be on disk **before** the first skill: every one of
  those skills shells into `.claude/tools/aidlc-orchestrate.ts`, so a skill that
  is discoverable before its engine exists reports itself as broken.
- `settings.json` is seeded with a hand-written file first — an `env` value, a
  `permissions.allow` rule, an unrelated scalar, and a hook of their own in an
  event the harness also uses. Every one of them must survive the merge, and after
  `remove()` the file must be **byte-identical** to what was seeded.
- The 18 hook registrations are reconciled against the *source* `settings.json`
  fetched separately, not against a count written into the test, with floors
  underneath so a silently-empty source cannot pass.
- `verify()` is run against a single edited byte in the engine, which must be
  caught.

It also asserts that the hidden-Unicode scan *reports* the four legitimate
mid-file U+FEFFs this source carries. That is why the example uses `scan: "warn"`
rather than `"deny"`: the finding is real, benign, and worth seeing.

## Using these as a starting point

Take the one you need. Each is a single file with no local imports.

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { setupClaude } from "./harness/claude.ts";

const { sdk } = await setupClaude({ instructionsDir: "./instructions" });
for await (const message of query({ prompt, options: { ...sdk } })) {
  // ...
}
```

```ts
import { Codex } from "@openai/codex-sdk";
import { setupCodex } from "./harness/codex.ts";

const { sdk } = await setupCodex({ instructionsDir: "./instructions" });
const codex = new Codex({ env: { ...process.env, ...sdk.env }, config: sdk.config });
```

To adapt one: point `sources` at your own repository, edit the `mcp` and `policy`
blocks, drop `auth` if every source you use is public, and pass
`codexTarget({ codexHome })` or `claudeTarget({ dir })` if you need somewhere
other than the defaults. Both functions also return the `AgentManager`, so a
later `sync()` or `verify()` needs nothing rebuilt.

The two files are near-identical, which is itself a claim under test. If
outfitting Codex and outfitting Claude Code needed materially different wrapper
code, the target abstraction would not be pulling its weight. What genuinely
differs is the SDK handoff, and each file documents its own.

These are examples as much as tests, so `bun run typecheck:smoke` (part of
`make check` and of CI) typechecks them against `src` through a path mapping.
Bun strips types without checking them, so nothing else in the pipeline would
notice an example that does not compile.

## What gets checked

41 assertions per skill-shaped harness (44 for the AI-DLC run), in the order a
wrapper depends on them:

- **Install.** Every requested skill resolved and pinned to a 40-character
  commit, MCP servers and the instruction fragment resolved, lockfile written.
- **Default locations.** The resolved skills directory, instruction file, and
  lockfile path are each compared against a literal (`$HOME/.codex/skills`,
  `<cwd>/.claude/skills`, and so on) rather than against whatever the target
  computed. Nothing configures these, and these assertions are what make
  "default" a claim rather than an assumption.
- **Files.** The skills directory and each `SKILL.md` exist, and every path in
  the install result sits under `sdkOptions().skillsDir`.
- **Inventory.** Every installed file is printed with its size, read off the
  filesystem rather than reported from the install result, then reconciled
  against the file list the lockfile hashed each skill over. Nothing is
  truncated; the listing currently runs to 97 files across the four skills, and
  follows whatever upstream ships. A file missing from the directory, or present
  but unaccounted for in the lockfile, fails the run. That is what makes the
  listing evidence rather than decoration, since a content hash guarding a tree
  that is not the tree on disk guards nothing.
- **Instructions.** The fragment landed inside a managed region, and prose
  written to the file before the install survived it byte for byte.
- **MCP config.** `config.toml` gained `[mcp_servers.*]` for Codex, or
  `.mcp.json` gained `mcpServers` for Claude, with tokens referenced by env-var
  name and no secret value anywhere in the file.
- **SDK handoff.** Codex gets a `CODEX_HOME` matching the install and both
  servers in `config.mcp_servers`. Claude gets `settingSources: ["project"]`, a
  `cwd` at the project root, and MCP entries whose env references are resolved to
  real values, since a `${VAR}` placeholder would reach an in-process SDK as a
  broken credential.
- **Reproducibility.** `verify()` reports no issues, and a second `sync()`
  re-materializes nothing and skips every skill instead.

## Confirming it can fail

A test that has never failed is not yet evidence. Both of these should exit
non-zero.

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
# 1, with "lockfile totals 97, directory holds 98"
```

Both preliminaries matter. `KEEP_OUTPUT=1` is needed because the run otherwise
clears its output directory first and would delete the planted file before
installing. Clearing `test-output/claude` by hand is what keeps the result a
single failure, since skills left over from an earlier run would be skipped
rather than installed and trip four more assertions on the way past. The stray
file also has to sit beside the skill folders rather than inside one: each skill
is materialized by atomic directory replacement, so anything within a skill
folder is simply replaced.

## In CI

`.github/workflows/ci.yml` runs this as a `smoke` job, separate from `build` so
the fast checks are not held behind a Docker build. One matrix entry per harness
means Codex and Claude run in parallel, with `fail-fast: false`, because "Codex
passed, Claude did not" localizes a problem faster than a single cancelled run.
The installed tree is uploaded as `smoke-output-codex` or `smoke-output-claude`,
on failure as well as success, since that tree is the evidence for why an
assertion failed and it is gone once the runner is recycled.

Two things the workflow has to get right, both of which fail silently otherwise:

- **`user:` in the compose file** is set from the invoking uid and gid, via
  `SMOKE_UID` and `SMOKE_GID` exported by the Makefile. Docker Desktop remaps
  ownership on a bind mount and a Linux runner does not, so without this the
  output is root-owned and the runner can neither upload nor delete it. The image
  makes `/workspace/out` and `/workspace/.cache` mode 1777 to suit an arbitrary
  uid, which has no `/etc/passwd` entry to chown to.
- **`include-hidden-files: true`** on the artifact upload. Almost everything
  installed sits under `.codex/` or `.claude/`, and `actions/upload-artifact`
  excludes dotted paths by default, so the artifact would otherwise contain the
  lockfile and nothing else.

The job depends on `anthropics/skills#main` staying resolvable with the `pdf`,
`xlsx`, and `mcp-builder` skills present, and on
`EveryInc/compound-engineering-plugin#main` keeping `skills/ce-work`. That is a
real external dependency: an upstream rename would fail CI for a reason
unrelated to this repository. Pinning the refs to tags would remove the risk, at
the cost of no longer exercising ref-to-commit resolution, which a full SHA
short-circuits entirely.

## Notes

- `GITHUB_MCP_TOKEN` is a dummy value and is never sent anywhere. It exists to
  prove that a token reaches an in-process SDK as a value while staying a name in
  every file written to disk.
- Setting `GITHUB_TOKEN` is optional. It only lifts the anonymous GitHub API rate
  limit, which a shared CI runner can exhaust.
- **No install location is configured.** The targets are built bare, as
  `codexTarget()` and `claudeTarget({ consumer: "agent-sdk" })`, and the manager
  is given no `root`, so every path comes from the library's own defaults:
  `$HOME/.codex` for Codex, the working directory for Claude. The output is
  steered onto the mount by setting `HOME` and `WORKDIR` to it in the image,
  which keeps the default resolution logic under test instead of bypassing it
  with arguments. Three assertions pin the resolved paths against literals.
- `CODEX_HOME` is left unset on purpose, since setting it would override the
  default being tested. The run aborts if it is set, or if `HOME` and the working
  directory disagree.
- `XDG_CACHE_HOME` points outside the mount so that neither agent-outfitter's
  tree cache nor giget's tarball cache lands on the host. Following `HOME` they
  would end up inside it and persist between runs, which would make the reported
  cold cache untrue and bury the installed tree. This is still the default cache
  resolution path rather than an override: `AGENT_OUTFITTER_CACHE_DIR` is unset.
