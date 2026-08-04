/** Platform cache location. */

import { homedir, platform } from "node:os";
import { join } from "node:path";

export const defaultCacheDir = (): string => {
  const override = process.env.SKILLSMITH_CACHE_DIR;
  if (override) return override;

  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Caches", "skillsmith");
    case "win32":
      return join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "skillsmith",
        "Cache",
      );
    default:
      return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "skillsmith");
  }
};
