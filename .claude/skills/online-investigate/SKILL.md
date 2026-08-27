---
name: online-investigate
description: "Investigates mappings, errors, and behavior between the BC/AL solution and the online department's C# microservices. Use when asked questions like: 'In Rabobank, which value maps to CrdtDbit?', 'What HTTP code does online return when...?', 'How does online map payment status?'. Triggers on: online, investigate, mapping, bank service, microservice, C# side, online side."
---

# Online Investigator

Investigate questions about field mappings, error handling, and behavior between the Continia Banking AL codebase and the online C# microservices.

## Orchestration Flow

```
1. Parse question → extract bank, term, type, direction
2. Ensure online repo is cloned/updated locally
3. Dispatch agents in parallel
4. Synthesize results into a clear answer
```

## Step 0: Resolve Repo Paths

Before accessing external repos, resolve their paths from the repo-paths config:

1. Run `echo $REPO_PATHS_FILE` via Bash
2. If non-empty, read that file with the Read tool
3. If empty/unset, read `.claude/repo-paths.json` with the Read tool
4. Parse the JSON — use the `online-repos` value as the base directory for all online repo clones

Store the resolved path as `ONLINE_REPOS_PATH` for use in subsequent steps.

## Step 1: Parse the Question

Extract from the user's question:

| Parameter | Description | Example |
|-----------|-------------|---------|
| **bank** | Bank/provider name | "Rabobank", "AccessPay", "DanskeBank" |
| **term** | Field, concept, or feature | "CrdtDbit", "payment status", "account statements" |
| **type** | Question category | `mapping` / `error` / `endpoint` / `behavior` / `general` |
| **direction** | Data flow direction | `outbound` (BC→bank) / `inbound` (bank→BC) / `both` |
| **recent** | Is this about recent changes? | true if keywords: "changed", "broke", "recently", "used to work", "different" |

**Type detection heuristics:**
- "maps to", "what value", "which field" → `mapping`
- "HTTP code", "error", "what happens when", "returns when" → `error`
- "endpoint", "route", "API", "URL" → `endpoint`
- "how does", "what does", "when does" → `behavior`

## Step 2: Ensure Repo is Cloned

1. Read the repo cache: `.claude/skills/online-investigate/data/repo-cache.json`
2. Look up the bank name (case-insensitive) in `banks` map, check `aliases` for short names
3. Construct the local path: `{ONLINE_REPOS_PATH}/{repo-name-with-%20-for-spaces}`
4. Run the clone/pull script:

```bash
bash .claude/skills/online-investigate/scripts/ensure-repo.sh "{full-repo-name}"
```

5. Also ensure SDK is available:

```bash
bash .claude/skills/online-investigate/scripts/ensure-repo.sh "Online - Continia.Online.Banking.SDK.Web"
```

**If the bank name isn't in the cache**, use MCP `mcp__azureDevOps__list_repositories` to search, then update the cache.

## Step 2.5: Read Relevant Reference Docs

Before dispatching agents, read the reference docs that give agents baseline knowledge. This eliminates redundant exploration of well-known architecture.

| Doc | When to Read | Key Content |
|---|---|---|
| `docs/architecture-overview.md` | Always | Request flow, controller patterns, SDK components, error model |
| `docs/controller-routing-matrix.md` | For `error` or `endpoint` questions | Bank x FileType handler matrix, known bugs |
| `docs/al-to-online-routing.md` | For `mapping` or `behavior` questions involving routing | URL construction chain, Conversion parameter bug |
| `docs/csharp-patterns.md` | Always | Repo structure patterns, SDK details, JSON serialization |

Include relevant doc contents in agent prompts (see agent dispatch below).

## Step 3: Dispatch Agents

Launch agents using the Task tool with `subagent_type: "general-purpose"`. Read the agent prompt files and include their instructions in the task prompt.

### Always dispatch: Online Tracer (Agent 2)

Read `.claude/skills/online-investigate/agents/online-tracer.md` for the full agent prompt.

```
Task prompt:
[Include online-tracer.md content]

BASELINE KNOWLEDGE (read before searching):
First read these reference docs for baseline understanding:
- .claude/skills/online-investigate/docs/architecture-overview.md — request flow, controller patterns, error model
- .claude/skills/online-investigate/docs/controller-routing-matrix.md — which bank handles which file type
- .claude/skills/online-investigate/docs/csharp-patterns.md — repo structure, SDK details, JSON serialization

Use this knowledge to skip basic architecture discovery and focus on the specific question.

INPUTS:
- REPO_PATH: {local path to online repo}
- SDK_PATH: {ONLINE_REPOS_PATH}/Online%20-%20Continia.Online.Banking.SDK.Web
- SEARCH_TERM: {term}
- QUESTION_TYPE: {type}
- DIRECTION: {direction}
```

### When tracing full chain: AL Tracer (Agent 1) — in parallel

Read `.claude/skills/online-investigate/agents/al-tracer.md` for the full agent prompt.

Dispatch when: question type is `mapping` or `behavior`, and we need to understand the AL-side origin/consumption of the value.

```
Task prompt:
[Include al-tracer.md content]

BASELINE KNOWLEDGE (read before searching):
First read this reference doc for the URL routing chain:
- .claude/skills/online-investigate/docs/al-to-online-routing.md — URL template system, ICommunicationTypeSpecificUrlValue implementations, entry points, Conversion parameter bug

Use this knowledge to skip basic routing discovery and focus on the specific field/value trace.

INPUTS:
- SEARCH_TERM: {term}
- DIRECTION: {direction}
- AL_BASE: {cwd — the target repo}
```

### When investigating changes: Recent Changes (Agent 3) — in parallel

Read `.claude/skills/online-investigate/agents/recent-changes.md` for the full agent prompt.

Dispatch when: `recent` flag is true.

```
Task prompt:
[Include recent-changes.md content]

INPUTS:
- REPO_PATH: {local path to online repo}
- SEARCH_TERM: {term}
- DAYS_BACK: 30
- REPO_TYPE: online
```

Optionally also dispatch for the AL repo if the change might span both sides.

## Step 4: Synthesize Results

Combine agent findings into a clear, structured answer:

```markdown
## Answer

[Direct 2-3 sentence answer to the question]

## Full Trace

### AL Side (BC)
[From AL Tracer: field name, table, JSON key, how value is built]

### Online Side (C# Microservice)
[From Online Tracer: repo type, files, mapping chain, code snippets]

### Recent Changes (if applicable)
[From Recent Changes: what changed, when, by whom]

## Key Files
- AL: `path/to/file.al:line` - description
- C#: `path/to/file.cs:line` - description

## Notes
- [Any caveats: delegation to Conversion Service, multiple possible mappings, etc.]
```

## Reference: Repo Cache Location

```
.claude/skills/online-investigate/data/repo-cache.json
```

Structure:
- `banks`: maps lowercase bank name → full Azure DevOps repo name
- `aliases`: maps short names/abbreviations → bank key
- `infrastructure`: shared repos (SDK, ConversionService, etc.)

## Reference: Clone Location

All online repos are cloned to: `{ONLINE_REPOS_PATH}/{url-encoded-repo-name}`

URL template: `https://continia-software@dev.azure.com/continia-software/Continia%20Software/_git/{encoded-name}`
