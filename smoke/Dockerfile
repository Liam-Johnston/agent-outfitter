# Container smoke test for agent-outfitter.
#
# Two stages on purpose. The builder packs the library exactly as `npm publish`
# would, and the runtime stage installs that tarball into an otherwise empty
# image — so the test exercises the *published* package surface (its `exports`
# map, its `files` list, its dependency closure) rather than the source tree it
# was built from. A packaging mistake that only shows up for a consumer is
# precisely the kind of failure a fresh container would hit first.

# ---------------------------------------------------------------------------
FROM oven/bun:1 AS builder
WORKDIR /build

COPY package.json bun.lock tsconfig.json tsconfig.build.json ./
RUN bun install --frozen-lockfile

COPY src ./src
RUN bun run build

# Normalize the filename so the runtime stage does not depend on the version.
RUN mkdir -p /pkg && bun pm pack --destination /pkg && mv /pkg/*.tgz /pkg/agent-outfitter.tgz

# ---------------------------------------------------------------------------
FROM oven/bun:1 AS runtime

# The smoke test configures no install locations, so every path it writes comes
# from the library's defaults: `$HOME/.codex` for Codex, the working directory for
# Claude. Both are steered onto the bind mount by setting HOME and WORKDIR to it —
# which keeps the default resolution logic under test rather than bypassing it
# with arguments. CODEX_HOME is deliberately *not* set; setting it would override
# the default being tested.
#
# XDG_CACHE_HOME is redirected outside the mount, which keeps both
# agent-outfitter's tree cache and giget's tarball cache off the host. Left to
# follow HOME they would land *inside* the mount, persist across runs, and make
# the "cold cache" the test reports a fiction — besides burying the installed tree
# under a cache the reader has to scroll past. Note this is still the default
# resolution path (`$XDG_CACHE_HOME/agent-outfitter`), not an override of it:
# AGENT_OUTFITTER_CACHE_DIR is deliberately left unset.
ENV WORKSPACE=/workspace \
    HOME=/workspace/out \
    INSTRUCTIONS_DIR=/workspace/instructions \
    XDG_CACHE_HOME=/workspace/.cache

WORKDIR /workspace

COPY --from=builder /pkg/agent-outfitter.tgz /tmp/agent-outfitter.tgz
RUN bun init -y >/dev/null 2>&1 && bun add /tmp/agent-outfitter.tgz && rm /tmp/agent-outfitter.tgz

COPY smoke/app ./app
COPY smoke/instructions ./instructions

# Present so the image runs standalone; a bind mount takes its place when there
# is one. The application clears and populates it either way.
#
# Both directories are made group- and world-writable because the container is
# run as the *host* user's uid/gid, so that files landing in the bind mount are
# owned by whoever invoked it. On Docker Desktop the ownership is remapped and
# this would not be needed, but on Linux — a CI runner — it is: without it the
# output is root-owned and the runner cannot read it into an artifact or delete
# it afterwards. An arbitrary uid has no entry in /etc/passwd, hence permissive
# modes rather than a chown to some specific user.
RUN mkdir -p /workspace/out /workspace/.cache \
    && chmod 1777 /workspace/out /workspace/.cache

# Both HOME and the working directory, so the Codex and Claude defaults each
# resolve onto the mount without either being passed a path.
WORKDIR /workspace/out

ENTRYPOINT ["bun", "run", "/workspace/app/setup.ts"]
