# agent-outfitter

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
