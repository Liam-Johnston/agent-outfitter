---
"agent-outfitter": patch
---

Share one fetch between concurrent callers wanting the same repo tree, and stop a corrupt
archive from wedging the cache.

A manifest selecting several skills from one repository is several entries in the lockfile,
and `sync()` resolves them through `mapLimit`, concurrently. Every entry naming the same
commit resolved to the same cache destination and, one layer down, to the same giget tarball
path, so each task downloaded onto a single file at the same time. What came out was an
archive of exactly the right length whose middle was interleaved bytes, and the run died with
a decode error naming whichever skill lost the race. Only cold caches were affected, which is
to say containers: a warm tree short-circuits before any of this. `fetchRepoTree` now joins an
in-flight fetch for the same destination instead of starting a second one.

A decode failure is also retryable now, where it was previously fatal on the first attempt.
Because giget reuses a cached tarball whose etag still matches, the retry first deletes the
archive that would not decode, otherwise a single bad download leaves a cache directory that
fails identically forever.
