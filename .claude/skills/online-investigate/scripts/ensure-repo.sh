#!/bin/bash
# ensure-repo.sh - Clone or update an Azure DevOps online banking repo locally
#
# Usage: bash ensure-repo.sh "Online - Continia.Banking.RaboBankISO20022"
# Output: Local path to the repo (last line of stdout)
#
# Clone location: {ONLINE_REPOS_PATH}/{url-encoded-repo-name}
# The base directory is resolved from repo-paths.json (key: "online-repos")
# Azure DevOps URL pattern: https://continia-software@dev.azure.com/continia-software/Continia%20Software/_git/{repo-name}

set -euo pipefail

REPO_NAME="${1:?Usage: ensure-repo.sh <full-repo-name>}"

# Resolve base directory from repo-paths.json
if [ -n "${REPO_PATHS_FILE:-}" ] && [ -f "$REPO_PATHS_FILE" ]; then
  PATHS_FILE="$REPO_PATHS_FILE"
elif [ -f ".claude/repo-paths.json" ]; then
  PATHS_FILE=".claude/repo-paths.json"
else
  echo "ERROR: No repo-paths.json found. Create .claude/repo-paths.json or set REPO_PATHS_FILE." >&2
  exit 1
fi

# Extract online-repos path (simple grep — no jq dependency)
BASE_DIR=$(grep -o '"online-repos"[[:space:]]*:[[:space:]]*"[^"]*"' "$PATHS_FILE" | sed 's/.*: *"//;s/"$//')

# URL-encode the repo name (spaces → %20)
ENCODED_NAME="${REPO_NAME// /%20}"

LOCAL_PATH="${BASE_DIR}/${ENCODED_NAME}"
CLONE_URL="https://continia-software@dev.azure.com/continia-software/Continia%20Software/_git/${ENCODED_NAME}"

mkdir -p "$BASE_DIR"

if [ -d "$LOCAL_PATH/.git" ]; then
    echo "Updating existing clone: ${LOCAL_PATH}" >&2
    cd "$LOCAL_PATH"
    git fetch --quiet origin 2>&1 >&2 || true
    git pull --quiet --ff-only 2>&1 >&2 || echo "Pull failed (diverged?), using existing" >&2
else
    echo "Cloning: ${REPO_NAME}" >&2
    echo "URL: ${CLONE_URL}" >&2
    git clone --quiet --depth 1 "$CLONE_URL" "$LOCAL_PATH" 2>&1 >&2
fi

# Always output the local path as the last line (for script consumers)
echo "$LOCAL_PATH"
