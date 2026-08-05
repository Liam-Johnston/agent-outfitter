/**
 * Retry behaviour for commit resolution.
 *
 * This matters most for a single-task container: the cache is cold by
 * definition, so every fetch is live and a transient 502 has no warm tree to
 * fall back on — it takes the whole task down. The tests below therefore pin
 * both halves of the policy: that a "not now" status is retried, and that a
 * "not ever" status is *not*, since retrying it only delays a clear error.
 *
 * `globalThis.fetch` is stubbed rather than a server started, so the retry
 * decision is observed directly as a request count.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { AuthError, SourceResolutionError } from "../src/errors.js";
import { resolveCommit } from "../src/fetch.js";
import type { PrimitiveSource } from "../src/types.js";

const source: PrimitiveSource = {
  type: "git",
  url: "https://github.com/acme/skills.git",
  ref: "v1.0.0",
};

const COMMIT = "e24616c9f0a1b2c3d4e5f60718293a4b5c6d7e8f";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Stub {
  calls: string[];
  install(handler: (url: string, n: number) => Response | Promise<Response>): void;
}

const stubFetch = (): Stub => {
  const calls: string[] = [];
  return {
    calls,
    install(handler) {
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        return handler(url, calls.length);
      }) as typeof fetch;
    },
  };
};

/** Cache dir is never touched by commit resolution, but the type requires one. */
const ctx = (maxAttempts: number) => ({ cacheDir: "/nonexistent", maxAttempts });

describe("resolveCommit retries", () => {
  test("retries a 503 and succeeds on a later attempt", async () => {
    const stub = stubFetch();
    stub.install((_url, n) =>
      n === 1
        ? new Response("upstream unavailable", { status: 503 })
        : new Response(COMMIT, { status: 200 }),
    );

    expect(await resolveCommit(source, ctx(3))).toBe(COMMIT);
    expect(stub.calls).toHaveLength(2);
  });

  test("retries a 429, so a rate limit does not fail the install", async () => {
    const stub = stubFetch();
    stub.install((_url, n) =>
      n < 3 ? new Response("slow down", { status: 429 }) : new Response(COMMIT, { status: 200 }),
    );

    expect(await resolveCommit(source, ctx(3))).toBe(COMMIT);
    expect(stub.calls).toHaveLength(3);
  }, 15_000);

  test("retries a dropped connection", async () => {
    const stub = stubFetch();
    stub.install((_url, n) => {
      if (n === 1) {
        const error = new Error("fetch failed") as Error & { cause?: { code: string } };
        error.cause = { code: "ECONNRESET" };
        throw error;
      }
      return new Response(COMMIT, { status: 200 });
    });

    expect(await resolveCommit(source, ctx(3))).toBe(COMMIT);
    expect(stub.calls).toHaveLength(2);
  });

  test("does not retry a 404 — the ref is wrong and will stay wrong", async () => {
    const stub = stubFetch();
    stub.install(() => new Response("no such ref", { status: 404 }));

    await expect(resolveCommit(source, ctx(3))).rejects.toBeInstanceOf(SourceResolutionError);
    // One REST attempt, one smart-HTTP fallback. No repeats of either.
    expect(stub.calls).toHaveLength(2);
  });

  test("does not retry a 401 — a bad token will stay bad", async () => {
    const stub = stubFetch();
    stub.install(() => new Response("denied", { status: 401 }));

    await expect(resolveCommit(source, ctx(3))).rejects.toBeInstanceOf(AuthError);
    expect(stub.calls).toHaveLength(2);
  });

  test("gives up after the budget and reports the underlying failure", async () => {
    const stub = stubFetch();
    stub.install(() => new Response("bad gateway", { status: 502 }));

    await expect(resolveCommit(source, ctx(2))).rejects.toBeInstanceOf(SourceResolutionError);
    // Two attempts at the REST endpoint, then two at the smart-HTTP fallback.
    expect(stub.calls).toHaveLength(4);
  }, 15_000);

  test("spends no request at all on a ref that is already a SHA", async () => {
    const stub = stubFetch();
    stub.install(() => new Response("should not be called", { status: 500 }));

    expect(await resolveCommit({ ...source, ref: COMMIT }, ctx(3))).toBe(COMMIT);
    expect(stub.calls).toHaveLength(0);
  });

  test("reports each retry through onRetry", async () => {
    const stub = stubFetch();
    stub.install((_url, n) =>
      n === 1 ? new Response("", { status: 500 }) : new Response(COMMIT, { status: 200 }),
    );

    const retries: { attempt: number; of: number; delayMs: number }[] = [];
    await resolveCommit(source, {
      cacheDir: "/nonexistent",
      maxAttempts: 3,
      onRetry: ({ attempt, of, delayMs }) => retries.push({ attempt, of, delayMs }),
    });

    expect(retries).toHaveLength(1);
    expect(retries[0]!).toMatchObject({ attempt: 1, of: 3 });
    // Jittered, but always inside the first backoff window.
    expect(retries[0]!.delayMs).toBeGreaterThan(0);
    expect(retries[0]!.delayMs).toBeLessThanOrEqual(250);
  });

  // Each iteration actually sleeps for its backoff, so this is the one test here
  // whose wall time is bounded by the policy under test rather than by the stub.
  // The explicit timeout keeps a loaded machine from turning that into a failure.
  test(
    "backs off with jitter, so concurrent sources do not retry in lockstep",
    async () => {
      const delays: number[] = [];
      for (let i = 0; i < 6; i++) {
        const stub = stubFetch();
        stub.install((_url, n) =>
          n === 1 ? new Response("", { status: 503 }) : new Response(COMMIT, { status: 200 }),
        );
        await resolveCommit(source, {
          cacheDir: "/nonexistent",
          maxAttempts: 2,
          onRetry: ({ delayMs }) => delays.push(delayMs),
        });
      }
      expect(delays).toHaveLength(6);
      // Full jitter over an identical budget: identical delays every time would
      // mean the burst that caused a rate limit gets faithfully reproduced.
      expect(new Set(delays).size).toBeGreaterThan(1);
      // And every one still inside the first backoff window.
      for (const delay of delays) {
        expect(delay).toBeGreaterThan(0);
        expect(delay).toBeLessThanOrEqual(250);
      }
    },
    30_000,
  );
});
