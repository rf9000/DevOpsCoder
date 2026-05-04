FROM oven/bun:1

WORKDIR /app

# Install git (target repo + worktree ops), curl (Claude Code installer), bash
RUN apt-get update && apt-get install -y git curl bash && rm -rf /var/lib/apt/lists/*

# Install dependencies as root before switching user
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy application source
COPY . .

# Create non-root user — Claude Code refuses --dangerously-skip-permissions as root
RUN useradd -m -s /bin/bash claude && \
    chown -R claude:claude /app && \
    mkdir -p /repos && \
    mkdir -p /tmp && chmod 1777 /tmp

# Install Claude Code CLI as the claude user
USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root

ENV PATH="/home/claude/.local/bin:$PATH"

# Persist state and Claude auth across restarts
VOLUME /app/.state
VOLUME /home/claude/.claude

COPY --chmod=755 entrypoint.sh /entrypoint.sh

# Start as root; entrypoint fixes volume permissions, then drops to claude user
ENTRYPOINT ["/entrypoint.sh"]
