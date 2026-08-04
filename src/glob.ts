/**
 * Minimal glob matching for skill selection.
 *
 * Selection operates on flat skill names and shallow relative paths, so full
 * minimatch semantics would be overkill. Supported: `*` (any run of non-slash
 * characters), `**` (any run including slashes), `?` (one non-slash character),
 * and `{a,b}` alternation.
 */

const escapeRegExp = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

export const globToRegExp = (pattern: string): RegExp => {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` should also match zero path segments.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
      } else {
        const alts = pattern.slice(i + 1, end).split(",");
        out += `(?:${alts.map((a) => escapeRegExp(a)).join("|")})`;
        i = end;
      }
    } else {
      out += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${out}$`);
};

/** True when `value` matches any pattern. An empty pattern list matches everything. */
export const matchesAny = (value: string, patterns: readonly string[] | undefined): boolean => {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => globToRegExp(p).test(value));
};

/** Patterns that matched nothing — used to turn typos into `SkillNotFoundError`s. */
export const unmatchedPatterns = (
  values: readonly string[],
  patterns: readonly string[] | undefined,
): string[] => {
  if (!patterns || patterns.length === 0) return [];
  return patterns.filter((p) => {
    const re = globToRegExp(p);
    return !values.some((v) => re.test(v));
  });
};
