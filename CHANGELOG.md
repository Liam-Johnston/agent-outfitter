# agent-outfitter

## 0.3.0

### Minor Changes

- e096462: Install whole committed harnesses, not just skills: two new primitive kinds, and a trust gate
  that describes what an executable harness actually registers.

  **`bundle`** — an opaque subtree, pinned by commit and tree hash, copied verbatim to declared
  destinations. A skill is discovered by its `SKILL.md`; a framework's `tools/`, `knowledge/`, and
  `hooks/` announce nothing, so a bundle is _declared_ instead, with explicit source-to-destination
  mappings. Each destination is written atomically and its exec bits re-derived. Destinations must
  stay under the target root: absolute paths, `~`, and `..` segments are refused at manifest
  validation rather than normalized, and two bundles claiming one destination is an error rather
  than a first-wins warning. The lockfile records a hash per declared path, so `verify()` names the
  tree that drifted. Bundles have no transitive form: only the consumer's manifest can declare one.

  **`settings`** — an ownership-tracked merge into `.claude/settings.json`, from a JSON ref or an
  inline object. `env` merges per key, `permissions.allow`/`deny`/`ask` union by exact string, and
  hook registrations are tracked at the innermost `{ type, command }` element, keyed by event +
  matcher + command. A matcher group is pruned only when it empties _and_ agent-outfitter created
  it. Scalars (`model`, `statusLine`, …) are not mergeable: a key the user set by hand, or two
  fragments that disagree, warn with the new `settings-conflict` code and leave the file's value
  alone. The upshot is that a hand-written `settings.json` survives install → `remove()` byte for
  byte, and `verify()` reports `settings-drift` for an edited owned value while ignoring everything
  else in the file.

  **`policy.executableHarness`** — `"allow" | "warn" | "deny"`, **defaulting to `"deny"`**. A
  separate axis from `scripts`, because it is a larger claim: hooks fire on every matching tool call
  whether or not anything invoked them, and `permissions.allow` entries pre-approve tools without
  prompting. The refusal names the files, hook registrations, events, and pre-approvals it would
  have put in place. Detection is extension-based plus any file a hook or status-line command
  references, not a path prefix — `scriptFiles()`'s `scripts/` convention would have reported an
  engine of 54 executables as script-free.

  Post-install command execution stays deliberately absent. "Files are copied and text is merged,
  nothing more" is why this library is safe to point at a third-party repository; a framework that
  needs compiling can self-compile through its own hook on first use.

  ### Breaking

  - **Lockfile forward-incompatibility.** New `bundles` and `settings` sections, plus per-target
    `bundles`/`settings`/`settingsPath`. Every schema level is strict, so a current reader accepts
    an older lockfile but an **older reader rejects a lockfile written by this version**. Staying at
    `version: 1` is the deliberate trade at 0.x; upgrade in lockstep, or pin.
  - `checkTree()` takes a `label` first argument (`checkTree("Skill", name, root, files, policy)`) so
    its messages can name the kind being staged. Only affects callers using it directly.
  - `Resolution` and `InstallResult` gained required `bundles` and `settings` fields, and
    `resolve:done` gained `bundles`/`settings` counts. Only affects code constructing those by hand.

### Patch Changes

- 064c3fa: Reword the package description so it reads plainly, and lead the README with an
  npm version badge. No code changes.

## 0.2.0

### Minor Changes

- 1c7f095: Add `sdkOptions()` to the Codex and Claude targets, and retry transient network
  failures.

  **`sdkOptions()`** returns everything an in-process harness SDK needs to see what
  the target just installed, computed from the same paths the install wrote to:

  ```ts
  const claudeT = claudeTarget({ dir: "/workspace/project", consumer: "agent-sdk" });
  await createAgentManager({ targets: [claudeT] }).install();
  for await (const m of query({ prompt, options: { ...claudeT.sdkOptions() } })) { … }
  ```

  Previously a wrapper application had to re-derive this by hand. For the Claude
  Agent SDK that meant reconstructing `settingSources`, the option whose absence
  loads no filesystem skills at all, from a warning message, which is the one
  failure mode with no visible symptom: the agent starts normally and silently
  knows nothing.

  `codexTarget().sdkOptions()` returns `env.CODEX_HOME` plus `config.mcp_servers`,
  in both `mcpMode`s rather than only `"sdk-config"`.
  `claudeTarget().sdkOptions()` returns `settingSources` (or `plugins` in plugin
  mode), `mcpServers`, and `cwd`. Both also return `skillsDir` and
  `instructionPath`.

  Note that `sdkOptions().mcpServers` resolves env-var references to **values**,
  unlike the `${VAR}` placeholders written into `.mcp.json`, nothing expands a
  placeholder in an in-process options object, so one would reach the SDK as a
  broken credential. A referenced variable that is unset is now warned about at
  install time instead of surfacing as an opaque auth failure on the agent's first
  tool call.

  **Network retries.** Commit resolution and tarball downloads now make up to three
  attempts with jittered exponential backoff on 5xx, 429, 408, 425, and
  transport-level errors. A 401, 403, or 404 is not retried. This matters most for a
  single-task container, where the cache is cold by definition: every fetch is live,
  so one transient 502 took the whole task down. Retries are reported as a new
  `source:retry` event.

  Also adds a container smoke test (`make smoke`, and a parallel `smoke` job in CI)
  covering both harnesses against the real network and installing into the library's
  default locations, and removes an unreachable `offline` option from the internal
  resolver options that never took effect.

  Its `smoke/app/harness/{codex,claude}.ts` double as the worked example for each
  harness: one self-contained `setupCodex()` / `setupClaude()` apiece, manifest
  through install through SDK handoff, with the assertions kept out in the test that
  drives them. They are typechecked in CI so a broken example cannot ship.

## 0.1.0

### Minor Changes

- 0427c20: Initial release: a library-first agent package manager.

  Provisions **agent primitives** (skills, MCP servers, and instruction fragments)
  into agent harnesses, behind an `await`-able TypeScript API rather than a CLI.

  - `createAgentManager()` with `resolve`, `install`, `add`, `sync`, `list`, `remove`, `verify`
  - Primitives: `skill` (SKILL.md folders), `mcp` (stdio/HTTP tool servers), and
    `instruction` (AGENTS.md / CLAUDE.md fragments merged into marked regions)
  - Targets: `codexTarget`, `claudeTarget`, `filesystemTarget`, `openaiHostedTarget`, each
    declaring which primitive kinds it supports
  - Transitive dependency resolution across primitives, with trust gating on both MCP servers
    and instruction fragments reached through a dependency
  - Manifest (`outfitter.config.{ts,yaml,json}`) and lockfile (`outfitter.lock.json`) with
    content-hash pinning and exact commit resolution
  - Git-host-agnostic fetching with no `git` binary required; policy engine with source
    allowlists, script gating, and hidden-Unicode scanning
