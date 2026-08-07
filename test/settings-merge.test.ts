/**
 * `mergeSettings` is where the bugs would live, so it is tested directly and
 * hard: pure inputs, pure outputs, one behaviour per case.
 *
 * The invariant every case is really checking is the same one: the file belongs
 * to the user, and agent-outfitter may only touch the keys it recorded as its own.
 */

import { describe, expect, test } from "bun:test";

import { TargetError } from "../src/errors.js";
import {
  emptyOwnedSettingsKeys,
  hookGroupKey,
  hookKey,
  mergeSettings,
  settingsProjectionHash,
  unionOwnedSettings,
} from "../src/primitives/settings.js";
import type { OwnedSettingsKeys, ResolvedSettings, SettingsFragment } from "../src/types.js";

const PATH = "/project/.claude/settings.json";

const fragment = (name: string, settings: SettingsFragment): ResolvedSettings => ({
  name,
  settings,
  source: { type: "local", path: "/project" },
  ref: "",
  commit: "",
  subdir: "",
  contentHash: `sha256-${name}`,
  inline: true,
  declaredBy: "manifest",
  trusted: true,
});

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const parse = (content: string): Record<string, unknown> =>
  JSON.parse(content) as Record<string, unknown>;

const merge = (
  existing: string | undefined,
  fragments: ResolvedSettings[],
  owned: OwnedSettingsKeys = emptyOwnedSettingsKeys(),
) => mergeSettings(existing, fragments, owned, PATH);

/** One hook, in the array-in-array shape settings.json actually uses. */
const hook = (event: string, matcher: string, command: string): SettingsFragment => ({
  hooks: { [event]: [{ matcher, hooks: [{ type: "command", command }] }] },
});

describe("mergeSettings: fresh files", () => {
  test("writes into an absent file", () => {
    const result = merge(undefined, [fragment("a", { env: { AIDLC_MODE: "strict" } })]);
    expect(parse(result.content)).toEqual({ env: { AIDLC_MODE: "strict" } });
    expect(result.owned.a!.env).toEqual(["AIDLC_MODE"]);
    expect(result.warnings).toEqual([]);
  });

  test("writes into an empty file", () => {
    const result = merge("", [fragment("a", { model: "opus" })]);
    expect(parse(result.content)).toEqual({ model: "opus" });
    expect(result.owned.a!.scalars).toEqual(["model"]);
  });

  test("leaves no file behind when there is nothing to write", () => {
    const result = merge(undefined, []);
    expect(result.content.trim()).toBe("{}");
    expect(result.owned).toEqual({});
  });

  test("throws on unparseable JSON rather than clobbering it", () => {
    expect(() => merge("{ not json", [fragment("a", { model: "opus" })])).toThrow(TargetError);
    expect(() => merge("{ not json", [])).toThrow(/Fix or remove the file/);
  });

  test("throws when the file holds something other than an object", () => {
    expect(() => merge("[1, 2]", [])).toThrow(TargetError);
  });
});

describe("mergeSettings: the user's file", () => {
  test("a hand-written file is returned byte for byte when nothing changes", () => {
    // Four-space indent, on purpose: a no-op merge must not reformat.
    const existing = '{\n    "model": "opus",\n    "env": {"THEIRS": "1"}\n}\n';
    expect(merge(existing, []).content).toBe(existing);
  });

  test("does not overwrite a scalar the user set by hand", () => {
    const existing = json({ model: "sonnet" });
    const result = merge(existing, [fragment("a", { model: "opus" })]);

    expect(result.content).toBe(existing);
    expect(result.owned.a!.scalars).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(["settings-conflict"]);
    expect(result.warnings[0]!.message).toContain("already set");
  });

  test("does not overwrite an env value the user set by hand", () => {
    const existing = json({ env: { SHARED: "theirs" } });
    const result = merge(existing, [fragment("a", { env: { SHARED: "ours" } })]);

    expect(parse(result.content)).toEqual({ env: { SHARED: "theirs" } });
    expect(result.owned.a!.env).toEqual([]);
    expect(result.warnings[0]!.code).toBe("settings-conflict");
  });

  test("keeps unrelated keys untouched while merging its own", () => {
    const existing = json({
      $schema: "https://example.invalid/settings.json",
      cleanupPeriodDays: 30,
      env: { THEIRS: "1" },
    });
    const result = merge(existing, [fragment("a", { env: { OURS: "2" } })]);

    expect(parse(result.content)).toEqual({
      $schema: "https://example.invalid/settings.json",
      cleanupPeriodDays: 30,
      env: { THEIRS: "1", OURS: "2" },
    });
  });
});

describe("mergeSettings: scalars", () => {
  test("two fragments declaring the same scalar differently write neither", () => {
    const result = merge(undefined, [
      fragment("a", { model: "opus" }),
      fragment("b", { model: "sonnet" }),
    ]);

    expect(result.content.trim()).toBe("{}");
    expect(result.warnings.map((w) => w.code)).toEqual(["settings-conflict"]);
    expect(result.warnings[0]!.message).toContain("neither value was written");
  });

  test("two fragments agreeing on a scalar both own it", () => {
    const result = merge(undefined, [
      fragment("a", { model: "opus" }),
      fragment("b", { model: "opus" }),
    ]);

    expect(parse(result.content)).toEqual({ model: "opus" });
    expect(result.owned.a!.scalars).toEqual(["model"]);
    expect(result.owned.b!.scalars).toEqual(["model"]);
    expect(result.warnings).toEqual([]);
  });

  test("removes an owned scalar nobody declares any more", () => {
    const existing = json({ model: "opus", cleanupPeriodDays: 30 });
    const owned: OwnedSettingsKeys = { ...emptyOwnedSettingsKeys(), scalars: ["model"] };
    const result = merge(existing, [], owned);

    expect(parse(result.content)).toEqual({ cleanupPeriodDays: 30 });
  });

  test("treats a nested non-array permissions key as a scalar", () => {
    const result = merge(undefined, [
      fragment("a", { permissions: { defaultMode: "acceptEdits" } }),
    ]);

    expect(parse(result.content)).toEqual({ permissions: { defaultMode: "acceptEdits" } });
    expect(result.owned.a!.scalars).toEqual(["permissions.defaultMode"]);
  });

  test("carries a large opaque string like any other scalar", () => {
    const announcement = "x".repeat(2500);
    const result = merge(undefined, [fragment("a", { companyAnnouncements: announcement })]);
    expect(parse(result.content).companyAnnouncements).toBe(announcement);
    expect(result.owned.a!.scalars).toEqual(["companyAnnouncements"]);
  });
});

describe("mergeSettings: permissions", () => {
  test("unions entries without duplicating them", () => {
    const existing = json({ permissions: { allow: ["Bash(git:*)"] } });
    const result = merge(existing, [
      fragment("a", { permissions: { allow: ["Bash(git:*)", "Read(**)"] } }),
      fragment("b", { permissions: { allow: ["Read(**)", "Write(**)"] } }),
    ]);

    expect(parse(result.content)).toEqual({
      permissions: { allow: ["Bash(git:*)", "Read(**)", "Write(**)"] },
    });
  });

  test("does not claim an entry the user already had", () => {
    const existing = json({ permissions: { allow: ["Bash(git:*)"] } });
    const result = merge(existing, [
      fragment("a", { permissions: { allow: ["Bash(git:*)"] } }),
    ]);

    // Claiming it would mean deleting the user's rule when "a" goes away.
    expect(result.owned.a!.permissions).toEqual({});
    expect(result.content).toBe(existing);
  });

  test("removes only the entries it owns", () => {
    const existing = json({ permissions: { allow: ["Bash(git:*)", "Read(**)"] } });
    const owned: OwnedSettingsKeys = {
      ...emptyOwnedSettingsKeys(),
      permissions: { allow: ["Read(**)"] },
    };
    const result = merge(existing, [], owned);

    expect(parse(result.content)).toEqual({ permissions: { allow: ["Bash(git:*)"] } });
  });

  test("handles deny and ask the same way as allow", () => {
    const result = merge(undefined, [
      fragment("a", { permissions: { deny: ["Read(./.env)"], ask: ["Bash(rm:*)"] } }),
    ]);

    expect(parse(result.content)).toEqual({
      permissions: { deny: ["Read(./.env)"], ask: ["Bash(rm:*)"] },
    });
    expect(result.owned.a!.permissions).toEqual({
      ask: ["Bash(rm:*)"],
      deny: ["Read(./.env)"],
    });
  });

  test("reports rather than mangles a wrong-shaped region", () => {
    const existing = json({ permissions: { allow: "everything" } });
    const result = merge(existing, [fragment("a", { permissions: { allow: ["Read(**)"] } })]);

    expect(result.content).toBe(existing);
    expect(result.warnings.map((w) => w.code)).toEqual(["settings-conflict"]);
  });
});

describe("mergeSettings: hooks", () => {
  test("adds a registration into a matcher group the user already has", () => {
    const existing = json({
      hooks: {
        PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "theirs.sh" }] }],
      },
    });
    const result = merge(existing, [fragment("a", hook("PostToolUse", "Write|Edit", "ours.ts"))]);

    expect(parse(result.content)).toEqual({
      hooks: {
        PostToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [
              { type: "command", command: "theirs.sh" },
              { type: "command", command: "ours.ts" },
            ],
          },
        ],
      },
    });
    expect(result.owned.a!.hooks).toEqual([hookKey("PostToolUse", "Write|Edit", "ours.ts")]);
    // The group was the user's, so it is not ours to prune later.
    expect(result.owned.a!.hookGroups).toEqual([]);
  });

  test("creates a matcher group when none matches, and records that it did", () => {
    const result = merge(undefined, [fragment("a", hook("PreToolUse", "Bash", "guard.ts"))]);

    expect(parse(result.content)).toEqual({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.ts" }] }] },
    });
    expect(result.owned.a!.hookGroups).toEqual([hookGroupKey("PreToolUse", "Bash")]);
  });

  test("keeps a matcherless event registration matcherless", () => {
    const result = merge(undefined, [
      fragment("a", { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "up.ts" }] }] } }),
    ]);

    expect(parse(result.content)).toEqual({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "up.ts" }] }] },
    });
    expect(result.owned.a!.hooks).toEqual([hookKey("SessionStart", "", "up.ts")]);
  });

  test("updates an owned registration in place when its element changes", () => {
    const first = merge(undefined, [
      fragment("a", {
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "g.ts", timeout: 5 }] }] },
      }),
    ]);
    const second = merge(
      first.content,
      [
        fragment("a", {
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "g.ts", timeout: 30 }] }],
          },
        }),
      ],
      unionOwnedSettings(Object.values(first.owned)),
    );

    expect(parse(second.content)).toEqual({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "g.ts", timeout: 30 }] }] },
    });
  });

  test("prunes a matcher group it created once the group empties", () => {
    const installed = merge(undefined, [fragment("a", hook("PreToolUse", "Bash", "guard.ts"))]);
    const removed = merge(
      installed.content,
      [],
      unionOwnedSettings(Object.values(installed.owned)),
    );

    expect(removed.content.trim()).toBe("{}");
  });

  test("does not prune a matcher group the user created, even when emptied", () => {
    const existing = json({
      hooks: {
        PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "ours.ts" }] }],
      },
    });
    // We own the registration but not the group: this is what the lockfile would
    // hold if the user had written the group themselves.
    const owned: OwnedSettingsKeys = {
      ...emptyOwnedSettingsKeys(),
      hooks: [hookKey("PostToolUse", "Write", "ours.ts")],
    };
    const result = merge(existing, [], owned);

    expect(parse(result.content)).toEqual({
      hooks: { PostToolUse: [{ matcher: "Write", hooks: [] }] },
    });
  });

  test("leaves a command the user registered themselves alone", () => {
    const existing = json({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.ts" }] }] },
    });
    const result = merge(existing, [fragment("a", hook("PreToolUse", "Bash", "guard.ts"))]);

    expect(result.content).toBe(existing);
    expect(result.owned.a!.hooks).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual(["settings-conflict"]);
  });

  test("skips a hook entry it could never identify again", () => {
    const result = merge(undefined, [
      fragment("a", { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" }] }] } }),
    ]);

    expect(result.content.trim()).toBe("{}");
    expect(result.warnings[0]!.message).toContain('without a string "command"');
  });

  test("two fragments registering the same command share ownership of it", () => {
    const result = merge(undefined, [
      fragment("a", hook("PreToolUse", "Bash", "guard.ts")),
      fragment("b", hook("PreToolUse", "Bash", "guard.ts")),
    ]);

    const key = hookKey("PreToolUse", "Bash", "guard.ts");
    expect(result.owned.a!.hooks).toEqual([key]);
    expect(result.owned.b!.hooks).toEqual([key]);

    // Dropping one leaves the registration standing, because the other holds it.
    const afterA = merge(result.content, [fragment("b", hook("PreToolUse", "Bash", "guard.ts"))], {
      ...emptyOwnedSettingsKeys(),
      hooks: [key],
      hookGroups: [hookGroupKey("PreToolUse", "Bash")],
    });
    expect(parse(afterA.content)).toEqual(parse(result.content));
  });
});

describe("mergeSettings: idempotence and drift", () => {
  const everything = fragment("aidlc", {
    model: "opus",
    env: { AIDLC_HOME: ".aidlc" },
    permissions: { allow: ["Bash(bun:*)"] },
    statusLine: { type: "command", command: "bun .claude/tools/status.ts" },
    hooks: {
      PostToolUse: [
        { matcher: "Write|Edit", hooks: [{ type: "command", command: "bun .claude/hooks/compile.ts" }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "bun .claude/hooks/audit.ts" }] },
      ],
      SessionStart: [{ hooks: [{ type: "command", command: "bun .claude/hooks/start.ts" }] }],
    },
  });

  test("merging twice is byte-identical", () => {
    const first = merge(undefined, [everything]);
    const second = merge(
      first.content,
      [everything],
      unionOwnedSettings(Object.values(first.owned)),
    );

    expect(second.content).toBe(first.content);
    expect(second.owned).toEqual(first.owned);
  });

  test("a hand-written file survives install then removal, byte for byte", () => {
    const original = json({
      env: { THEIRS: "1" },
      permissions: { allow: ["Bash(git:*)"] },
      hooks: {
        PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "theirs.sh" }] }],
      },
    });

    const installed = merge(original, [everything]);
    expect(installed.content).not.toBe(original);

    const removed = merge(
      installed.content,
      [],
      unionOwnedSettings(Object.values(installed.owned)),
    );
    expect(removed.content).toBe(original);
  });

  test("the owned projection hash moves when an owned value is edited", () => {
    const installed = merge(undefined, [everything]);
    const owned = installed.owned.aidlc!;
    const document = parse(installed.content);

    expect(settingsProjectionHash(document, owned)).toBe(owned.hash);

    const edited = parse(installed.content) as {
      hooks: { PostToolUse: { hooks: { command: string }[] }[] };
    };
    edited.hooks.PostToolUse[0]!.hooks[0]!.command = "bun .claude/hooks/evil.ts";
    expect(settingsProjectionHash(edited, owned)).not.toBe(owned.hash);
  });

  test("the owned projection hash ignores everything it does not own", () => {
    const installed = merge(undefined, [everything]);
    const owned = installed.owned.aidlc!;
    const document = parse(installed.content);
    (document as { cleanupPeriodDays?: number }).cleanupPeriodDays = 90;
    (document.env as Record<string, string>).THEIRS = "later";

    expect(settingsProjectionHash(document, owned)).toBe(owned.hash);
  });

  test("a deleted owned key moves the hash too", () => {
    const installed = merge(undefined, [everything]);
    const owned = installed.owned.aidlc!;
    const document = parse(installed.content);
    delete (document as { model?: string }).model;

    expect(settingsProjectionHash(document, owned)).not.toBe(owned.hash);
  });
});
