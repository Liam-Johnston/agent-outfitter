# agent-outfitter

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
  Agent SDK that meant reconstructing `settingSources` — the option whose absence
  loads no filesystem skills at all — from a warning message, which is the one
  failure mode with no visible symptom: the agent starts normally and silently
  knows nothing.

  `codexTarget().sdkOptions()` returns `env.CODEX_HOME` plus `config.mcp_servers`,
  in both `mcpMode`s rather than only `"sdk-config"`.
  `claudeTarget().sdkOptions()` returns `settingSources` (or `plugins` in plugin
  mode), `mcpServers`, and `cwd`. Both also return `skillsDir` and
  `instructionPath`.

  Note that `sdkOptions().mcpServers` resolves env-var references to **values**,
  unlike the `${VAR}` placeholders written into `.mcp.json` — nothing expands a
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
  harness — one self-contained `setupCodex()` / `setupClaude()` apiece, manifest
  through install through SDK handoff, with the assertions kept out in the test that
  drives them. They are typechecked in CI so a broken example cannot ship.

## 0.1.0

### Minor Changes

- 0427c20: Initial release: a library-first agent package manager.

  Provisions **agent primitives** — skills, MCP servers, and instruction fragments —
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
