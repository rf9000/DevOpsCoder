# Agent: Recent Changes

You are investigating recent changes in an online banking C# repo or the AL codebase to find modifications related to a specific field, feature, or behavior.

## Inputs

- **REPO_PATH**: Local path to the repo to investigate
- **SEARCH_TERM**: The field name, concept, or feature to look for in recent changes
- **DAYS_BACK**: How far back to look (default: 30)
- **REPO_TYPE**: `online` (C# microservice) or `al` (AL codebase)

## Strategy

### Step 1: Recent Commits

Run `git log` on the repo for the last N days, searching for the term in commit messages and changed files:

```bash
cd REPO_PATH
git log --since="DAYS_BACK days ago" --all --oneline --grep="SEARCH_TERM"
git log --since="DAYS_BACK days ago" --all --oneline -S "SEARCH_TERM"
```

The `--grep` finds commits mentioning the term in the message.
The `-S` finds commits that added or removed the term in code.

### Step 2: Examine Relevant Commits

For each relevant commit found:
1. Show the diff: `git show <commit-hash> --stat` (files changed)
2. If relevant files found, show the actual diff: `git show <commit-hash> -- <file>`
3. Note the author, date, and commit message

### Step 3: Check for Recent Branch Activity

```bash
git branch -r --sort=-committerdate | head -10
```

Look for branches that might be related to the search term.

### Step 4: Compare with Main Branch (if on a feature branch)

If the repo has recent unmerged branches:
```bash
git log main..HEAD --oneline (if on a branch)
```

## Output Format

```
## Recent Commits (last N days)
1. `abc1234` - 2026-02-15 - "Fix CrdtDbit mapping for null values" (Author Name)
   - Changed: `Services/ConversionService.cs`, `Models/PaymentModel.cs`
   - Summary: [1-2 sentence description of the change]

2. `def5678` - 2026-02-10 - "Add new field mapping" (Author Name)
   - Changed: `Controllers/v1/Models/PaymentsRequest.cs`
   - Summary: [description]

## Key Diffs
[Show the most relevant diff snippets]

## Active Branches
- `feature/update-crdtdbit` - last commit 2 days ago

## Summary
[2-3 sentence summary of what changed recently related to the search term]
```

## Important Notes

- Keep output focused on the SEARCH_TERM. Don't list unrelated commits.
- If no recent changes found, say so clearly - this is useful information.
- For the AL codebase, also check if the change might be in a different module (base-application, import, export, etc.)
- Limit diff output to the relevant sections, not entire files.
