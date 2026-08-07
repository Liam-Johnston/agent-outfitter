---
"agent-outfitter": minor
---

Install whole committed harnesses, not just skills: two new primitive kinds, and a trust gate
that describes what an executable harness actually registers.

**`bundle`** — an opaque subtree, pinned by commit and tree hash, copied verbatim to declared
destinations. A skill is discovered by its `SKILL.md`; a framework's `tools/`, `knowledge/`, and
`hooks/` announce nothing, so a bundle is *declared* instead, with explicit source-to-destination
mappings. Each destination is written atomically and its exec bits re-derived. Destinations must
stay under the target root: absolute paths, `~`, and `..` segments are refused at manifest
validation rather than normalized, and two bundles claiming one destination is an error rather
than a first-wins warning. The lockfile records a hash per declared path, so `verify()` names the
tree that drifted. Bundles have no transitive form: only the consumer's manifest can declare one.

**`settings`** — an ownership-tracked merge into `.claude/settings.json`, from a JSON ref or an
inline object. `env` merges per key, `permissions.allow`/`deny`/`ask` union by exact string, and
hook registrations are tracked at the innermost `{ type, command }` element, keyed by event +
matcher + command. A matcher group is pruned only when it empties *and* agent-outfitter created
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
