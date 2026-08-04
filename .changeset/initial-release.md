---
"skillsmith": minor
---

Initial release: library-first agent-skill package manager.

- `createSkillManager()` with `resolve`, `install`, `add`, `sync`, `list`, `remove`, `verify`
- `skill` and `mcp` primitives, with transitive dependency resolution and MCP trust gating
- `codexTarget`, `claudeTarget`, `filesystemTarget`, `openaiHostedTarget`
- Manifest (`skills.config.{ts,yaml,json}`) and lockfile (`skills.lock.json`) with content-hash pinning
- Git-host-agnostic fetching with no `git` binary required; policy engine with source allowlists,
  script gating, and hidden-Unicode scanning
