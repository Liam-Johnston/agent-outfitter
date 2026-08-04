import { describe, expect, test } from "bun:test";

import { SourceResolutionError } from "../src/errors.js";
import {
  describeSource,
  normalizeGitUrl,
  normalizeRef,
  parseRefString,
  providerForSource,
  sourceHost,
  sourceKey,
  sourceOwner,
} from "../src/refs.js";

describe("parseRefString", () => {
  test("parses provider:owner/repo", () => {
    const { source } = parseRefString("github:acme/agent-skills");
    expect(source).toEqual({
      type: "git",
      url: "https://github.com/acme/agent-skills.git",
      provider: "github",
    });
  });

  test("parses subdir and ref", () => {
    const { source } = parseRefString("github:anthropics/skills/skills/pdf#v1.4.0");
    expect(source).toMatchObject({
      type: "git",
      url: "https://github.com/anthropics/skills.git",
      subdir: "skills/pdf",
      ref: "v1.4.0",
    });
  });

  test("supports the gh alias and other hosts", () => {
    expect(parseRefString("gh:a/b").source).toMatchObject({ provider: "github" });
    expect(parseRefString("gitlab:a/b").source).toMatchObject({
      url: "https://gitlab.com/a/b.git",
      provider: "gitlab",
    });
    expect(parseRefString("bitbucket:a/b").source).toMatchObject({
      url: "https://bitbucket.org/a/b.git",
      provider: "bitbucket",
    });
  });

  test("parses raw git URLs, with and without the git: scheme", () => {
    expect(parseRefString("git:https://example.com/a/b.git#main").source).toMatchObject({
      type: "git",
      url: "https://example.com/a/b.git",
      ref: "main",
      provider: "git",
    });
    expect(parseRefString("https://github.com/a/b").source).toMatchObject({
      url: "https://github.com/a/b.git",
      provider: "github",
    });
  });

  test("resolves local paths against the given root", () => {
    expect(parseRefString("local:./skills", { root: "/w" }).source).toEqual({
      type: "local",
      path: "/w/skills",
    });
    expect(parseRefString("./skills", { root: "/w" }).source).toEqual({
      type: "local",
      path: "/w/skills",
    });
    expect(parseRefString("/abs/skills", { root: "/w" }).source).toEqual({
      type: "local",
      path: "/abs/skills",
    });
  });

  test("attaches auth without leaking it into the description", () => {
    const { source } = parseRefString("github:acme/private", {
      auth: { env: "SKILLS_TOKEN" },
    });
    expect(source).toMatchObject({ auth: { env: "SKILLS_TOKEN" } });
    expect(describeSource(source)).toBe("github:acme/private");
  });

  test("rejects unknown providers and incomplete paths", () => {
    expect(() => parseRefString("npm:some-package")).toThrow(SourceResolutionError);
    expect(() => parseRefString("github:acme")).toThrow(SourceResolutionError);
    expect(() => parseRefString("")).toThrow(SourceResolutionError);
  });
});

describe("normalizeGitUrl", () => {
  test("normalizes scp-style and git+ URLs", () => {
    expect(normalizeGitUrl("git@github.com:acme/repo.git")).toBe(
      "https://github.com/acme/repo.git",
    );
    expect(normalizeGitUrl("git+https://github.com/acme/repo")).toBe(
      "https://github.com/acme/repo.git",
    );
    expect(normalizeGitUrl("ssh://git@example.com/a/b.git")).toBe("https://example.com/a/b.git");
  });
});

describe("source introspection", () => {
  const source = parseRefString("github:acme/agent-skills#v1").source;

  test("extracts host, owner, provider", () => {
    expect(sourceHost(source)).toBe("github.com");
    expect(sourceOwner(source)).toBe("acme");
    expect(providerForSource(source)).toBe("github");
  });

  test("keys ignore subdir but include the ref", () => {
    const a = parseRefString("github:acme/repo/skills/x#v1").source;
    const b = parseRefString("github:acme/repo/skills/y#v1").source;
    const c = parseRefString("github:acme/repo/skills/y#v2").source;
    expect(sourceKey(a)).toBe(sourceKey(b));
    expect(sourceKey(b)).not.toBe(sourceKey(c));
  });

  test("infers the provider from a self-hosted host", () => {
    expect(providerForSource(parseRefString("git:https://git.acme.io/a/b.git").source)).toBe(
      "git",
    );
  });
});

describe("normalizeRef", () => {
  test("coerces select to an array and drops empties", () => {
    const source = parseRefString("github:a/b").source;
    expect(normalizeRef({ source, select: "one" }).select).toEqual(["one"]);
    expect(normalizeRef({ source, select: [] }).select).toBeUndefined();
    expect(normalizeRef({ source }).select).toBeUndefined();
  });
});
