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
COPY .tools/continia-linux /usr/local/bin/continia
RUN chmod +x /usr/local/bin/continia

# Install dependencies as root before switching user
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy application source (includes .claude/ — those skills are symlinked
# into each per-WI worktree at runtime; see src/services/skill-wiring.ts)
COPY . .

# Create non-root user — Claude Code refuses --dangerously-skip-permissions as root
RUN useradd -m -s /bin/bash claude && \
    chown -R claude:claude /app && \
    mkdir -p /repos && \
    mkdir -p /tmp && chmod 1777 /tmp

# The pipeline runs as `claude`, but `docker compose exec` lands as root (this
# image keeps USER root so the entrypoint can chown mounts before dropping
# privileges). Git's dubious-ownership guard then rejects operator commands like
# `exec ... reset-state`, whose `git worktree remove` fails silently-ish and
# leaves stale state behind. The guard protects multi-user hosts; this container
# is single-purpose with only our own mounted repos, so waive it system-wide.
RUN git config --system --add safe.directory '*'

# Install Claude Code CLI as the claude user
USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash
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
