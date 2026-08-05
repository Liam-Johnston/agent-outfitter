/**
 * Source providers.
 *
 * A provider turns a `PrimitiveSource` into (a) an immutable revision identifier
 * and (b) a local directory holding that revision's tree. Everything above this
 * layer (discovery, hashing, policy, targets) is source-agnostic, so adding
 * an artifact store or a corporate SCM means implementing two methods.
 */

import { SourceResolutionError } from "../errors.js";
import { fetchRepoTree, resolveCommit, type FetchContext } from "../fetch.js";
import { pathExists } from "../fsutil.js";
import type { PrimitiveSource } from "../types.js";

export type ProviderContext = FetchContext;

export interface SourceProvider {
  readonly name: string;
  /** Whether this provider handles the given source. */
  supports(source: PrimitiveSource): boolean;
  /**
   * Pin the source to an immutable revision (a commit SHA for git). Return `""`
   * for sources with no revision concept, such as a working-copy directory.
   */
  resolveRevision(source: PrimitiveSource, ctx: ProviderContext): Promise<string>;
  /** Produce a local directory containing the source tree at `revision`. */
  materializeTree(source: PrimitiveSource, revision: string, ctx: ProviderContext): Promise<string>;
}

export const gitSourceProvider: SourceProvider = {
  name: "git",
  supports: (source) => source.type === "git",
  resolveRevision: (source, ctx) => resolveCommit(source, ctx),
  materializeTree: (source, revision, ctx) => fetchRepoTree(source, revision, ctx),
};

export const localSourceProvider: SourceProvider = {
  name: "local",
  supports: (source) => source.type === "local",
  resolveRevision: async () => "",
  materializeTree: async (source) => {
    if (source.type !== "local") throw new SourceResolutionError("Not a local source.");
    // A file is legitimate here: an instruction fragment is one file, whereas a
    // skill is a folder. Which one is required is the caller's business.
    if (!(await pathExists(source.path))) {
      throw new SourceResolutionError(`Local source path ${source.path} does not exist.`, {
        path: source.path,
      });
    }
    return source.path;
  },
};

export const builtinSourceProviders: SourceProvider[] = [gitSourceProvider, localSourceProvider];

/**
 * Pick a provider for a source. User-supplied providers are consulted first so
 * they can override a built-in for a specific host.
 */
export const selectProvider = (
  source: PrimitiveSource,
  extra: readonly SourceProvider[] = [],
): SourceProvider => {
  for (const provider of [...extra, ...builtinSourceProviders]) {
    if (provider.supports(source)) return provider;
  }
  throw new SourceResolutionError(
    `No source provider handles a source of type "${source.type}". ` +
      `Register one via the manager's "sources" option.`,
    { source },
  );
};
