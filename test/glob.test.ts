import { describe, expect, test } from "bun:test";

import { matchesAny, unmatchedPatterns } from "../src/glob.js";

describe("matchesAny", () => {
  test("an empty pattern list matches everything", () => {
    expect(matchesAny("anything", undefined)).toBe(true);
    expect(matchesAny("anything", [])).toBe(true);
  });

  test("matches literals and star patterns", () => {
    expect(matchesAny("csv-insights", ["csv-insights"])).toBe(true);
    expect(matchesAny("csv-insights", ["csv-*"])).toBe(true);
    expect(matchesAny("csv-insights", ["*-insights"])).toBe(true);
    expect(matchesAny("csv-insights", ["pdf-*"])).toBe(false);
  });

  test("a single star does not cross a slash; double star does", () => {
    expect(matchesAny("a/b", ["a/*"])).toBe(true);
    expect(matchesAny("a/b/c", ["a/*"])).toBe(false);
    expect(matchesAny("a/b/c", ["a/**"])).toBe(true);
    expect(matchesAny("a/b", ["**/b"])).toBe(true);
    expect(matchesAny("b", ["**/b"])).toBe(true);
  });

  test("supports ? and brace alternation", () => {
    expect(matchesAny("pdf", ["pd?"])).toBe(true);
    expect(matchesAny("pdf", ["{pdf,csv}"])).toBe(true);
    expect(matchesAny("xls", ["{pdf,csv}"])).toBe(false);
  });

  test("treats regex metacharacters literally", () => {
    expect(matchesAny("a.b", ["a.b"])).toBe(true);
    expect(matchesAny("axb", ["a.b"])).toBe(false);
    expect(matchesAny("a+b", ["a+b"])).toBe(true);
  });
});

describe("unmatchedPatterns", () => {
  test("reports only patterns that matched nothing", () => {
    expect(unmatchedPatterns(["a", "b"], ["a", "c", "b*"])).toEqual(["c"]);
    expect(unmatchedPatterns(["a"], undefined)).toEqual([]);
  });
});
