/**
 * Manifest loading and validation.
 *
 * Three interchangeable forms: `outfitter.config.ts` (typed, computable),
 * `outfitter.config.yaml`, or `outfitter.config.json`. All three parse into the same
 * `Manifest`; only the serializable forms can be written back by `add`/`remove`.
 */

import { pathToFileURL } from "node:url";
import { extname, join, resolve as resolvePath } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { ManifestError } from "./errors.js";
import { pathExists, readTextFile, writeFileAtomic } from "./fsutil.js";
import type { Manifest, ManifestSourceEntry, NamedMcpServer, AgentTarget } from "./types.js";

/** Filenames probed, in order, when no manifest path is configured. */
export const MANIFEST_CANDIDATES = [
  "outfitter.config.ts",
  "outfitter.config.mts",
  "outfitter.config.js",
  "outfitter.config.mjs",
  "outfitter.config.yaml",
  "outfitter.config.yml",
  "outfitter.config.json",
] as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const authRefSchema = z.union([
  z.object({ env: z.string().min(1) }).strict(),
  z.object({ token: z.string().min(1) }).strict(),
]);

const stdioServerSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  envVars: z.array(z.string()).optional(),
  cwd: z.string().optional(),
});

const httpServerSchema = z.object({
  transport: z.literal("http"),
  url: z.string().url(),
  auth: z.object({ bearerEnv: z.string().min(1).optional() }).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

/**
 * Infer `transport` when it is omitted: a `url` means HTTP, a `command` means
 * stdio. Authors write one less line and the discriminated union still holds.
 */
const withInferredTransport = <T>(schema: z.ZodType<T>): z.ZodType<T> =>
  z.preprocess((value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (obj.transport === undefined) {
        if (typeof obj.url === "string") return { ...obj, transport: "http" };
        if (typeof obj.command === "string") return { ...obj, transport: "stdio" };
      }
    }
    return value;
  }, schema) as z.ZodType<T>;

export const namedMcpServerSchema = withInferredTransport(
  z.discriminatedUnion("transport", [
    stdioServerSchema.extend({ name: z.string().min(1) }),
    httpServerSchema.extend({ name: z.string().min(1) }),
  ]),
) as z.ZodType<NamedMcpServer>;

/** Frontmatter MCP deps use the same shape as manifest entries. */
export const mcpDependencySchema = namedMcpServerSchema;

const manifestSourceSchema = z.union([
  z.string().min(1),
  z
    .object({
      ref: z.string().min(1),
      select: z.union([z.string(), z.array(z.string())]).optional(),
      skillsRoot: z.string().optional(),
      auth: authRefSchema.optional(),
    })
    .strict(),
]);

export const instructionRefSchema = z.union([
  z.string().min(1),
  z
    .object({
      ref: z.string().min(1),
      name: z.string().min(1).optional(),
      select: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .strict(),
]);

/**
 * A bundle destination must stay inside the target's root.
 *
 * Bundles are the one kind whose write location is declared rather than derived,
 * so this is the only place a manifest could aim a copy at `/etc` or `~/.ssh`.
 * Absolute paths, `~`, and any `..` segment are refused outright rather than
 * normalized, because a path that needed normalizing to be safe was not intended.
 */
const containedPath = (label: string) =>
  z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[/\\]/.test(value), {
      message: `${label} must be relative to the target root, not absolute.`,
    })
    .refine((value) => !value.startsWith("~"), {
      message: `${label} must not start with "~"; it would escape the target root.`,
    })
    .refine((value) => !value.split(/[/\\]/).includes(".."), {
      message: `${label} must not contain a ".." segment; it would escape the target root.`,
    });

export const bundleRefSchema = z
  .object({
    ref: z.string().min(1),
    name: z.string().min(1).optional(),
    paths: z
      .record(containedPath("A bundle source path"), containedPath("A bundle destination"))
      .refine((paths) => Object.keys(paths).length > 0, {
        message: 'A bundle needs at least one entry in "paths".',
      }),
    auth: authRefSchema.optional(),
  })
  .strict();

/**
 * A settings fragment: a ref to a JSON file, or an inline object.
 *
 * Inline needs an explicit `name`, since there is no filename to derive one from,
 * and that name is what the lockfile tracks ownership under.
 */
export const settingsRefSchema = z
  .object({
    ref: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    auth: authRefSchema.optional(),
  })
  .strict()
  .refine((entry) => entry.ref !== undefined || entry.settings !== undefined, {
    message: 'A settings entry needs either "ref" or an inline "settings" object.',
  })
  .refine((entry) => entry.ref === undefined || entry.settings === undefined, {
    message: 'A settings entry cannot have both "ref" and an inline "settings" object.',
  })
  .refine((entry) => entry.settings === undefined || entry.name !== undefined, {
    message: 'An inline settings entry needs a "name" to track ownership under.',
  });

const policySchema = z
  .object({
    allowedHosts: z.array(z.string()).optional(),
    allowedOwners: z.array(z.string()).optional(),
    requireLockHashMatch: z.boolean().optional(),
    scripts: z.enum(["allow", "warn", "deny"]).optional(),
    executableHarness: z.enum(["allow", "warn", "deny"]).optional(),
    scan: z.enum(["off", "warn", "deny"]).optional(),
    allowTransitiveMcp: z.boolean().optional(),
    allowTransitiveInstructions: z.boolean().optional(),
    allowedMcpHosts: z.array(z.string()).optional(),
    allowedMcpCommands: z.array(z.string()).optional(),
    allowLocalSources: z.boolean().optional(),
  })
  .strict();

/**
 * Targets are either a built-in name (YAML/JSON) or a live adapter object
 * (TypeScript). Adapters are validated structurally, not by zod's object rules,
 * because they carry methods.
 */
const targetSchema = z.union([
  z.string().min(1),
  z.custom<AgentTarget>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as AgentTarget).name === "string" &&
      typeof (value as AgentTarget).materialize === "function",
    { message: "Target must be a built-in target name or a AgentTarget adapter." },
  ),
]);

export const manifestSchema = z
  .object({
    version: z.literal(1),
    targets: z.array(targetSchema).optional(),
    sources: z.array(manifestSourceSchema).optional(),
    mcp: z.array(namedMcpServerSchema).optional(),
    instructions: z.array(instructionRefSchema).optional(),
    bundles: z.array(bundleRefSchema).optional(),
    settings: z.array(settingsRefSchema).optional(),
    policy: policySchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadedManifest {
  manifest: Manifest;
  /** Absolute path the manifest came from, or `undefined` for inline/default. */
  path?: string;
  /** Whether `add`/`remove` can write this manifest back. */
  writable: boolean;
}

export const emptyManifest = (): Manifest => ({
  version: 1,
  sources: [],
  mcp: [],
  instructions: [],
});

export const validateManifest = (value: unknown, origin: string): Manifest => {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ManifestError(`Invalid manifest (${origin}): ${formatZodError(parsed.error)}`, {
      origin,
      issues: parsed.error.issues,
    });
  }
  return parsed.data as Manifest;
};

export const formatZodError = (error: z.ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

/** Find the first manifest candidate present under `root`. */
export const findManifest = async (root: string): Promise<string | undefined> => {
  for (const candidate of MANIFEST_CANDIDATES) {
    const abs = join(root, candidate);
    if (await pathExists(abs)) return abs;
  }
  return undefined;
};

export const loadManifest = async (options: {
  root: string;
  manifest?: string | Manifest;
}): Promise<LoadedManifest> => {
  const { root } = options;

  if (options.manifest && typeof options.manifest === "object") {
    return { manifest: validateManifest(options.manifest, "inline"), writable: false };
  }

  const path = options.manifest
    ? resolvePath(root, options.manifest)
    : await findManifest(root);

  if (!path) {
    // No manifest is a supported mode: pass refs and targets to the API directly.
    return { manifest: emptyManifest(), writable: false };
  }

  if (!(await pathExists(path))) {
    throw new ManifestError(`Manifest not found at ${path}.`, { path });
  }

  const ext = extname(path).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    const parsed = parseYaml(await readTextFile(path)) as unknown;
    return { manifest: validateManifest(parsed ?? emptyManifest(), path), path, writable: true };
  }
  if (ext === ".json") {
    const parsed = JSON.parse(await readTextFile(path)) as unknown;
    return { manifest: validateManifest(parsed, path), path, writable: true };
  }
  if ([".ts", ".mts", ".js", ".mjs", ".cjs"].includes(ext)) {
    const mod = await importConfigModule(path);
    const value = (mod as { default?: unknown }).default ?? mod;
    const resolved = typeof value === "function" ? await (value as () => unknown)() : value;
    // A TS config can hold live target adapters, so it is never written back.
    return { manifest: validateManifest(resolved, path), path, writable: false };
  }

  throw new ManifestError(
    `Unsupported manifest extension "${ext}" at ${path}. Use .ts, .js, .yaml, or .json.`,
    { path },
  );
};

const importConfigModule = async (path: string): Promise<unknown> => {
  try {
    return (await import(pathToFileURL(path).href)) as unknown;
  } catch (error) {
    const ext = extname(path).toLowerCase();
    if (ext === ".ts" || ext === ".mts") {
      throw new ManifestError(
        `Could not import ${path}. TypeScript manifests need a runtime that strips types ` +
          `(Bun, tsx, or Node >= 22.18). Use outfitter.config.yaml or outfitter.config.json otherwise. ` +
          `Cause: ${(error as Error).message}`,
        { path, cause: (error as Error).message },
      );
    }
    throw new ManifestError(`Could not import ${path}: ${(error as Error).message}`, {
      path,
      cause: (error as Error).message,
    });
  }
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Serializable projection of a manifest. Drops live target adapters. */
const serializableManifest = (manifest: Manifest): Record<string, unknown> => {
  const out: Record<string, unknown> = { version: manifest.version };
  const targets = (manifest.targets ?? []).filter((t): t is string => typeof t === "string");
  if (targets.length > 0) out.targets = targets;
  if (manifest.sources && manifest.sources.length > 0) out.sources = manifest.sources;
  if (manifest.mcp && manifest.mcp.length > 0) out.mcp = manifest.mcp;
  if (manifest.instructions && manifest.instructions.length > 0) {
    out.instructions = manifest.instructions;
  }
  if (manifest.bundles && manifest.bundles.length > 0) out.bundles = manifest.bundles;
  if (manifest.settings && manifest.settings.length > 0) out.settings = manifest.settings;
  if (manifest.policy && Object.keys(manifest.policy).length > 0) out.policy = manifest.policy;
  return out;
};

export const writeManifest = async (path: string, manifest: Manifest): Promise<void> => {
  const ext = extname(path).toLowerCase();
  const data = serializableManifest(manifest);
  if (ext === ".yaml" || ext === ".yml") {
    await writeFileAtomic(path, stringifyYaml(data));
    return;
  }
  if (ext === ".json") {
    await writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  throw new ManifestError(
    `Cannot write manifest ${path}: only .yaml and .json manifests are machine-editable. ` +
      `Edit the TypeScript config by hand.`,
    { path },
  );
};

/** Identity helper that gives `outfitter.config.ts` authors full type inference. */
export const defineConfig = (config: Manifest): Manifest => config;

export const isSourceEntry = (
  value: string | ManifestSourceEntry,
): value is ManifestSourceEntry => typeof value === "object";

export const sourceEntryRef = (value: string | ManifestSourceEntry): string =>
  typeof value === "string" ? value : value.ref;
