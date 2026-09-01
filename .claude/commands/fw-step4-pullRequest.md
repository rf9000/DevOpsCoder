---
description: Generate the commit/PR message (title + bullets) from the current changes in a fixed output format
runInPlanMode: false
---

# Generate Commit / PR Message

Produces the single message that is used **both** as the git commit message and as the PR title + description. It is the only place where that message is generated — callers never build or reword it themselves.

**Callers:**
- `fw-start.md` STEP 4 (Steps 1–2 "Generate Commit Message") — before branch creation and commit
- `fw-create-pr.md` Step 3 — when invoked standalone with no message in context

## Usage

```bash
/FinishWork:fw-step4-pullRequest
```

No arguments. The change source is chosen deterministically from repository state (Step 1).

## Output Contract (exact)

This command's own output ends with the block below — no commentary after it, because callers parse it and the shape is fixed. **It is not a stopping point for the workflow.** This command never asks the user anything and never ends the turn: as soon as the block is printed, control returns to the caller, which continues with its next step in the same turn (`fw-start.md` → Step 3 config check and question; `fw-create-pr.md` → Step 3 parsing). Do NOT wait for user input after printing the block.

```
### Commit Message (exactly as it will appear):

{title}

- {bullet 1}
- {bullet 2}
- {bullet 3}
```

Rules that make the block parseable:
- Exactly one blank line between the header, the title and the bullet list.
- Title is one line — no trailing period, no prefix like `feat:`, no work item number.
- Every body line starts with `- ` (hyphen + space). No nested bullets, no numbered lists, no paragraphs.
- **No attribution.** Never include `Co-Authored-By`, "Claude", "Claude Code" or any tool name. The attribution line is added by the commit step in `fw-start.md` only, never by this command, so the displayed block is exactly what ends up in the PR description.
- **No credentials or environment details.** Never include URLs, user names, passwords or environment names. The test-environment block travels separately (`fw-start.md` Step 3.6 → `fw-create-pr.md` Step 3.5).

---

## Step 1: Pick the Change Source

Evaluate in this order and use the **first** that applies. Do not mix sources.

1. **Staged changes** — `git diff --cached --stat` is non-empty → analyze the staged diff (`git diff --cached`). This is the normal `fw-start` case.
2. **Commits ahead of main** — nothing is staged but `git log main..HEAD --oneline` is non-empty (the normal standalone `fw-create-pr` case):
   - If `git log -1 --pretty=%B` already has the output shape (first line = title, then `- ` bullets), **reuse it verbatim** minus any `Co-Authored-By`/attribution lines. That message was produced by this command earlier in the flow; regenerating would make the PR text drift from the commit.
   - Otherwise analyze `git diff main...HEAD`.
3. **Neither** → stop with:
   ```markdown
   ## Error: Nothing to Describe

   There are no staged changes and no commits ahead of main. Stage your changes (`git add`) or commit them, then run this command again.
   ```

State the chosen source in one line before analyzing (e.g. `Source: staged changes (7 files)`), so the user can see which diff the message describes.

## Step 2: Analyze the Changes

Run, for the chosen source:
```bash
git branch --show-current
git status --short
git diff --cached --stat        # or: git diff main...HEAD --stat
git diff --cached               # or: git diff main...HEAD
```

Read the whole diff. Group hunks by the logical change they belong to (one feature, one fix, one refactor), not by file. Identify for each group what changed and why it matters to a user or to the product.

## Step 3: Write the Title

- 50–70 characters.
- Starts with an imperative verb: `Add`, `Fix`, `Update`, `Remove`, `Refactor`, `Keep`, `Show`, `Avoid`, ...
- Describes the business outcome, not the mechanics (`Keep Request Header Log responsive with a 15-minute access cache`, not `Add cache codeunit`).
- If the changes serve several unrelated goals, title the dominant one; the others get bullets. Do not join goals with "and ... and".

## Step 4: Write the Bullets

- 2–6 bullets. One per logical change group from Step 2; merge trivial follow-on edits into the bullet they belong to.
- Each starts with a past-tense action word: `Added`, `Fixed`, `Updated`, `Removed`, `Refactored`, `Replaced`, `Moved`.
- Specific but one line each; use AL/Business Central terminology (table, page, codeunit, event, enum, job queue, upgrade codeunit) and object names where they help the reader.
- Mention tests when they were added or changed (`Added unit tests for ...`).
- Never list files or line numbers; never describe formatting-only churn.

## Step 5: Validate Before Printing

Check every item; fix the message rather than printing a violation:

- [ ] Title length is 50–70 characters and has no trailing period
- [ ] Every body line starts with `- `
- [ ] No line contains `Co-Authored-By`, `Claude` or any tool/model name
- [ ] No line contains `Password:`, `Username:`, `http://`, `https://` or an environment name
- [ ] Bullets describe all change groups found in Step 2 (nothing significant omitted, nothing invented)

## Step 6: Print the Block and Hand Back

Print the Output Contract block exactly. No commentary after it — callers treat everything after the header as the message.

Then **immediately resume the calling workflow** in the same turn. Invoked from `fw-start`, the block you just printed already satisfies its Step 3 "display the commit message" requirement — do not print it a second time; go straight on to the Step 3 config check (`skipQuestions.step4_createBranch`) and, unless skipped, ask the "Would you like to create a branch and commit with this message?" question. Ending the turn here leaves the user with a message and no branch, commit or PR.

**Example:**

```
### Commit Message (exactly as it will appear):

Store and download EBICS initialization letter PDF from BanksAPI

- Added PDF blob field to Bank table to store initialization letters
- Added SavePDFInFileArchive procedure to extract and decode PDF from BanksAPI response
- Added ModifyBank codeunit for background Bank record updates with isolated permissions
```
