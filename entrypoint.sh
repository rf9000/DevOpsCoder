#!/bin/bash
set -e

# Run as root first to fix volume permissions; bind-mounted dirs are owned by the host uid.
if [ "$(id -u)" = "0" ]; then
  chown -R claude:claude /app/.state
  chown -R claude:claude /home/claude/.claude 2>/dev/null || true

  # Verify TARGET_REPO_PATH points at a git repo
  if [ -n "$TARGET_REPO_PATH" ] && [ ! -d "$TARGET_REPO_PATH/.git" ]; then
    echo "ERROR: Target repo not found at $TARGET_REPO_PATH"
    echo "Mount the repo from the host, e.g.: ~/repos/<repo-name>:$TARGET_REPO_PATH"
    exit 1
  fi

  # Verify WORKTREE_BASE exists (it must be writable for git worktree add to work in later plans)
  if [ -n "$WORKTREE_BASE" ] && [ ! -d "$WORKTREE_BASE" ]; then
    echo "ERROR: Worktree base not found at $WORKTREE_BASE"
    echo "Mount a writable directory, e.g.: ~/repos/.worktrees:$WORKTREE_BASE"
    exit 1
  fi

  # Fix ownership of the worktree base explicitly. The /repos/*/ glob below does
  # NOT match dot-directories, so the conventional /repos/.worktrees is skipped
  # by it and `git worktree add` then dies with "could not create leading
  # directories of '<base>/<wi>/.git': Permission denied".
  # Non-recursive on purpose: worktrees are created by the claude user itself,
  # and a recursive chown over multi-GB AL checkouts on every start is slow.
  if [ -n "$WORKTREE_BASE" ]; then
    chown claude:claude "$WORKTREE_BASE" || \
      echo "WARNING: could not chown $WORKTREE_BASE — worktree-setup may fail"
  fi

  # Fix ownership of writable repo mounts (skip read-only mounts to avoid slow no-op chowns)
  for dir in /repos/*/; do
    [ ! -d "$dir" ] && continue
    if touch "$dir/.chown-test" 2>/dev/null; then
      rm -f "$dir/.chown-test"
      chown -R claude:claude "$dir"
    fi
  done

  # Generate /app/repo-paths.json from /repos/* (excluding the target repo itself)
  REPO_PATHS_FILE=""
  if [ -d "/repos" ]; then
    TARGET_DIR=$(basename "$TARGET_REPO_PATH")
    JSON="{"
    FIRST=true
    for dir in /repos/*/; do
      [ ! -d "$dir" ] && continue
      name=$(basename "$dir")
      [ "$name" = "$TARGET_DIR" ] && continue
      $FIRST && FIRST=false || JSON="$JSON,"
      JSON="$JSON\"$name\":\"${dir%/}\""
    done
    JSON="$JSON}"
    echo "$JSON" > /app/repo-paths.json
    chown claude:claude /app/repo-paths.json
    REPO_PATHS_FILE=/app/repo-paths.json
    echo "Generated repo-paths.json: $JSON"
  fi

  exec su claude -c "export HOME=/home/claude REPO_PATHS_FILE=$REPO_PATHS_FILE && cd /app && bun run start"
fi

exec bun run start
