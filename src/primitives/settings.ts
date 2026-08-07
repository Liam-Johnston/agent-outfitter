/**
 * Settings primitives: the `.claude/settings.json` layer.
 *
 * Instruction fragments get marker comments, which makes their ownership
 * self-describing: the file itself says where our region starts and ends. JSON
 * has nowhere to put a marker, so ownership has to be recorded *outside* the
 * file, in the lockfile, key by key. That record is the whole mechanism. Without
 * it, removal could only clobber, and a reinstall could not tell a stale entry of
 * ours from a deliberate one of the user's.
 *
 * Four regions, three different merge semantics:
 *
 * | Region                       | Semantics                                     |
 * |------------------------------|-----------------------------------------------|
 * | `env.*`                      | key-level: one value per key                   |
 * | `permissions.allow[]` etc.   | set union, tracked by exact string             |
 * | `hooks.<Event>[].hooks[]`    | set union, tracked by event + matcher + command |
 * | `model`, `statusLine`, …     | whole-value, and *not* mergeable: see below    |
 *
 * A scalar cannot be merged. Two fragments both declaring `model` is a conflict,
 * not something to reconcile, and so is one fragment declaring a key the user
 * already set by hand. Both cases warn and leave the file's own value alone,
 * because guessing wrong here silently changes which model an agent runs.
 */

import { TargetError } from "../errors.js";
import { hashCanonicalJson } from "../hash.js";
import type {
  OwnedSettings,
  OwnedSettingsKeys,
  OutfitterWarning,
  ResolvedSettings,
  SettingsFragment,
} from "../types.js";

/** Regions under `permissions` whose value is a list of rule strings. */
const PERMISSION_LIST_REGIONS = new Set(["allow", "deny", "ask"]);

/** Top-level keys with structural merge semantics. Everything else is a scalar. */
const STRUCTURED_KEYS = new Set(["env", "permissions", "hooks"]);

export const emptyOwnedSettingsKeys = (): OwnedSettingsKeys => ({
  env: [],
  permissions: {},
  hooks: [],
  hookGroups: [],
  scalars: [],
});

/**
 * Identity of one hook registration.
 *
 * The innermost `{ type, command }` element is the unit of ownership, because
 * that is the unit a fragment adds and removes. Its enclosing matcher group is
 * shared: a group we did not create may hold the user's own hooks, so it is
 * never removed even when our element leaves it empty.
 */
export const hookKey = (event: string, matcher: string, command: string): string =>
  `${event} ${matcher} ${command}`;

export const hookGroupKey = (event: string, matcher: string): string => `${event} ${matcher}`;

/** Union of several fragments' owned keys: what one merge treats as "ours". */
export const unionOwnedSettings = (
  records: Iterable<OwnedSettingsKeys>,
): OwnedSettingsKeys => {
  const out = emptyOwnedSettingsKeys();
  const env = new Set<string>();
  const hooks = new Set<string>();
  const groups = new Set<string>();
  const scalars = new Set<string>();
  const permissions = new Map<string, Set<string>>();

  for (const record of records) {
    for (const key of record.env) env.add(key);
    for (const key of record.hooks) hooks.add(key);
    for (const key of record.hookGroups) groups.add(key);
    for (const key of record.scalars) scalars.add(key);
    for (const [region, entries] of Object.entries(record.permissions ?? {})) {
      const set = permissions.get(region) ?? new Set<string>();
      for (const entry of entries) set.add(entry);
      permissions.set(region, set);
    }
  }

  out.env = [...env].sort();
  out.hooks = [...hooks].sort();
  out.hookGroups = [...groups].sort();
  out.scalars = [...scalars].sort();
  for (const [region, set] of [...permissions].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out.permissions[region] = [...set].sort();
  }
  return out;
};

/**
 * The keys in `keys` that `retained` does not also hold.
 *
 * What makes removing one fragment safe when several are installed. Two fragments
 * can legitimately declare the same env value or register the same hook, and both
 * are recorded as owning it; dropping one of them must not take the other's key
 * with it. Passing the difference as `previouslyManaged` leaves anything still
 * held by a surviving fragment exactly where it is.
 */
export const subtractOwnedSettings = (
  keys: OwnedSettingsKeys,
  retained: OwnedSettingsKeys,
): OwnedSettingsKeys => {
  const without = (from: readonly string[], remove: readonly string[]): string[] => {
    const drop = new Set(remove);
    return from.filter((value) => !drop.has(value));
  };

  const permissions: Record<string, string[]> = {};
  for (const [region, entries] of Object.entries(keys.permissions ?? {})) {
    const remaining = without(entries, retained.permissions?.[region] ?? []);
    if (remaining.length > 0) permissions[region] = remaining;
  }

  return {
    env: without(keys.env, retained.env),
    permissions,
    hooks: without(keys.hooks, retained.hooks),
    hookGroups: without(keys.hookGroups, retained.hookGroups),
    scalars: without(keys.scalars, retained.scalars),
  };
};

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? [...value] : undefined;

/** One hook registration, flattened out of the array-in-array shape. */
interface HookRegistration {
  event: string;
  matcher: string;
  /** Whether the fragment actually spelled a matcher (some events have none). */
  hasMatcher: boolean;
  command: string;
  element: Json;
}

/**
 * Flatten `hooks[Event] -> [{ matcher, hooks: [{ type, command }] }]`.
 *
 * Elements we cannot key (no string `command`) are skipped rather than guessed
 * at: an element whose identity we cannot record is one we could never remove.
 */
const readHooks = (
  value: unknown,
): { registrations: HookRegistration[]; unkeyable: number } => {
  const registrations: HookRegistration[] = [];
  let unkeyable = 0;
  if (!isRecord(value)) return { registrations, unkeyable };

  for (const [event, groups] of Object.entries(value)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const hasMatcher = typeof group.matcher === "string";
      const matcher = hasMatcher ? (group.matcher as string) : "";
      const elements = Array.isArray(group.hooks) ? group.hooks : [];
      for (const element of elements) {
        if (!isRecord(element) || typeof element.command !== "string") {
          unkeyable += 1;
          continue;
        }
        registrations.push({
          event,
          matcher,
          hasMatcher,
          command: element.command,
          element,
        });
      }
    }
  }
  return { registrations, unkeyable };
};

const getPath = (doc: Json, path: readonly string[]): unknown => {
  let current: unknown = doc;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
};

const hasPath = (doc: Json, path: readonly string[]): boolean => {
  let current: unknown = doc;
  for (const [index, segment] of path.entries()) {
    if (!isRecord(current)) return false;
    if (!(segment in current)) return false;
    if (index === path.length - 1) return true;
    current = current[segment];
  }
  return false;
};

const setPath = (doc: Json, path: readonly string[], value: unknown): void => {
  let current = doc;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (!isRecord(next)) current[segment] = {};
    current = current[segment] as Json;
  }
  current[path[path.length - 1]!] = value;
};

const deletePath = (doc: Json, path: readonly string[]): void => {
  let current: unknown = doc;
  for (const segment of path.slice(0, -1)) {
    if (!isRecord(current)) return;
    current = current[segment];
  }
  if (isRecord(current)) delete current[path[path.length - 1]!];
};

const dottedPath = (key: string): string[] => key.split(".");

// ---------------------------------------------------------------------------
// The desired plan
// ---------------------------------------------------------------------------

interface Owned<T> {
  value: T;
  /** Fragment names that asked for this. */
  owners: string[];
}

interface Plan {
  env: Map<string, Owned<unknown>>;
  /** region -> entry -> owners. */
  permissions: Map<string, Map<string, string[]>>;
  hooks: Map<string, Owned<HookRegistration>>;
  scalars: Map<string, Owned<unknown>>;
}

const sameValue = (a: unknown, b: unknown): boolean =>
  hashCanonicalJson(a) === hashCanonicalJson(b);

/**
 * Reduce the fragments to one desired state, warning where they disagree.
 *
 * Sets union without argument. Single-valued keys (`env.*`, scalars) cannot: two
 * fragments naming different values for one key have no correct merge, so the
 * key is dropped from the plan entirely and reported.
 */
const buildPlan = (
  fragments: readonly ResolvedSettings[],
  warn: (warning: OutfitterWarning) => void,
): Plan => {
  const plan: Plan = {
    env: new Map(),
    permissions: new Map(),
    hooks: new Map(),
    scalars: new Map(),
  };
  const conflicted = { env: new Set<string>(), scalars: new Set<string>() };

  const single = (
    bucket: Map<string, Owned<unknown>>,
    seen: Set<string>,
    key: string,
    value: unknown,
    fragment: string,
    label: string,
  ): void => {
    const existing = bucket.get(key);
    if (!existing) {
      if (!seen.has(key)) bucket.set(key, { value, owners: [fragment] });
      return;
    }
    if (sameValue(existing.value, value)) {
      existing.owners.push(fragment);
      return;
    }
    bucket.delete(key);
    seen.add(key);
    warn({
      code: "settings-conflict",
      subject: key,
      message:
        `Settings fragments "${existing.owners.join('", "')}" and "${fragment}" declare ` +
        `different values for ${label} "${key}". It cannot be merged, so neither value was ` +
        `written. Reconcile the fragments, or drop one of them.`,
      detail: { key, fragments: [...existing.owners, fragment] },
    });
  };

  for (const fragment of fragments) {
    const { name, settings } = fragment;

    for (const [key, value] of Object.entries(settings)) {
      if (key === "env") {
        if (!isRecord(value)) {
          warn(shapeWarning(name, "env", "an object"));
          continue;
        }
        for (const [envKey, envValue] of Object.entries(value)) {
          single(plan.env, conflicted.env, envKey, envValue, name, "env key");
        }
        continue;
      }

      if (key === "permissions") {
        if (!isRecord(value)) {
          warn(shapeWarning(name, "permissions", "an object"));
          continue;
        }
        for (const [region, regionValue] of Object.entries(value)) {
          if (PERMISSION_LIST_REGIONS.has(region) || Array.isArray(regionValue)) {
            const entries = asStringArray(regionValue);
            if (!entries) {
              warn(shapeWarning(name, `permissions.${region}`, "a list of strings"));
              continue;
            }
            const bucket = plan.permissions.get(region) ?? new Map<string, string[]>();
            for (const entry of entries) {
              bucket.set(entry, [...(bucket.get(entry) ?? []), name]);
            }
            plan.permissions.set(region, bucket);
            continue;
          }
          // `permissions.defaultMode` and friends: single-valued, not a set.
          single(
            plan.scalars,
            conflicted.scalars,
            `permissions.${region}`,
            regionValue,
            name,
            "settings key",
          );
        }
        continue;
      }

      if (key === "hooks") {
        if (!isRecord(value)) {
          warn(shapeWarning(name, "hooks", "an object keyed by event name"));
          continue;
        }
        const { registrations, unkeyable } = readHooks(value);
        if (unkeyable > 0) {
          warn({
            code: "settings-conflict",
            subject: name,
            message:
              `Settings fragment "${name}" declares ${unkeyable} hook entr${unkeyable === 1 ? "y" : "ies"} ` +
              `without a string "command". agent-outfitter tracks ownership by command, so an entry ` +
              `without one could never be removed again; ${unkeyable === 1 ? "it was" : "they were"} skipped.`,
            detail: { fragment: name, skipped: unkeyable },
          });
        }
        for (const registration of registrations) {
          const id = hookKey(registration.event, registration.matcher, registration.command);
          const existing = plan.hooks.get(id);
          if (existing) existing.owners.push(name);
          else plan.hooks.set(id, { value: registration, owners: [name] });
        }
        continue;
      }

      if (STRUCTURED_KEYS.has(key)) continue;
      single(plan.scalars, conflicted.scalars, key, value, name, "settings key");
    }
  }

  return plan;
};

const shapeWarning = (fragment: string, key: string, expected: string): OutfitterWarning => ({
  code: "settings-conflict",
  subject: fragment,
  message:
    `Settings fragment "${fragment}" declares "${key}" as something other than ${expected}, ` +
    `so it was skipped.`,
  detail: { fragment, key },
});

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

export interface SettingsMergeResult {
  /** The file's new content, or the existing content verbatim when nothing changed. */
  content: string;
  /** Fragment names processed. */
  written: string[];
  /** Keys now owned, per fragment, plus a hash over their values. */
  owned: Record<string, OwnedSettings>;
  warnings: OutfitterWarning[];
}

/**
 * Merge settings fragments into a settings document.
 *
 * Everything outside the keys we own survives untouched. Keys named in
 * `previouslyManaged` but no longer desired are removed; keys the user set by
 * hand are never overwritten, only reported.
 *
 * When the merge would change nothing, the existing content is returned byte for
 * byte rather than re-serialized, so a no-op install cannot reformat a file the
 * user indents their own way.
 */
export const mergeSettings = (
  existing: string | undefined,
  fragments: readonly ResolvedSettings[],
  previouslyManaged: OwnedSettingsKeys,
  configPath: string,
): SettingsMergeResult => {
  const warnings: OutfitterWarning[] = [];
  const warn = (warning: OutfitterWarning): void => {
    warnings.push(warning);
  };

  let doc: Json = {};
  if (existing && existing.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (error) {
      throw new TargetError(
        `Could not parse ${configPath} as JSON: ${(error as Error).message}. ` +
          `Fix or remove the file before installing settings.`,
        { path: configPath },
      );
    }
    if (!isRecord(parsed)) {
      throw new TargetError(
        `${configPath} does not hold a JSON object. Fix or remove the file before ` +
          `installing settings.`,
        { path: configPath },
      );
    }
    doc = structuredClone(parsed);
  }

  const plan = buildPlan(fragments, warn);
  const ownedBefore = normalizeOwned(previouslyManaged);
  const owned = new Map<string, OwnedSettingsKeys>();
  for (const fragment of fragments) owned.set(fragment.name, emptyOwnedSettingsKeys());
  let changed = false;

  const claim = (owners: readonly string[], apply: (keys: OwnedSettingsKeys) => void): void => {
    for (const name of owners) {
      const keys = owned.get(name);
      if (keys) apply(keys);
    }
  };

  // -- removals: keys we own that nobody wants any more ---------------------

  for (const key of ownedBefore.env) {
    if (plan.env.has(key)) continue;
    if (hasPath(doc, ["env", key])) {
      deletePath(doc, ["env", key]);
      changed = true;
    }
  }

  for (const key of ownedBefore.scalars) {
    if (plan.scalars.has(key)) continue;
    const path = dottedPath(key);
    if (hasPath(doc, path)) {
      deletePath(doc, path);
      changed = true;
    }
  }

  for (const [region, entries] of Object.entries(ownedBefore.permissions)) {
    const desired = plan.permissions.get(region);
    const drop = entries.filter((entry) => !desired?.has(entry));
    if (drop.length === 0) continue;
    const current = asStringArray(getPath(doc, ["permissions", region]));
    if (!current) continue;
    const next = current.filter((entry) => !drop.includes(entry));
    if (next.length !== current.length) {
      setPath(doc, ["permissions", region], next);
      changed = true;
    }
  }

  const ownedHooksBefore = new Set(ownedBefore.hooks);
  const ownedGroupsBefore = new Set(ownedBefore.hookGroups);
  const dropHooks = [...ownedHooksBefore].filter((key) => !plan.hooks.has(key));
  if (dropHooks.length > 0 && isRecord(doc.hooks)) {
    if (removeHookRegistrations(doc.hooks, new Set(dropHooks), ownedGroupsBefore)) changed = true;
  }

  // -- upserts --------------------------------------------------------------

  for (const [key, entry] of plan.env) {
    const path = ["env", key];
    const present = hasPath(doc, path);
    const ours = ownedBefore.env.includes(key);
    if (present && !ours) {
      warn(handWrittenWarning(configPath, `env.${key}`, entry.owners));
      continue;
    }
    if (!present || !sameValue(getPath(doc, path), entry.value)) {
      setPath(doc, path, entry.value);
      changed = true;
    }
    claim(entry.owners, (keys) => keys.env.push(key));
  }

  for (const [key, entry] of plan.scalars) {
    const path = dottedPath(key);
    const present = hasPath(doc, path);
    const ours = ownedBefore.scalars.includes(key);
    if (present && !ours) {
      warn(handWrittenWarning(configPath, key, entry.owners));
      continue;
    }
    if (!present || !sameValue(getPath(doc, path), entry.value)) {
      setPath(doc, path, entry.value);
      changed = true;
    }
    claim(entry.owners, (keys) => keys.scalars.push(key));
  }

  for (const [region, entries] of plan.permissions) {
    const path = ["permissions", region];
    const raw = getPath(doc, path);
    const current = raw === undefined ? [] : asStringArray(raw);
    if (!current) {
      warn({
        code: "settings-conflict",
        subject: `permissions.${region}`,
        message:
          `${configPath} holds "permissions.${region}" as something other than a list of ` +
          `strings, so the entries from ${[...new Set([...entries.values()].flat())].join(", ")} ` +
          `were not added.`,
        detail: { path: configPath, region },
      });
      continue;
    }
    const ownedHere = ownedBefore.permissions[region] ?? [];
    const next = [...current];
    for (const [entry, owners] of entries) {
      const alreadyPresent = next.includes(entry);
      // An entry the user already wrote stays theirs: claiming it would mean
      // deleting their rule the next time this fragment goes away.
      if (alreadyPresent && !ownedHere.includes(entry)) continue;
      if (!alreadyPresent) {
        next.push(entry);
        changed = true;
      }
      claim(owners, (keys) => {
        (keys.permissions[region] ??= []).push(entry);
      });
    }
    if (next.length !== current.length || raw === undefined) {
      setPath(doc, path, next);
      changed = true;
    }
  }

  for (const [key, entry] of plan.hooks) {
    const registration = entry.value;
    if (!isRecord(doc.hooks)) doc.hooks = {};
    const hooks = doc.hooks as Json;
    if (!Array.isArray(hooks[registration.event])) hooks[registration.event] = [];
    const groups = hooks[registration.event] as unknown[];

    const group = groups.find(
      (candidate) =>
        isRecord(candidate) &&
        (typeof candidate.matcher === "string" ? candidate.matcher : "") === registration.matcher,
    ) as Json | undefined;

    if (!group) {
      const created: Json = {
        ...(registration.hasMatcher ? { matcher: registration.matcher } : {}),
        hooks: [structuredClone(registration.element)],
      };
      groups.push(created);
      changed = true;
      claim(entry.owners, (keys) => {
        keys.hooks.push(key);
        keys.hookGroups.push(hookGroupKey(registration.event, registration.matcher));
      });
      continue;
    }

    if (!Array.isArray(group.hooks)) group.hooks = [];
    const elements = group.hooks as unknown[];
    const index = elements.findIndex(
      (candidate) => isRecord(candidate) && candidate.command === registration.command,
    );
    const ours = ownedHooksBefore.has(key);
    if (index === -1) {
      elements.push(structuredClone(registration.element));
      changed = true;
    } else if (!ours) {
      // The user registered this command themselves. Leave it exactly as it is.
      warn(handWrittenWarning(configPath, `hooks.${registration.event} (${registration.command})`, entry.owners));
      continue;
    } else if (!sameValue(elements[index], registration.element)) {
      elements[index] = structuredClone(registration.element);
      changed = true;
    }
    claim(entry.owners, (keys) => {
      keys.hooks.push(key);
      if (ownedGroupsBefore.has(hookGroupKey(registration.event, registration.matcher))) {
        keys.hookGroups.push(hookGroupKey(registration.event, registration.matcher));
      }
    });
  }

  if (pruneEmptyContainers(doc)) changed = true;

  const content =
    !changed && existing !== undefined ? existing : `${JSON.stringify(doc, null, 2)}\n`;

  const ownedOut: Record<string, OwnedSettings> = {};
  for (const [name, keys] of owned) {
    const normalized = normalizeOwned(keys);
    ownedOut[name] = { ...normalized, hash: settingsProjectionHash(doc, normalized) };
  }

  return { content, written: fragments.map((f) => f.name), owned: ownedOut, warnings };
};

const handWrittenWarning = (
  configPath: string,
  key: string,
  owners: readonly string[],
): OutfitterWarning => ({
  code: "settings-conflict",
  subject: key,
  message:
    `"${key}" is already set in ${configPath} by hand, so ${owners.map((o) => `"${o}"`).join(", ")} ` +
    `did not overwrite it. Remove it from the file to let agent-outfitter manage it, or drop it ` +
    `from the fragment.`,
  detail: { path: configPath, key, fragments: [...owners] },
});

/**
 * Drop owned hook registrations, and the groups we created to hold them.
 *
 * A matcher group that still holds anything, or that we did not create, is left
 * in place: the user may have put their own hooks beside ours.
 */
const removeHookRegistrations = (
  hooks: Json,
  drop: ReadonlySet<string>,
  ownedGroups: ReadonlySet<string>,
): boolean => {
  let changed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const keptGroups: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group)) {
        keptGroups.push(group);
        continue;
      }
      const matcher = typeof group.matcher === "string" ? group.matcher : "";
      const elements = Array.isArray(group.hooks) ? group.hooks : [];
      const kept = elements.filter(
        (element) =>
          !(
            isRecord(element) &&
            typeof element.command === "string" &&
            drop.has(hookKey(event, matcher, element.command))
          ),
      );
      if (kept.length !== elements.length) {
        group.hooks = kept;
        changed = true;
      }
      if (kept.length === 0 && ownedGroups.has(hookGroupKey(event, matcher))) {
        changed = true;
        continue; // A group we created and just emptied.
      }
      keptGroups.push(group);
    }
    if (keptGroups.length !== groups.length) {
      hooks[event] = keptGroups;
      changed = true;
    }
  }
  return changed;
};

/** Remove containers our removals emptied, so the file does not accumulate husks. */
const pruneEmptyContainers = (doc: Json): boolean => {
  let changed = false;

  if (isRecord(doc.hooks)) {
    for (const [event, groups] of Object.entries(doc.hooks)) {
      if (Array.isArray(groups) && groups.length === 0) {
        delete doc.hooks[event];
        changed = true;
      }
    }
    if (Object.keys(doc.hooks).length === 0) {
      delete doc.hooks;
      changed = true;
    }
  }

  if (isRecord(doc.permissions)) {
    for (const [region, value] of Object.entries(doc.permissions)) {
      if (Array.isArray(value) && value.length === 0) {
        delete doc.permissions[region];
        changed = true;
      }
    }
    if (Object.keys(doc.permissions).length === 0) {
      delete doc.permissions;
      changed = true;
    }
  }

  if (isRecord(doc.env) && Object.keys(doc.env).length === 0) {
    delete doc.env;
    changed = true;
  }

  return changed;
};

/** Sort and de-duplicate an ownership record, so the lockfile diff is stable. */
export const normalizeOwned = (keys: OwnedSettingsKeys): OwnedSettingsKeys => {
  const uniq = (values: readonly string[]): string[] => [...new Set(values)].sort();
  const permissions: Record<string, string[]> = {};
  for (const region of Object.keys(keys.permissions ?? {}).sort()) {
    const entries = uniq(keys.permissions[region] ?? []);
    if (entries.length > 0) permissions[region] = entries;
  }
  return {
    env: uniq(keys.env),
    permissions,
    hooks: uniq(keys.hooks),
    hookGroups: uniq(keys.hookGroups),
    scalars: uniq(keys.scalars),
  };
};

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

/**
 * The owned slice of a settings document, in a canonical shape.
 *
 * Hashing this is what makes drift detectable without storing the values
 * themselves in the lockfile: an edited command, a changed `model`, or a deleted
 * key all move the hash, while anything the user does elsewhere in the file
 * leaves it alone.
 */
export const settingsProjection = (doc: unknown, keys: OwnedSettingsKeys): unknown => {
  if (!isRecord(doc)) return { missing: true };
  const normalized = normalizeOwned(keys);

  const env: Record<string, unknown> = {};
  for (const key of normalized.env) {
    if (hasPath(doc, ["env", key])) env[key] = getPath(doc, ["env", key]);
  }

  const scalars: Record<string, unknown> = {};
  for (const key of normalized.scalars) {
    const path = dottedPath(key);
    if (hasPath(doc, path)) scalars[key] = getPath(doc, path);
  }

  const permissions: Record<string, string[]> = {};
  for (const [region, entries] of Object.entries(normalized.permissions)) {
    const current = asStringArray(getPath(doc, ["permissions", region])) ?? [];
    permissions[region] = entries.filter((entry) => current.includes(entry));
  }

  const present = new Map<string, unknown>();
  for (const registration of readHooks(doc.hooks).registrations) {
    present.set(
      hookKey(registration.event, registration.matcher, registration.command),
      registration.element,
    );
  }
  const hooks: Record<string, unknown> = {};
  for (const key of normalized.hooks) {
    if (present.has(key)) hooks[key] = present.get(key);
  }

  return { env, permissions, hooks, scalars };
};

export const settingsProjectionHash = (doc: unknown, keys: OwnedSettingsKeys): string =>
  hashCanonicalJson(settingsProjection(doc, keys));

/** Parse a settings file for drift checking. Returns `undefined` when unreadable. */
export const parseSettingsDocument = (content: string | undefined): unknown => {
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
};

/** Validate that a fetched settings fragment is a JSON object, and parse it. */
export const parseSettingsFragment = (
  content: string,
  origin: string,
): SettingsFragment => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new TargetError(
      `Settings fragment ${origin} is not valid JSON: ${(error as Error).message}.`,
      { origin },
    );
  }
  if (!isRecord(parsed)) {
    throw new TargetError(`Settings fragment ${origin} must be a JSON object.`, { origin });
  }
  return parsed;
};

/**
 * Everything a settings fragment would register, for the trust gate to describe.
 *
 * Counted from the fragment rather than from the merged file so the numbers
 * describe what the operator is being asked to consent to, not what survived.
 */
export interface SettingsRegistrations {
  hooks: number;
  events: string[];
  commands: string[];
  permissionsAllow: string[];
  statusLine: boolean;
}

export const settingsRegistrations = (
  fragments: readonly ResolvedSettings[],
): SettingsRegistrations => {
  const events = new Set<string>();
  const commands = new Set<string>();
  const permissionsAllow = new Set<string>();
  let hooks = 0;
  let statusLine = false;

  for (const fragment of fragments) {
    const { registrations } = readHooks(fragment.settings.hooks);
    for (const registration of registrations) {
      hooks += 1;
      events.add(registration.event);
      commands.add(registration.command);
    }
    if (fragment.settings.statusLine !== undefined) statusLine = true;
    const permissions = fragment.settings.permissions;
    if (isRecord(permissions)) {
      for (const entry of asStringArray(permissions.allow) ?? []) permissionsAllow.add(entry);
    }
  }

  return {
    hooks,
    events: [...events].sort(),
    commands: [...commands].sort(),
    permissionsAllow: [...permissionsAllow].sort(),
    statusLine,
  };
};
