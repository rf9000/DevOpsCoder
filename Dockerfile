# syntax=docker/dockerfile:1

# Node.js 22, copied from the official image rather than installed from a
# distro repo. Bun runs this project's own code, but the Agent SDK spawns
# `node` (and npx-launched MCP servers, if configured) — without it agent
# runs fail silently inside the container.
FROM node:22-bookworm-slim AS node

FROM oven/bun:1

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version && npx --version

WORKDIR /app

# git      — target repo + worktree ops
# curl     — Claude Code installer
# libicu   — the self-contained .NET AL compiler dlopens ICU at runtime (never
#            shows in `ldd alc`); resolved by name, not pinned — the oven/bun
#            base has moved Debian releases before and a pinned libicuNN
#            breaks the build.
# libssl3 / libstdc++6 — also for the compiler toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl bash ca-certificates libssl3 libstdc++6 \
    && apt-get install -y --no-install-recommends \
        "$(apt-cache search --names-only '^libicu[0-9]+$' | sort -V | tail -1 | cut -d' ' -f1)" \
    && rm -rf /var/lib/apt/lists/*

# Linux build of the Continia CLI. `.tools/` is gitignored — copy
# .tools/continia-linux into the build context before building (see README
# "VM Deployment"). The build fails fast here if it is missing.
# --chmod on the COPY, not a separate `RUN chmod`: a chmod in its own layer
# stores the 82 MB binary a second time.
COPY --chmod=755 .tools/continia-linux /usr/local/bin/continia

# Create non-root user — Claude Code refuses --dangerously-skip-permissions as root.
# Created before anything lands in /app, and /app is handed over while still
# empty: a `chown -R /app` after the install rewrites every file into a new
# layer and stores node_modules twice (it was a 583 MB layer).
RUN useradd -m -s /bin/bash claude && \
    chown claude:claude /app && \
    mkdir -p /repos && \
    mkdir -p /tmp && chmod 1777 /tmp

# The pipeline runs as `claude`, but `docker compose exec` lands as root (this
# image keeps USER root so the entrypoint can chown mounts before dropping
# privileges). Git's dubious-ownership guard then rejects operator commands like
# `exec ... reset-state`, whose `git worktree remove` fails silently-ish and
# leaves stale state behind. The guard protects multi-user hosts; this container
# is single-purpose with only our own mounted repos, so waive it system-wide.
RUN git config --system --add safe.directory '*'

# Install Claude Code CLI as the claude user. Before the dependency install, so
# a lockfile or source change does not rebuild this 342 MB layer.
USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash

# Install dependencies as claude, so the files are born with the right owner.
# The SDK's platform packages (claude-agent-sdk-linux-x64, -linux-x64-musl) each
# bundle a full Claude Code binary. This image runs the CLI installed above
# through CLAUDE_CODE_EXECUTABLE_PATH, so those copies are dead weight; they go
# in the same RUN, together with Bun's download cache, or the layer keeps them.
COPY --chown=claude:claude package.json bun.lock ./
RUN bun install --frozen-lockfile \
    && find node_modules -maxdepth 3 -type d -name 'claude-agent-sdk-*' -prune -exec rm -rf {} + \
    && bun pm cache rm \
    && test -d node_modules/@anthropic-ai/claude-agent-sdk

# Copy only what runs: src/ (code + prompts), config/ (worktree overlays) and
# .claude/ (skills symlinked into each per-WI worktree at runtime; see
# src/services/skill-wiring.ts). Not `COPY . .`: that also copied
# .tools/continia-linux into /app, a third 82 MB copy of the CLI, plus tests.
COPY --chown=claude:claude tsconfig.json ./
COPY --chown=claude:claude src ./src
COPY --chown=claude:claude config ./config
COPY --chown=claude:claude .claude ./.claude
USER root

ENV PATH="/home/claude/.local/bin:$PATH"

# CONTINIA_AUTO_INSTALL_ALC is deliberately 0: the CLI's auto-installed
# compiler resolves the wrong target-framework path (lib/net10.0 vs the
# shipped lib/net8.0) and extracts alc as mode 644. The compose file
# bind-mounts the host's AL VS Code extension at /opt/al/bin instead.
# CLAUDE_CODE_EXECUTABLE_PATH points the Agent SDK at the CLI installed above.
# Left unset, the SDK probes for its own bundled native binary and — under Bun
# on this glibc base — resolves the *-linux-x64-musl package, then dies with
# "Claude Code native binary not found at .../claude-agent-sdk-linux-x64-musl/claude".
ENV CONTINIA_CLI_PATH=/usr/local/bin/continia \
    CONTINIA_ALC_PATH=/opt/al/bin/linux/alc \
    CONTINIA_AUTO_INSTALL_ALC=0 \
    SKILLS_SOURCE_DIR=/app/.claude \
    CLAUDE_CODE_EXECUTABLE_PATH=/home/claude/.local/bin/claude \
    GIT_TERMINAL_PROMPT=0

# Persist state and Claude auth across restarts
VOLUME /app/.state
VOLUME /home/claude/.claude

COPY --chmod=755 entrypoint.sh /entrypoint.sh

# Start as root; entrypoint fixes volume permissions, then drops to claude user
ENTRYPOINT ["/entrypoint.sh"]
