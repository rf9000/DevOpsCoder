# DevopsCoder — Plan 1: Skeleton + Stage Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the DevopsCoder repository as a buildable, testable Bun/TypeScript service with a generic stage-based pipeline orchestrator (Stage interface, PipelineState, runPipeline, agentStage, revisionLoop, checkpoint, per-WI state store). End state: `bun test` green, `bun run typecheck` clean, `docker build` succeeds, and a mock-stage end-to-end test exercises the full orchestrator.

**Architecture:** Mirror the sibling `DevOpsInvestigateWorkItems` repo's layout and conventions (Bun + TypeScript, Zod env config, dependency injection via interfaces, JSON state store, polling watcher pattern). Add a new `src/pipeline/` directory housing the stage abstractions. Per-WI state files (`.state/{workItemId}.json`) replace the sibling's single-file Set-based store, since each work item has its own multi-stage pipeline lifecycle. Real stages (analyzer, coder, test-author, reviewer, draft-pr-creator), the ADO REST client, the worktree manager, and the watcher loop are explicitly **out of scope** for this plan — they land in subsequent plans.

**Tech Stack:** Bun (TypeScript), Zod for validation, `@anthropic-ai/claude-agent-sdk` (declared as a dependency, but not yet wired — `agentStage` is built around an injectable `AgentRunner` interface so tests can mock it). Built-in `bun:test` for tests. Docker via `oven/bun:1` base image with a non-root `claude` user, mirroring the sibling.

**Scope (this plan):** Milestones 1 + 2 of the project briefing. Milestone 1 = project skeleton (package.json, tsconfig, src/ layout, Zod env config, empty Dockerfile + entrypoint.sh). Milestone 2 = Stage abstraction, PipelineState, runPipeline orchestrator, agentStage / revisionLoop / checkpoint factories, state-store.ts, mock-stage E2E test.

**Out of scope (later plans):** ADO REST client, worktree manager, real stages (analyzer/coder/test-author/reviewer/draft-pr-creator), watcher polling loop with concurrency pool, docker-compose integration, the existing 4 agents.

---

## File Structure

Files created or modified by this plan:

| Path | Responsibility |
|------|----------------|
| `package.json` | Bun manifest, scripts, dependencies (zod, claude-agent-sdk) |
| `tsconfig.json` | Bun-native TypeScript config, `@/*` path alias to `src/*` |
| `.gitignore` | Exclude `node_modules/`, `.state/`, `.env`, Claude settings |
| `.dockerignore` | Minimal exclude list for image builds |
| `.env.example` | Public env template documenting all required + optional vars |
| `Dockerfile` | `oven/bun:1` image, non-root `claude` user, Claude Code CLI install, state + auth volumes |
| `entrypoint.sh` | Root-bootstrap that fixes volume permissions, generates `repo-paths.json`, drops to `claude` user |
| `CLAUDE.md` | Repository orientation for Claude Code |
| `PATTERNS.md` | Quick-reference of architectural patterns with file pointers |
| `README.md` | Operational overview (replaces the current 1-line stub) |
| `tests/setup.ts` | Test preload — clears `CLAUDECODE` env var |
| `src/types/index.ts` | Shared types: `AppConfig`, `PipelineState`, `StageHistoryEntry`, `PipelineTerminalError` |
| `src/utils/logger.ts` | Timestamped console logger with optional prefix |
| `src/utils/slug.ts` | `slugify(input, maxLen)` — produces branch-safe slugs from titles |
| `src/config/index.ts` | Zod env schema + `loadConfig(env?)` |
| `src/state/state-store.ts` | `PipelineStateStore` — per-WI JSON load/save/delete/listAll/listResumable |
| `src/pipeline/stage.ts` | `Stage` interface, `PipelineContext`, `AbortFlag`, `PipelinePauseError` |
| `src/pipeline/orchestrator.ts` | `runPipeline()` + `createInitialState()` + `StageNotFoundError` |
| `src/pipeline/agent-stage.ts` | `AgentRunner` interface + `agentStage()` factory |
| `src/services/claude-agent-runner.ts` | Production `AgentRunner` impl wrapping `query()` from `@anthropic-ai/claude-agent-sdk` with JSON extraction + Zod validation |
| `src/pipeline/revision-loop.ts` | `revisionLoop()` factory |
| `src/pipeline/checkpoint.ts` | `checkpoint()` factory |
| `src/cli/index.ts` | Minimal CLI dispatch — `help` and `version` only (real commands land in later plans) |
| `tests/utils/logger.test.ts` | Logger spec |
| `tests/utils/slug.test.ts` | Slugify spec |
| `tests/config/config.test.ts` | Config spec |
| `tests/state/state-store.test.ts` | State-store spec |
| `tests/pipeline/orchestrator.test.ts` | Orchestrator spec |
| `tests/pipeline/agent-stage.test.ts` | agentStage spec |
| `tests/services/claude-agent-runner.test.ts` | `extractJson` pure-helper spec (the SDK call itself is not unit tested, mirroring the template's pattern) |
| `tests/pipeline/revision-loop.test.ts` | revisionLoop spec |
| `tests/pipeline/checkpoint.test.ts` | checkpoint spec |
| `tests/integration/orchestrator-e2e.test.ts` | End-to-end mock-stage pipeline test |

Note: no `bunfig.toml` — the sibling repo doesn't have one and Bun defaults are sufficient.

---

## Conventions used throughout this plan

- **Imports use `.ts` extensions** (`import { foo } from '../utils/logger.ts'`) — required by `verbatimModuleSyntax: true` and `allowImportingTsExtensions: true` in tsconfig.
- **`type` imports use the `type` keyword** (`import type { AppConfig } from '../types/index.ts'`) — required by `verbatimModuleSyntax: true`.
- **Test framework:** `bun:test` with `describe`, `it`/`test`, `expect`, `mock`, `beforeEach`, `afterEach`.
- **Conventional commits:** `feat:`, `test:`, `chore:`, `docs:` prefixes.
- **Run all bash/PowerShell commands from the repo root** (`C:\GeneralDev\DevOpsPullers\DevOpsCoder`).

---

## Task 1: Initialize project skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.dockerignore`
- Create: `.env.example`
- Create: `tests/setup.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "devops-coder",
  "version": "0.1.0",
  "type": "module",
  "module": "src/cli/index.ts",
  "scripts": {
    "start": "bun run src/cli/index.ts watch",
    "once": "bun run src/cli/index.ts run-once",
    "test": "bun test --preload ./tests/setup.ts tests/**/*.test.ts",
    "test:unit": "bun test --preload ./tests/setup.ts tests/config/ tests/state/ tests/pipeline/ tests/utils/",
    "test:integration": "bun test --preload ./tests/setup.ts tests/integration/**/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "latest"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noEmit": true,
    "types": ["bun"],
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

> Note: `"types": ["bun"]` is required so the test preload's `process.env.CLAUDECODE` reference type-checks. `@types/bun` references `bun-types` which references `@types/node`, so listing `bun` here pulls in Bun globals and Node types both. Omitting the field relies on auto-discovery, which is not reliable on `@types/bun` ≥ 1.3.13.

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
coverage/
.env
.env.*.local
.state/
.cache/
.DS_Store
.claude/settings*
.claude/todos*
```

- [ ] **Step 4: Create `.dockerignore`**

```
node_modules/
.git/
.state/
.env
.env.*.local
```

- [ ] **Step 5: Create `.env.example`**

```
# Azure DevOps Configuration (required)
AZURE_DEVOPS_PAT=your-personal-access-token
AZURE_DEVOPS_ORG=your-org-name
AZURE_DEVOPS_PROJECT=your-project-name

# Target repository where DevopsCoder writes branches/PRs (required)
TARGET_REPO_PATH=/repos/continia-banking

# Base directory for per-work-item git worktrees (required)
WORKTREE_BASE=/repos/.worktrees

# Optional: Tag that triggers the implement pipeline (default: agent implement)
# TRIGGER_TAG=agent implement

# Optional: Tag set by the service when revision loop is exhausted (default: agent-blocked)
# BLOCKED_TAG=agent-blocked

# Optional: Tag set by the service when analyzer rejects a work item (default: need-input)
# NEED_INPUT_TAG=need-input

# Optional: Polling interval in minutes (default: 5)
# POLL_INTERVAL_MINUTES=5

# Optional: Max concurrent pipelines (default: 1)
# CONCURRENCY=1

# Optional: Max revision loop iterations before escalating (default: 3)
# MAX_REVISIONS=3

# Optional: Max analyzer reject cycles per WI before need-input lockout (default: 3)
# MAX_REJECT_CYCLES=3

# Optional: Claude model to use (default: claude-opus-4-7)
# CLAUDE_MODEL=claude-opus-4-7

# Optional: State directory (default: .state)
# STATE_DIR=.state

# Optional: Only act on WIs assigned to these people (comma-separated, default: all)
# ASSIGNED_TO_FILTER=Alice Smith,Bob Jones
```

- [ ] **Step 6: Create `tests/setup.ts`**

```typescript
delete process.env.CLAUDECODE;
```

- [ ] **Step 7: Install dependencies**

Run from repo root:

```powershell
bun install
```

Expected: creates `bun.lock` and `node_modules/`. No errors.

- [ ] **Step 8: Verify typecheck on the empty project**

```powershell
bun run typecheck
```

Expected: PASS (no source files yet, so nothing to check, exit 0).

- [ ] **Step 9: Commit**

```powershell
git add package.json tsconfig.json .gitignore .dockerignore .env.example tests/setup.ts bun.lock
git commit -m "chore: initialize DevopsCoder project skeleton"
```

---

## Task 2: Add core shared types

**Files:**
- Create: `src/types/index.ts`

- [ ] **Step 1: Write `src/types/index.ts`**

```typescript
export interface AppConfig {
  org: string;
  orgUrl: string;
  project: string;
  pat: string;
  targetRepoPath: string;
  worktreeBase: string;
  triggerTag: string;
  blockedTag: string;
  needInputTag: string;
  pollIntervalMinutes: number;
  concurrency: number;
  maxRevisions: number;
  maxRejectCycles: number;
  claudeModel: string;
  stateDir: string;
  assignedToFilter: string[];
  dryRun: boolean;
}

export type StageOutcome = 'success' | 'failure' | 'skip' | 'pause';

export interface StageHistoryEntry {
  stage: string;
  startedAt: string;
  endedAt: string;
  outcome: StageOutcome;
  message?: string;
}

export interface PipelineTerminalError {
  stage: string;
  message: string;
  at: string;
}

export interface PipelineState {
  workItemId: number;
  slug: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelled?: boolean;
  terminalError?: PipelineTerminalError;
  currentStage: string | null;
  history: StageHistoryEntry[];
  attempts: Record<string, number>;
  outputs: Record<string, unknown>;
}
```

- [ ] **Step 2: Typecheck**

```powershell
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```powershell
git add src/types/index.ts
git commit -m "feat(types): add AppConfig and PipelineState core types"
```

---

## Task 3: Logger utility

**Files:**
- Create: `src/utils/logger.ts`
- Test: `tests/utils/logger.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/utils/logger.test.ts
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { createLogger } from '../../src/utils/logger.ts';

describe('createLogger', () => {
  let logSpy: ReturnType<typeof mock>;
  let errorSpy: ReturnType<typeof mock>;
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    logSpy = mock(() => {});
    errorSpy = mock(() => {});
    console.log = logSpy as unknown as typeof console.log;
    console.error = errorSpy as unknown as typeof console.error;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  it('info() writes timestamped message to console.log', () => {
    const logger = createLogger();
    logger.info('hello');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const call = logSpy.mock.calls[0]?.[0] as string;
    expect(call).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] hello$/);
  });

  it('info() includes prefix when provided', () => {
    const logger = createLogger('wi-123');
    logger.info('working');
    const call = logSpy.mock.calls[0]?.[0] as string;
    expect(call).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[wi-123\] working$/);
  });

  it('error() writes to console.error and includes Error message', () => {
    const logger = createLogger();
    logger.error('boom', new Error('disk full'));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const call = errorSpy.mock.calls[0]?.[0] as string;
    expect(call).toContain('boom');
    expect(call).toContain('disk full');
  });

  it('error() works without an error argument', () => {
    const logger = createLogger();
    logger.error('lone');
    const call = errorSpy.mock.calls[0]?.[0] as string;
    expect(call).toContain('lone');
    expect(call).not.toContain('::');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
bun test tests/utils/logger.test.ts
```

Expected: FAIL with "Cannot find module '../../src/utils/logger.ts'".

- [ ] **Step 3: Write `src/utils/logger.ts`**

```typescript
export interface Logger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function createLogger(prefix?: string): Logger {
  const fmt = (msg: string) =>
    prefix ? `[${timestamp()}] [${prefix}] ${msg}` : `[${timestamp()}] ${msg}`;
  return {
    info(msg) {
      console.log(fmt(msg));
    },
    error(msg, err) {
      const line = err
        ? `${fmt(msg)} :: ${err instanceof Error ? err.message : String(err)}`
        : fmt(msg);
      console.error(line);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
bun test tests/utils/logger.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/utils/logger.ts tests/utils/logger.test.ts
git commit -m "feat(utils): add createLogger with timestamp + optional prefix"
```

---

## Task 4: Slug utility

**Files:**
- Create: `src/utils/slug.ts`
- Test: `tests/utils/slug.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/utils/slug.test.ts
import { describe, it, expect } from 'bun:test';
import { slugify } from '../../src/utils/slug.ts';

describe('slugify', () => {
  it('lowercases and replaces non-alnum with hyphens', () => {
    expect(slugify('Fix Login Bug!')).toBe('fix-login-bug');
  });

  it('collapses runs of separators', () => {
    expect(slugify('  hello   world___foo  ')).toBe('hello-world-foo');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('---abc---')).toBe('abc');
  });

  it('truncates to maxLen and trims trailing hyphens after truncation', () => {
    const out = slugify('the-quick-brown-fox-jumps-over-the-lazy-dog', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).not.toMatch(/-$/);
  });

  it('returns "wi" when input has no alphanumerics', () => {
    expect(slugify('!!! ???')).toBe('wi');
  });

  it('handles unicode letters by stripping them (ASCII-only slugs)', () => {
    expect(slugify('café résumé')).toBe('caf-r-sum');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
bun test tests/utils/slug.test.ts
```

Expected: FAIL ("Cannot find module ...").

- [ ] **Step 3: Write `src/utils/slug.ts`**

```typescript
export function slugify(input: string, maxLen = 40): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length === 0) return 'wi';
  if (base.length <= maxLen) return base;
  return base.slice(0, maxLen).replace(/-+$/, '');
}
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
bun test tests/utils/slug.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/utils/slug.ts tests/utils/slug.test.ts
git commit -m "feat(utils): add slugify for branch-safe slugs"
```

---

## Task 5: Zod env config

**Files:**
- Create: `src/config/index.ts`
- Test: `tests/config/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/config/config.test.ts
import { describe, it, expect } from 'bun:test';
import { loadConfig } from '../../src/config/index.ts';

const validEnv: Record<string, string> = {
  AZURE_DEVOPS_PAT: 'test-pat',
  AZURE_DEVOPS_ORG: 'my-org',
  AZURE_DEVOPS_PROJECT: 'my-project',
  TARGET_REPO_PATH: '/repos/continia-banking',
  WORKTREE_BASE: '/repos/.worktrees',
};

describe('loadConfig', () => {
  it('returns AppConfig for a valid env', () => {
    const config = loadConfig(validEnv);
    expect(config.pat).toBe('test-pat');
    expect(config.org).toBe('my-org');
    expect(config.orgUrl).toBe('https://dev.azure.com/my-org');
    expect(config.project).toBe('my-project');
    expect(config.targetRepoPath).toBe('/repos/continia-banking');
    expect(config.worktreeBase).toBe('/repos/.worktrees');
  });

  it('applies defaults to optional fields', () => {
    const config = loadConfig(validEnv);
    expect(config.triggerTag).toBe('agent implement');
    expect(config.blockedTag).toBe('agent-blocked');
    expect(config.needInputTag).toBe('need-input');
    expect(config.pollIntervalMinutes).toBe(5);
    expect(config.concurrency).toBe(1);
    expect(config.maxRevisions).toBe(3);
    expect(config.maxRejectCycles).toBe(3);
    expect(config.claudeModel).toBe('claude-opus-4-7');
    expect(config.stateDir).toBe('.state');
    expect(config.assignedToFilter).toEqual([]);
    expect(config.dryRun).toBe(false);
  });

  it('throws a descriptive error when AZURE_DEVOPS_PAT is missing', () => {
    const env = { ...validEnv };
    delete env.AZURE_DEVOPS_PAT;
    expect(() => loadConfig(env)).toThrow(/AZURE_DEVOPS_PAT/);
    expect(() => loadConfig(env)).toThrow(/Invalid configuration/);
  });

  it('throws when WORKTREE_BASE is missing', () => {
    const env = { ...validEnv };
    delete env.WORKTREE_BASE;
    expect(() => loadConfig(env)).toThrow(/WORKTREE_BASE/);
  });

  it('coerces numeric env vars from strings', () => {
    const config = loadConfig({
      ...validEnv,
      POLL_INTERVAL_MINUTES: '10',
      CONCURRENCY: '3',
      MAX_REVISIONS: '5',
      MAX_REJECT_CYCLES: '7',
    });
    expect(config.pollIntervalMinutes).toBe(10);
    expect(config.concurrency).toBe(3);
    expect(config.maxRevisions).toBe(5);
    expect(config.maxRejectCycles).toBe(7);
  });

  it('parses ASSIGNED_TO_FILTER as comma-separated list with trim', () => {
    const config = loadConfig({
      ...validEnv,
      ASSIGNED_TO_FILTER: 'Alice Smith, Bob Jones ,Carol',
    });
    expect(config.assignedToFilter).toEqual(['Alice Smith', 'Bob Jones', 'Carol']);
  });

  it('returns empty assignedToFilter when env var is empty string', () => {
    const config = loadConfig({ ...validEnv, ASSIGNED_TO_FILTER: '' });
    expect(config.assignedToFilter).toEqual([]);
  });

  it('honours custom tag overrides', () => {
    const config = loadConfig({
      ...validEnv,
      TRIGGER_TAG: 'do-it',
      BLOCKED_TAG: 'stuck',
      NEED_INPUT_TAG: 'help',
    });
    expect(config.triggerTag).toBe('do-it');
    expect(config.blockedTag).toBe('stuck');
    expect(config.needInputTag).toBe('help');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
bun test tests/config/config.test.ts
```

Expected: FAIL ("Cannot find module ...").

- [ ] **Step 3: Write `src/config/index.ts`**

```typescript
import { z } from 'zod';
import type { AppConfig } from '../types/index.ts';

const envSchema = z.object({
  AZURE_DEVOPS_PAT: z.string().min(1, 'AZURE_DEVOPS_PAT is required'),
  AZURE_DEVOPS_ORG: z.string().min(1, 'AZURE_DEVOPS_ORG is required'),
  AZURE_DEVOPS_PROJECT: z.string().min(1, 'AZURE_DEVOPS_PROJECT is required'),
  TARGET_REPO_PATH: z.string().min(1, 'TARGET_REPO_PATH is required'),
  WORKTREE_BASE: z.string().min(1, 'WORKTREE_BASE is required'),
  TRIGGER_TAG: z.string().default('agent implement'),
  BLOCKED_TAG: z.string().default('agent-blocked'),
  NEED_INPUT_TAG: z.string().default('need-input'),
  POLL_INTERVAL_MINUTES: z.coerce.number().default(5),
  CONCURRENCY: z.coerce.number().default(1),
  MAX_REVISIONS: z.coerce.number().default(3),
  MAX_REJECT_CYCLES: z.coerce.number().default(3),
  CLAUDE_MODEL: z.string().default('claude-opus-4-7'),
  STATE_DIR: z.string().default('.state'),
  ASSIGNED_TO_FILTER: z.string().optional(),
});

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${messages}`);
  }
  const p = result.data;

  const assignedToFilter = p.ASSIGNED_TO_FILTER
    ? p.ASSIGNED_TO_FILTER.split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  return {
    org: p.AZURE_DEVOPS_ORG,
    orgUrl: `https://dev.azure.com/${p.AZURE_DEVOPS_ORG}`,
    project: p.AZURE_DEVOPS_PROJECT,
    pat: p.AZURE_DEVOPS_PAT,
    targetRepoPath: p.TARGET_REPO_PATH,
    worktreeBase: p.WORKTREE_BASE,
    triggerTag: p.TRIGGER_TAG,
    blockedTag: p.BLOCKED_TAG,
    needInputTag: p.NEED_INPUT_TAG,
    pollIntervalMinutes: p.POLL_INTERVAL_MINUTES,
    concurrency: p.CONCURRENCY,
    maxRevisions: p.MAX_REVISIONS,
    maxRejectCycles: p.MAX_REJECT_CYCLES,
    claudeModel: p.CLAUDE_MODEL,
    stateDir: p.STATE_DIR,
    assignedToFilter,
    dryRun: false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
bun test tests/config/config.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/config/index.ts tests/config/config.test.ts
git commit -m "feat(config): add Zod-validated env config loader"
```

---

## Task 6: Per-WI pipeline state store

**Files:**
- Create: `src/state/state-store.ts`
- Test: `tests/state/state-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/state/state-store.test.ts
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import type { PipelineState } from '../../src/types/index.ts';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'devops-coder-state-'));
}

function makeState(workItemId: number, overrides: Partial<PipelineState> = {}): PipelineState {
  const ts = new Date('2026-05-01T10:00:00.000Z').toISOString();
  return {
    workItemId,
    slug: `wi-${workItemId}`,
    startedAt: ts,
    updatedAt: ts,
    currentStage: 'analyzer',
    history: [],
    attempts: {},
    outputs: {},
    ...overrides,
  };
}

describe('PipelineStateStore', () => {
  it('save then load returns the same state shape', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    const state = makeState(101);

    store.save(state);

    const loaded = store.load(101);
    expect(loaded).not.toBeNull();
    expect(loaded?.workItemId).toBe(101);
    expect(loaded?.slug).toBe('wi-101');
    expect(loaded?.currentStage).toBe('analyzer');
  });

  it('save updates updatedAt', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    const state = makeState(101, { updatedAt: '2020-01-01T00:00:00.000Z' });
    store.save(state);
    const loaded = store.load(101);
    expect(loaded?.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(new Date(loaded!.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it('load returns null when the file does not exist', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    expect(store.load(999)).toBeNull();
  });

  it('load returns null when the file contains corrupt JSON', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    writeFileSync(join(dir, '101.json'), '{{not json}}', 'utf-8');
    expect(store.load(101)).toBeNull();
  });

  it('load returns null when the file is missing the workItemId field', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    writeFileSync(join(dir, '101.json'), JSON.stringify({ slug: 'no-id' }), 'utf-8');
    expect(store.load(101)).toBeNull();
  });

  it('listAll returns every saved pipeline state', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    store.save(makeState(101));
    store.save(makeState(102));
    store.save(makeState(103));

    const all = store.listAll();
    const ids = all.map((s) => s.workItemId).sort((a, b) => a - b);
    expect(ids).toEqual([101, 102, 103]);
  });

  it('listAll skips files that do not end with .json', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    store.save(makeState(101));
    writeFileSync(join(dir, 'README.txt'), 'ignore me', 'utf-8');
    expect(store.listAll().length).toBe(1);
  });

  it('listResumable excludes completed, terminal-failed, and cancelled states', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    store.save(makeState(101)); // resumable
    store.save(makeState(102, { completedAt: '2026-05-01T11:00:00.000Z' }));
    store.save(makeState(103, { terminalError: { stage: 'coder', message: 'x', at: '2026-05-01T11:00:00.000Z' } }));
    store.save(makeState(104, { cancelled: true }));
    store.save(makeState(105)); // resumable

    const resumable = store.listResumable();
    const ids = resumable.map((s) => s.workItemId).sort((a, b) => a - b);
    expect(ids).toEqual([101, 105]);
  });

  it('delete removes the on-disk file', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    store.save(makeState(101));
    expect(store.load(101)).not.toBeNull();
    store.delete(101);
    expect(store.load(101)).toBeNull();
  });

  it('delete is idempotent when the file does not exist', () => {
    const dir = makeTmpDir();
    const store = new PipelineStateStore(dir);
    expect(() => store.delete(999)).not.toThrow();
  });

  it('save creates the state directory if it does not exist', () => {
    const parent = makeTmpDir();
    const dir = join(parent, 'nested', 'state');
    const store = new PipelineStateStore(dir);
    store.save(makeState(101));
    const raw = readFileSync(join(dir, '101.json'), 'utf-8');
    expect(JSON.parse(raw).workItemId).toBe(101);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
bun test tests/state/state-store.test.ts
```

Expected: FAIL ("Cannot find module ...").

- [ ] **Step 3: Write `src/state/state-store.ts`**

```typescript
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import type { PipelineState } from '../types/index.ts';

export class PipelineStateStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  private filePath(workItemId: number): string {
    return join(this.dir, `${workItemId}.json`);
  }

  load(workItemId: number): PipelineState | null {
    const path = this.filePath(workItemId);
    if (!existsSync(path)) return null;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PipelineState>;
      if (typeof parsed.workItemId !== 'number') return null;
      return parsed as PipelineState;
    } catch {
      return null;
    }
  }

  save(state: PipelineState): void {
    mkdirSync(this.dir, { recursive: true });
    state.updatedAt = new Date().toISOString();
    writeFileSync(
      this.filePath(state.workItemId),
      JSON.stringify(state, null, 2),
      'utf-8',
    );
  }

  delete(workItemId: number): void {
    const path = this.filePath(workItemId);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  listAll(): PipelineState[] {
    if (!existsSync(this.dir)) return [];
    const result: PipelineState[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      const id = Number(file.slice(0, -'.json'.length));
      if (!Number.isFinite(id)) continue;
      const s = this.load(id);
      if (s) result.push(s);
    }
    return result;
  }

  listResumable(): PipelineState[] {
    return this.listAll().filter(
      (s) => !s.completedAt && !s.terminalError && !s.cancelled,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
bun test tests/state/state-store.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/state/state-store.ts tests/state/state-store.test.ts
git commit -m "feat(state): add per-WI PipelineStateStore"
```

---

## Task 7: Stage interface, PipelineContext, PipelinePauseError

**Files:**
- Create: `src/pipeline/stage.ts`

This task has no dedicated tests — `Stage` is an interface and `PipelinePauseError` is a sentinel; both are exercised by the orchestrator and checkpoint tests in later tasks. We keep the file pure (no logic) so the typecheck step is the verification.

- [ ] **Step 1: Write `src/pipeline/stage.ts`**

```typescript
import type { AppConfig, PipelineState } from '../types/index.ts';
import type { Logger } from '../utils/logger.ts';

export interface AbortFlag {
  aborted: boolean;
}

export interface PipelineContext {
  config: AppConfig;
  logger: Logger;
  abortFlag: AbortFlag;
  now: () => Date;
}

export interface Stage {
  readonly name: string;
  canRun(state: PipelineState): boolean;
  execute(state: PipelineState, context: PipelineContext): Promise<PipelineState>;
}

export class PipelinePauseError extends Error {
  override readonly name = 'PipelinePauseError';
  constructor(public readonly reason: string) {
    super(`Pipeline paused: ${reason}`);
  }
}
```

- [ ] **Step 2: Typecheck**

```powershell
bun run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```powershell
git add src/pipeline/stage.ts
git commit -m "feat(pipeline): add Stage interface, PipelineContext, PipelinePauseError"
```

---

## Task 8: Pipeline orchestrator (`runPipeline` + `createInitialState`)

**Files:**
- Create: `src/pipeline/orchestrator.ts`
- Test: `tests/pipeline/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/pipeline/orchestrator.test.ts
import { describe, it, expect, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  runPipeline,
  createInitialState,
  StageNotFoundError,
} from '../../src/pipeline/orchestrator.ts';
import type { Stage, PipelineContext } from '../../src/pipeline/stage.ts';
import { PipelinePauseError } from '../../src/pipeline/stage.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import type { AppConfig, PipelineState } from '../../src/types/index.ts';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'devops-coder-orch-'));
}

const FIXED_NOW = new Date('2026-05-04T12:00:00.000Z');

function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const config: AppConfig = {
    org: 'o', orgUrl: 'https://dev.azure.com/o', project: 'p', pat: 't',
    targetRepoPath: '/r', worktreeBase: '/w',
    triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
    pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
    claudeModel: 'm', stateDir: '.state', assignedToFilter: [], dryRun: false,
  };
  const logger = { info: mock(() => {}), error: mock(() => {}) };
  return {
    config,
    logger,
    abortFlag: { aborted: false },
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function makeStage(
  name: string,
  exec: (s: PipelineState, c: PipelineContext) => Promise<PipelineState> = async (s) => s,
  canRun: (s: PipelineState) => boolean = () => true,
): Stage {
  return { name, canRun, execute: exec };
}

describe('createInitialState', () => {
  it('produces a state with timestamps and empty bookkeeping fields', () => {
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    expect(state.workItemId).toBe(101);
    expect(state.slug).toBe('wi-101');
    expect(state.startedAt).toBe(FIXED_NOW.toISOString());
    expect(state.updatedAt).toBe(FIXED_NOW.toISOString());
    expect(state.currentStage).toBeNull();
    expect(state.history).toEqual([]);
    expect(state.attempts).toEqual({});
    expect(state.outputs).toEqual({});
    expect(state.completedAt).toBeUndefined();
  });
});

describe('runPipeline', () => {
  it('runs stages in order and marks completedAt at the end', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    const calls: string[] = [];
    const stages: Stage[] = [
      makeStage('a', async (s) => { calls.push('a'); return s; }),
      makeStage('b', async (s) => { calls.push('b'); return s; }),
      makeStage('c', async (s) => { calls.push('c'); return s; }),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);

    const final = await runPipeline({ stages, state, context: ctx, store });

    expect(calls).toEqual(['a', 'b', 'c']);
    expect(final.completedAt).toBe(FIXED_NOW.toISOString());
    expect(final.currentStage).toBeNull();
    expect(final.history.map((h) => h.stage)).toEqual(['a', 'b', 'c']);
    expect(final.history.every((h) => h.outcome === 'success')).toBe(true);
    expect(final.attempts).toEqual({ a: 1, b: 1, c: 1 });
  });

  it('persists state after each stage', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    let stageBSaw: PipelineState | undefined;
    const stages: Stage[] = [
      makeStage('a', async (s) => s),
      makeStage('b', async (s, _c) => {
        stageBSaw = store.load(s.workItemId)!;
        return s;
      }),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    await runPipeline({ stages, state, context: ctx, store });

    expect(stageBSaw).toBeDefined();
    expect(stageBSaw!.history.map((h) => h.stage)).toEqual(['a']);
  });

  it('skips stages whose canRun returns false and records a skip outcome', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    const stages: Stage[] = [
      makeStage('a'),
      makeStage('b', async (s) => s, () => false),
      makeStage('c'),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    const final = await runPipeline({ stages, state, context: ctx, store });
    expect(final.history.map((h) => `${h.stage}:${h.outcome}`)).toEqual([
      'a:success', 'b:skip', 'c:success',
    ]);
    expect(final.completedAt).toBeDefined();
  });

  it('records terminal error and rethrows when a stage throws', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    const stages: Stage[] = [
      makeStage('a'),
      makeStage('b', async () => { throw new Error('boom'); }),
      makeStage('c'),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);

    let caught: unknown;
    try {
      await runPipeline({ stages, state, context: ctx, store });
    } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('boom');

    const persisted = store.load(101)!;
    expect(persisted.terminalError?.stage).toBe('b');
    expect(persisted.terminalError?.message).toBe('boom');
    expect(persisted.completedAt).toBeUndefined();
    expect(persisted.history.find((h) => h.stage === 'b')?.outcome).toBe('failure');
  });

  it('stops gracefully and persists state when a stage throws PipelinePauseError', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    const stages: Stage[] = [
      makeStage('a'),
      makeStage('b', async (s) => {
        s.currentStage = 'b';
        throw new PipelinePauseError('waiting on human');
      }),
      makeStage('c'),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    const final = await runPipeline({ stages, state, context: ctx, store });

    expect(final.currentStage).toBe('b');
    expect(final.completedAt).toBeUndefined();
    expect(final.terminalError).toBeUndefined();

    const persisted = store.load(101)!;
    expect(persisted.currentStage).toBe('b');
    expect(persisted.history.find((h) => h.stage === 'b')?.outcome).toBe('pause');
  });

  it('honours abortFlag and exits without running further stages', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const abortFlag = { aborted: false };
    const ctx = makeContext({ abortFlag });
    const calls: string[] = [];
    const stages: Stage[] = [
      makeStage('a', async (s) => { calls.push('a'); abortFlag.aborted = true; return s; }),
      makeStage('b', async (s) => { calls.push('b'); return s; }),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    const final = await runPipeline({ stages, state, context: ctx, store });

    expect(calls).toEqual(['a']);
    expect(final.completedAt).toBeUndefined();
  });

  it('throws StageNotFoundError when currentStage is unknown', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    const stages: Stage[] = [makeStage('a'), makeStage('b')];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    state.currentStage = 'ghost';

    let caught: unknown;
    try {
      await runPipeline({ stages, state, context: ctx, store });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(StageNotFoundError);
  });

  it('resumes from state.currentStage when set', async () => {
    const dir = tmpDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();
    const calls: string[] = [];
    const stages: Stage[] = [
      makeStage('a', async (s) => { calls.push('a'); return s; }),
      makeStage('b', async (s) => { calls.push('b'); return s; }),
      makeStage('c', async (s) => { calls.push('c'); return s; }),
    ];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);
    state.currentStage = 'b';
    await runPipeline({ stages, state, context: ctx, store });
    expect(calls).toEqual(['b', 'c']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
bun test tests/pipeline/orchestrator.test.ts
```

Expected: FAIL ("Cannot find module ...").

- [ ] **Step 3: Write `src/pipeline/orchestrator.ts`**

```typescript
import type { Stage, PipelineContext } from './stage.ts';
import { PipelinePauseError } from './stage.ts';
import type { PipelineState, StageHistoryEntry } from '../types/index.ts';
import type { PipelineStateStore } from '../state/state-store.ts';

export interface RunPipelineOptions {
  stages: Stage[];
  state: PipelineState;
  context: PipelineContext;
  store: PipelineStateStore;
}

export class StageNotFoundError extends Error {
  override readonly name = 'StageNotFoundError';
}

export function createInitialState(
  workItemId: number,
  slug: string,
  now: Date = new Date(),
): PipelineState {
  const ts = now.toISOString();
  return {
    workItemId,
    slug,
    startedAt: ts,
    updatedAt: ts,
    currentStage: null,
    history: [],
    attempts: {},
    outputs: {},
  };
}

function findStageIndex(stages: Stage[], name: string | null): number {
  if (name == null) return -1;
  return stages.findIndex((s) => s.name === name);
}

function appendHistory(state: PipelineState, entry: StageHistoryEntry): void {
  state.history.push(entry);
}

export async function runPipeline(opts: RunPipelineOptions): Promise<PipelineState> {
  const { stages, context, store } = opts;
  let state = opts.state;

  if (state.currentStage == null) {
    state.currentStage = stages[0]?.name ?? null;
  }

  while (state.currentStage != null && !context.abortFlag.aborted) {
    const idx = findStageIndex(stages, state.currentStage);
    if (idx < 0) {
      throw new StageNotFoundError(
        `Stage "${state.currentStage}" not found in pipeline`,
      );
    }
    const stage = stages[idx]!;
    const startedAt = context.now().toISOString();

    if (!stage.canRun(state)) {
      appendHistory(state, {
        stage: stage.name,
        startedAt,
        endedAt: context.now().toISOString(),
        outcome: 'skip',
      });
      state.currentStage = stages[idx + 1]?.name ?? null;
      store.save(state);
      continue;
    }

    try {
      state = await stage.execute(state, context);
      const endedAt = context.now().toISOString();
      if (state.currentStage === stage.name) {
        state.currentStage = stages[idx + 1]?.name ?? null;
      }
      appendHistory(state, {
        stage: stage.name,
        startedAt,
        endedAt,
        outcome: 'success',
      });
      state.attempts[stage.name] = (state.attempts[stage.name] ?? 0) + 1;
      store.save(state);
    } catch (err) {
      const endedAt = context.now().toISOString();
      if (err instanceof PipelinePauseError) {
        appendHistory(state, {
          stage: stage.name,
          startedAt,
          endedAt,
          outcome: 'pause',
          message: err.reason,
        });
        store.save(state);
        return state;
      }
      const message = err instanceof Error ? err.message : String(err);
      state.terminalError = { stage: stage.name, message, at: endedAt };
      appendHistory(state, {
        stage: stage.name,
        startedAt,
        endedAt,
        outcome: 'failure',
        message,
      });
      store.save(state);
      throw err;
    }
  }

  if (
    state.currentStage == null &&
    !state.completedAt &&
    !state.terminalError &&
    !context.abortFlag.aborted
  ) {
    state.completedAt = context.now().toISOString();
    store.save(state);
  }
  return state;
}
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
bun test tests/pipeline/orchestrator.test.ts
```

Expected: PASS, 9 tests (1 in `createInitialState`, 8 in `runPipeline`).

- [ ] **Step 5: Commit**

```powershell
git add src/pipeline/orchestrator.ts tests/pipeline/orchestrator.test.ts
git commit -m "feat(pipeline): add runPipeline orchestrator with persistence + pause"
```

---

## Task 9: agentStage factory + AgentRunner interface

**Files:**
- Create: `src/pipeline/agent-stage.ts`
- Test: `tests/pipeline/agent-stage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/pipeline/agent-stage.test.ts
import { describe, it, expect, mock } from 'bun:test';
import { z } from 'zod';
import { agentStage } from '../../src/pipeline/agent-stage.ts';
import type { AgentRunner } from '../../src/pipeline/agent-stage.ts';
import type { PipelineContext } from '../../src/pipeline/stage.ts';
import type { AppConfig, PipelineState } from '../../src/types/index.ts';

const FIXED_NOW = new Date('2026-05-04T12:00:00.000Z');

function mockContext(): PipelineContext {
  const config: AppConfig = {
    org: 'o', orgUrl: 'https://dev.azure.com/o', project: 'p', pat: 't',
    targetRepoPath: '/r', worktreeBase: '/w',
    triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
    pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
    claudeModel: 'claude-opus-4-7', stateDir: '.state', assignedToFilter: [], dryRun: false,
  };
  return {
    config,
    logger: { info: mock(() => {}), error: mock(() => {}) },
    abortFlag: { aborted: false },
    now: () => FIXED_NOW,
  };
}

function mockState(): PipelineState {
  return {
    workItemId: 101,
    slug: 'wi-101',
    startedAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    currentStage: null,
    history: [],
    attempts: {},
    outputs: {},
  };
}

const VerdictSchema = z.object({
  verdict: z.enum(['proceed', 'reject']),
  taskSummary: z.string().optional(),
});

describe('agentStage', () => {
  it('passes the built prompt + schema + tools + model to the runner', async () => {
    const seenArgs: Array<{ prompt: string; schema: unknown; tools?: string[]; model?: string }> = [];
    const runner: AgentRunner = {
      run: mock(async (args) => {
        seenArgs.push(args as { prompt: string; schema: unknown; tools?: string[]; model?: string });
        return { verdict: 'proceed', taskSummary: 'do x' };
      }) as AgentRunner['run'],
    };
    const stage = agentStage(
      {
        name: 'analyzer',
        buildPrompt: (s) => `wi=${s.workItemId}`,
        schema: VerdictSchema,
        tools: ['Read'],
        model: 'claude-opus-4-7',
        applyOutput: (s, out) => ({ ...s, outputs: { ...s.outputs, analyzer: out } }),
      },
      runner,
    );

    const state = mockState();
    const ctx = mockContext();
    const next = await stage.execute(state, ctx);

    expect(seenArgs.length).toBe(1);
    expect(seenArgs[0]?.prompt).toBe('wi=101');
    expect(seenArgs[0]?.schema).toBe(VerdictSchema);
    expect(seenArgs[0]?.tools).toEqual(['Read']);
    expect(seenArgs[0]?.model).toBe('claude-opus-4-7');
    expect(next.outputs.analyzer).toEqual({ verdict: 'proceed', taskSummary: 'do x' });
  });

  it('uses canRun option when provided, defaulting to always-true', async () => {
    const runner: AgentRunner = { run: mock(async () => ({ verdict: 'proceed' })) as AgentRunner['run'] };
    const restricted = agentStage(
      {
        name: 'restricted',
        buildPrompt: () => '',
        schema: VerdictSchema,
        applyOutput: (s) => s,
        canRun: () => false,
      },
      runner,
    );
    expect(restricted.canRun(mockState())).toBe(false);

    const open = agentStage(
      {
        name: 'open',
        buildPrompt: () => '',
        schema: VerdictSchema,
        applyOutput: (s) => s,
      },
      runner,
    );
    expect(open.canRun(mockState())).toBe(true);
  });

  it('exposes the configured stage name', () => {
    const runner: AgentRunner = { run: mock(async () => ({ verdict: 'proceed' })) as AgentRunner['run'] };
    const stage = agentStage(
      {
        name: 'analyzer',
        buildPrompt: () => '',
        schema: VerdictSchema,
        applyOutput: (s) => s,
      },
      runner,
    );
    expect(stage.name).toBe('analyzer');
  });

  it('propagates errors thrown by the runner', async () => {
    const runner: AgentRunner = { run: mock(async () => { throw new Error('rate limited'); }) as AgentRunner['run'] };
    const stage = agentStage(
      {
        name: 'analyzer',
        buildPrompt: () => '',
        schema: VerdictSchema,
        applyOutput: (s) => s,
      },
      runner,
    );
    let caught: unknown;
    try { await stage.execute(mockState(), mockContext()); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('rate limited');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
bun test tests/pipeline/agent-stage.test.ts
```

Expected: FAIL ("Cannot find module ...").

- [ ] **Step 3: Write `src/pipeline/agent-stage.ts`**

```typescript
import type { z } from 'zod';
import type { Stage, PipelineContext } from './stage.ts';
import type { PipelineState } from '../types/index.ts';

export interface AgentRunArgs<T> {
  prompt: string;
  schema: z.ZodSchema<T>;
  tools?: string[];
  model?: string;
}

export interface AgentRunner {
  run<T>(args: AgentRunArgs<T>): Promise<T>;
}

export interface AgentStageConfig<T> {
  name: string;
  buildPrompt: (state: PipelineState, ctx: PipelineContext) => string;
  schema: z.ZodSchema<T>;
  tools?: string[];
  model?: string;
  applyOutput: (state: PipelineState, output: T) => PipelineState;
  canRun?: (state: PipelineState) => boolean;
}

export function agentStage<T>(
  cfg: AgentStageConfig<T>,
  runner: AgentRunner,
): Stage {
  return {
    name: cfg.name,
    canRun: cfg.canRun ?? (() => true),
    async execute(state, ctx) {
      const prompt = cfg.buildPrompt(state, ctx);
      const output = await runner.run<T>({
        prompt,
        schema: cfg.schema,
        tools: cfg.tools,
        model: cfg.model,
      });
      return cfg.applyOutput(state, output);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
bun test tests/pipeline/agent-stage.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/pipeline/agent-stage.ts tests/pipeline/agent-stage.test.ts
git commit -m "feat(pipeline): add agentStage factory + AgentRunner interface"
```

---

## Task 10: Production AgentRunner (Claude SDK wrapper)

**Files:**
- Create: `src/services/claude-agent-runner.ts`
- Test: `tests/services/claude-agent-runner.test.ts`

This task adds the production implementation of the `AgentRunner` interface from Task 9, wrapping `query()` from `@anthropic-ai/claude-agent-sdk`. The shape mirrors `src/services/ai-generator.ts` from `DevOpsPullTemplate` — same streaming `for await` loop, same cost/usage logging, same `permissionMode: 'bypassPermissions'`. The DevopsCoder twist: instructions tell the model to return JSON only, the wrapper extracts the JSON, and a Zod schema validates it. Following the template's testing convention, only the pure `extractJson` helper is unit-tested; the SDK call itself is verified by integration with real Claude in later plans.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/claude-agent-runner.test.ts
import { describe, it, expect } from 'bun:test';
import { extractJson } from '../../src/services/claude-agent-runner.ts';

describe('extractJson', () => {
  it('returns input as-is when it is already a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips bare ``` fences without a language tag', () => {
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts the outermost JSON object when surrounded by prose', () => {
    expect(extractJson('Sure! {"verdict":"proceed"} that is the answer.'))
      .toBe('{"verdict":"proceed"}');
  });

  it('returns the trimmed input when no JSON object is found', () => {
    expect(extractJson('  no json here  ')).toBe('no json here');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
bun test tests/services/claude-agent-runner.test.ts
```

Expected: FAIL ("Cannot find module ...").

- [ ] **Step 3: Write `src/services/claude-agent-runner.ts`**

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunner, AgentRunArgs } from '../pipeline/agent-stage.ts';
import type { Logger } from '../utils/logger.ts';
import type { AppConfig } from '../types/index.ts';

const STRUCTURED_OUTPUT_INSTRUCTION =
  'Respond with ONLY a single valid JSON object that satisfies the schema described in the prompt. ' +
  'No prose, no markdown fences, no commentary. Output the JSON object and nothing else.';

export class AgentOutputParseError extends Error {
  override readonly name = 'AgentOutputParseError';
  constructor(public readonly raw: string, message: string) {
    super(message);
  }
}

/**
 * Strip ``` fences and surrounding prose from raw model output to recover the JSON body.
 * Pure helper — no side effects.
 */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export interface ClaudeAgentRunnerDeps {
  config: AppConfig;
  logger: Logger;
}

export function createClaudeAgentRunner(deps: ClaudeAgentRunnerDeps): AgentRunner {
  return {
    async run<T>(args: AgentRunArgs<T>): Promise<T> {
      let result: string | undefined;

      for await (const message of query({
        prompt: args.prompt,
        options: {
          model: args.model ?? deps.config.claudeModel,
          allowedTools: args.tools ?? [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          systemPrompt: STRUCTURED_OUTPUT_INSTRUCTION,
        },
      })) {
        if (message.type === 'result') {
          deps.logger.info(
            `agent: $${message.total_cost_usd.toFixed(4)} | ${message.usage.input_tokens ?? 0} in / ${message.usage.output_tokens ?? 0} out | ${message.num_turns} turns`,
          );
          if (message.subtype === 'success') {
            result = message.result;
          }
        }
      }

      if (result === undefined) {
        throw new Error('No result received from Claude Agent SDK');
      }

      const json = extractJson(result);
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new AgentOutputParseError(result, `Failed to parse JSON: ${msg}`);
      }

      const validated = args.schema.safeParse(parsed);
      if (!validated.success) {
        const issues = validated.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
        throw new AgentOutputParseError(
          result,
          `Schema validation failed: ${issues}`,
        );
      }
      return validated.data;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
bun test tests/services/claude-agent-runner.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck**

```powershell
bun run typecheck
```

Expected: PASS. (This catches mismatches between `AgentRunArgs<T>` from Task 9 and the runner's signature.)

- [ ] **Step 6: Commit**

```powershell
git add src/services/claude-agent-runner.ts tests/services/claude-agent-runner.test.ts
git commit -m "feat(services): add Claude SDK-backed AgentRunner with JSON + Zod validation"
```

---

## Task 11: revisionLoop factory

**Files:**
- Create: `src/pipeline/revision-loop.ts`
- Test: `tests/pipeline/revision-loop.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/pipeline/revision-loop.test.ts
import { describe, it, expect, mock } from 'bun:test';
import { revisionLoop } from '../../src/pipeline/revision-loop.ts';
import type { Stage, PipelineContext } from '../../src/pipeline/stage.ts';
import type { AppConfig, PipelineState } from '../../src/types/index.ts';

const FIXED_NOW = new Date('2026-05-04T12:00:00.000Z');

function mockContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const config: AppConfig = {
    org: 'o', orgUrl: 'https://dev.azure.com/o', project: 'p', pat: 't',
    targetRepoPath: '/r', worktreeBase: '/w',
    triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
    pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
    claudeModel: 'm', stateDir: '.state', assignedToFilter: [], dryRun: false,
  };
  return {
    config,
    logger: { info: mock(() => {}), error: mock(() => {}) },
    abortFlag: { aborted: false },
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function mockState(): PipelineState {
  return {
    workItemId: 101,
    slug: 'wi-101',
    startedAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    currentStage: null,
    history: [],
    attempts: {},
    outputs: {},
  };
}

function makeStage(
  name: string,
  exec: (s: PipelineState, c: PipelineContext) => Promise<PipelineState>,
): Stage {
  return { name, canRun: () => true, execute: exec };
}

describe('revisionLoop', () => {
  it('calls producer then reviewer, exits on first approval', async () => {
    const calls: string[] = [];
    const producer = makeStage('coder', async (s) => { calls.push('coder'); return s; });
    const reviewer = makeStage('reviewer', async (s) => {
      calls.push('reviewer');
      return { ...s, outputs: { ...s.outputs, reviewer: { verdict: 'approve' } } };
    });

    const stage = revisionLoop({
      name: 'review-loop',
      producer,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) =>
        (s.outputs.reviewer as { verdict?: string } | undefined)?.verdict === 'approve',
    });

    const final = await stage.execute(mockState(), mockContext());
    expect(calls).toEqual(['coder', 'reviewer']);
    expect((final.outputs.reviewer as { verdict: string }).verdict).toBe('approve');
  });

  it('loops up to maxAttempts when reviewer keeps rejecting', async () => {
    const calls: string[] = [];
    let attempt = 0;
    const producer = makeStage('coder', async (s) => { calls.push('coder'); return s; });
    const reviewer = makeStage('reviewer', async (s) => {
      attempt++;
      calls.push(`reviewer:${attempt}`);
      const verdict = attempt >= 3 ? 'approve' : 'revise';
      return { ...s, outputs: { ...s.outputs, reviewer: { verdict } } };
    });

    const stage = revisionLoop({
      name: 'review-loop',
      producer,
      reviewer,
      maxAttempts: 5,
      isApproved: (s) =>
        (s.outputs.reviewer as { verdict?: string } | undefined)?.verdict === 'approve',
    });

    await stage.execute(mockState(), mockContext());
    expect(calls).toEqual([
      'coder', 'reviewer:1',
      'coder', 'reviewer:2',
      'coder', 'reviewer:3',
    ]);
  });

  it('calls onExhausted and returns its state when maxAttempts is hit without approval', async () => {
    const producer = makeStage('coder', async (s) => s);
    const reviewer = makeStage('reviewer', async (s) =>
      ({ ...s, outputs: { ...s.outputs, reviewer: { verdict: 'revise' } } }),
    );
    const onExhausted = mock(async (s: PipelineState) =>
      ({ ...s, outputs: { ...s.outputs, exhausted: true } }),
    );

    const stage = revisionLoop({
      name: 'review-loop',
      producer,
      reviewer,
      maxAttempts: 2,
      isApproved: () => false,
      onExhausted,
    });

    const final = await stage.execute(mockState(), mockContext());
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(final.outputs.exhausted).toBe(true);
  });

  it('returns the latest state when maxAttempts is hit and onExhausted is not provided', async () => {
    const producer = makeStage('coder', async (s) => s);
    const reviewer = makeStage('reviewer', async (s) =>
      ({ ...s, outputs: { ...s.outputs, reviewer: { verdict: 'revise' } } }),
    );

    const stage = revisionLoop({
      name: 'review-loop',
      producer,
      reviewer,
      maxAttempts: 2,
      isApproved: () => false,
    });

    const final = await stage.execute(mockState(), mockContext());
    expect((final.outputs.reviewer as { verdict: string }).verdict).toBe('revise');
  });

  it('breaks out of the loop when abortFlag becomes true between attempts', async () => {
    const abortFlag = { aborted: false };
    const calls: string[] = [];
    const producer = makeStage('coder', async (s) => { calls.push('coder'); return s; });
    const reviewer = makeStage('reviewer', async (s) => {
      calls.push('reviewer');
      abortFlag.aborted = true;
      return { ...s, outputs: { ...s.outputs, reviewer: { verdict: 'revise' } } };
    });

    const stage = revisionLoop({
      name: 'review-loop',
      producer,
      reviewer,
      maxAttempts: 5,
      isApproved: () => false,
    });
    await stage.execute(mockState(), mockContext({ abortFlag }));
    expect(calls).toEqual(['coder', 'reviewer']);
  });

  it('exposes the configured stage name', () => {
    const noop = makeStage('x', async (s) => s);
    const stage = revisionLoop({
      name: 'rl',
      producer: noop,
      reviewer: noop,
      maxAttempts: 1,
      isApproved: () => true,
    });
    expect(stage.name).toBe('rl');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
bun test tests/pipeline/revision-loop.test.ts
```

Expected: FAIL ("Cannot find module ...").

- [ ] **Step 3: Write `src/pipeline/revision-loop.ts`**

```typescript
import type { Stage, PipelineContext } from './stage.ts';
import type { PipelineState } from '../types/index.ts';

export interface RevisionLoopConfig {
  name: string;
  producer: Stage;
  reviewer: Stage;
  maxAttempts: number;
  isApproved: (state: PipelineState) => boolean;
  onExhausted?: (state: PipelineState, ctx: PipelineContext) => Promise<PipelineState>;
}

export function revisionLoop(cfg: RevisionLoopConfig): Stage {
  return {
    name: cfg.name,
    canRun: () => true,
    async execute(state, ctx) {
      let current = state;
      for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
        if (ctx.abortFlag.aborted) return current;
        current = await cfg.producer.execute(current, ctx);
        if (ctx.abortFlag.aborted) return current;
        current = await cfg.reviewer.execute(current, ctx);
        if (cfg.isApproved(current)) return current;
      }
      if (cfg.onExhausted) {
        current = await cfg.onExhausted(current, ctx);
      }
      return current;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
bun test tests/pipeline/revision-loop.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/pipeline/revision-loop.ts tests/pipeline/revision-loop.test.ts
git commit -m "feat(pipeline): add revisionLoop factory"
```

---

## Task 12: checkpoint factory

**Files:**
- Create: `src/pipeline/checkpoint.ts`
- Test: `tests/pipeline/checkpoint.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/pipeline/checkpoint.test.ts
import { describe, it, expect, mock } from 'bun:test';
import { checkpoint } from '../../src/pipeline/checkpoint.ts';
import { PipelinePauseError } from '../../src/pipeline/stage.ts';
import type { PipelineContext } from '../../src/pipeline/stage.ts';
import type { AppConfig, PipelineState } from '../../src/types/index.ts';

const FIXED_NOW = new Date('2026-05-04T12:00:00.000Z');

function mockContext(): PipelineContext {
  const config: AppConfig = {
    org: 'o', orgUrl: 'https://dev.azure.com/o', project: 'p', pat: 't',
    targetRepoPath: '/r', worktreeBase: '/w',
    triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
    pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
    claudeModel: 'm', stateDir: '.state', assignedToFilter: [], dryRun: false,
  };
  return {
    config,
    logger: { info: mock(() => {}), error: mock(() => {}) },
    abortFlag: { aborted: false },
    now: () => FIXED_NOW,
  };
}

function mockState(currentStage = 'human-approval'): PipelineState {
  return {
    workItemId: 101,
    slug: 'wi-101',
    startedAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    currentStage,
    history: [],
    attempts: {},
    outputs: {},
  };
}

describe('checkpoint', () => {
  it('passes through when detect resolves true', async () => {
    const stage = checkpoint({
      name: 'human-approval',
      detect: async () => true,
    });
    const next = await stage.execute(mockState(), mockContext());
    expect(next.currentStage).toBe('human-approval');
    // currentStage is left as the checkpoint name; orchestrator advances it
  });

  it('throws PipelinePauseError when detect resolves false and pins currentStage', async () => {
    const stage = checkpoint({
      name: 'human-approval',
      detect: async () => false,
    });
    const initial = mockState('human-approval');
    let caught: unknown;
    try {
      await stage.execute(initial, mockContext());
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PipelinePauseError);
    expect((caught as PipelinePauseError).reason).toContain('human-approval');
    expect(initial.currentStage).toBe('human-approval');
  });

  it('exposes the configured name and a default canRun of true', () => {
    const stage = checkpoint({
      name: 'cp',
      detect: async () => true,
    });
    expect(stage.name).toBe('cp');
    expect(stage.canRun(mockState())).toBe(true);
  });

  it('passes the state and context to the detect function', async () => {
    const detect = mock(async (_s: PipelineState, _ctx: PipelineContext) => true);
    const stage = checkpoint({ name: 'cp', detect });
    const ctx = mockContext();
    const state = mockState();
    await stage.execute(state, ctx);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls[0]?.[0]).toBe(state);
    expect(detect.mock.calls[0]?.[1]).toBe(ctx);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
bun test tests/pipeline/checkpoint.test.ts
```

Expected: FAIL ("Cannot find module ...").

- [ ] **Step 3: Write `src/pipeline/checkpoint.ts`**

```typescript
import type { Stage, PipelineContext } from './stage.ts';
import { PipelinePauseError } from './stage.ts';
import type { PipelineState } from '../types/index.ts';

export interface CheckpointConfig {
  name: string;
  detect: (state: PipelineState, ctx: PipelineContext) => Promise<boolean>;
  rerunCommand?: string;
  timeoutHours?: number;
}

export function checkpoint(cfg: CheckpointConfig): Stage {
  return {
    name: cfg.name,
    canRun: () => true,
    async execute(state, ctx) {
      const cleared = await cfg.detect(state, ctx);
      if (!cleared) {
        state.currentStage = cfg.name;
        throw new PipelinePauseError(
          `checkpoint "${cfg.name}" not yet cleared`,
        );
      }
      return state;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```powershell
bun test tests/pipeline/checkpoint.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```powershell
git add src/pipeline/checkpoint.ts tests/pipeline/checkpoint.test.ts
git commit -m "feat(pipeline): add checkpoint factory with PipelinePauseError"
```

---

## Task 13: End-to-end mock pipeline integration test

**Files:**
- Test: `tests/integration/orchestrator-e2e.test.ts`

This task contains no source changes — only an integration test that composes the factories from Tasks 8–12 into a small pipeline and verifies the whole stack works together.

- [ ] **Step 1: Write the integration test**

```typescript
// tests/integration/orchestrator-e2e.test.ts
import { describe, it, expect, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { z } from 'zod';
import { runPipeline, createInitialState } from '../../src/pipeline/orchestrator.ts';
import { agentStage } from '../../src/pipeline/agent-stage.ts';
import type { AgentRunner } from '../../src/pipeline/agent-stage.ts';
import { revisionLoop } from '../../src/pipeline/revision-loop.ts';
import { checkpoint } from '../../src/pipeline/checkpoint.ts';
import type { PipelineContext, Stage } from '../../src/pipeline/stage.ts';
import { PipelineStateStore } from '../../src/state/state-store.ts';
import type { AppConfig, PipelineState } from '../../src/types/index.ts';

const FIXED_NOW = new Date('2026-05-04T12:00:00.000Z');

function tmpStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'devops-coder-e2e-'));
}

function makeContext(): PipelineContext {
  const config: AppConfig = {
    org: 'o', orgUrl: 'https://dev.azure.com/o', project: 'p', pat: 't',
    targetRepoPath: '/r', worktreeBase: '/w',
    triggerTag: 'agent implement', blockedTag: 'agent-blocked', needInputTag: 'need-input',
    pollIntervalMinutes: 5, concurrency: 1, maxRevisions: 3, maxRejectCycles: 3,
    claudeModel: 'claude-opus-4-7', stateDir: '.state', assignedToFilter: [], dryRun: false,
  };
  return {
    config,
    logger: { info: mock(() => {}), error: mock(() => {}) },
    abortFlag: { aborted: false },
    now: () => FIXED_NOW,
  };
}

const AnalyzerSchema = z.object({
  verdict: z.enum(['proceed', 'reject']),
  taskSummary: z.string().optional(),
});
const CoderSchema = z.object({
  branch: z.string(),
  commitsAhead: z.number(),
});
const ReviewerSchema = z.object({
  verdict: z.enum(['approve', 'revise']),
});

describe('orchestrator end-to-end (mock stages)', () => {
  it('analyzer (proceed) → coder → revisionLoop(coder, reviewer approve) → finalizer', async () => {
    const dir = tmpStateDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();

    const analyzerRunner: AgentRunner = {
      run: mock(async () => ({ verdict: 'proceed', taskSummary: 'add a button' })) as AgentRunner['run'],
    };
    const coderRunner: AgentRunner = {
      run: mock(async () => ({ branch: 'agent/wi-101-add-button', commitsAhead: 1 })) as AgentRunner['run'],
    };
    const reviewerRunner: AgentRunner = {
      run: mock(async () => ({ verdict: 'approve' })) as AgentRunner['run'],
    };

    const analyzer = agentStage(
      {
        name: 'analyzer',
        buildPrompt: (s) => `analyze wi=${s.workItemId}`,
        schema: AnalyzerSchema,
        applyOutput: (s, out) => ({ ...s, outputs: { ...s.outputs, analyzer: out } }),
      },
      analyzerRunner,
    );

    const coder = agentStage(
      {
        name: 'coder',
        buildPrompt: (s) => `implement wi=${s.workItemId}`,
        schema: CoderSchema,
        applyOutput: (s, out) => ({ ...s, outputs: { ...s.outputs, coder: out } }),
      },
      coderRunner,
    );

    const reviewer = agentStage(
      {
        name: 'reviewer',
        buildPrompt: () => 'review',
        schema: ReviewerSchema,
        applyOutput: (s, out) => ({ ...s, outputs: { ...s.outputs, reviewer: out } }),
      },
      reviewerRunner,
    );

    const reviewLoop = revisionLoop({
      name: 'review-loop',
      producer: coder,
      reviewer,
      maxAttempts: 3,
      isApproved: (s) =>
        (s.outputs.reviewer as { verdict?: string } | undefined)?.verdict === 'approve',
    });

    const finalizer: Stage = {
      name: 'finalizer',
      canRun: () => true,
      execute: async (s) => ({ ...s, outputs: { ...s.outputs, finalized: true } }),
    };

    const stages: Stage[] = [analyzer, coder, reviewLoop, finalizer];
    const state = createInitialState(101, 'wi-101', FIXED_NOW);

    const final = await runPipeline({ stages, state, context: ctx, store });

    expect(final.completedAt).toBe(FIXED_NOW.toISOString());
    expect(final.terminalError).toBeUndefined();
    expect((final.outputs.analyzer as { verdict: string }).verdict).toBe('proceed');
    expect((final.outputs.coder as { branch: string }).branch).toBe('agent/wi-101-add-button');
    expect((final.outputs.reviewer as { verdict: string }).verdict).toBe('approve');
    expect(final.outputs.finalized).toBe(true);
    expect(final.history.map((h) => h.stage)).toEqual([
      'analyzer', 'coder', 'review-loop', 'finalizer',
    ]);

    // Persisted state matches
    const persisted = store.load(101)!;
    expect(persisted.completedAt).toBe(FIXED_NOW.toISOString());
  });

  it('checkpoint stage pauses pipeline; second run with cleared checkpoint completes it', async () => {
    const dir = tmpStateDir();
    const store = new PipelineStateStore(dir);
    const ctx = makeContext();

    let approvalGranted = false;
    const approval = checkpoint({
      name: 'human-approval',
      detect: async () => approvalGranted,
    });
    const tail: Stage = {
      name: 'tail',
      canRun: () => true,
      execute: async (s) => ({ ...s, outputs: { ...s.outputs, tailRan: true } }),
    };
    const stages = [approval, tail];

    const state = createInitialState(101, 'wi-101', FIXED_NOW);

    const paused = await runPipeline({ stages, state, context: ctx, store });
    expect(paused.completedAt).toBeUndefined();
    expect(paused.currentStage).toBe('human-approval');
    expect(paused.outputs.tailRan).toBeUndefined();

    // Reload from disk and resume after approval is granted
    approvalGranted = true;
    const reloaded = store.load(101)!;
    const resumed = await runPipeline({
      stages,
      state: reloaded,
      context: makeContext(),
      store,
    });
    expect(resumed.completedAt).toBe(FIXED_NOW.toISOString());
    expect(resumed.outputs.tailRan).toBe(true);
  });
});
```

- [ ] **Step 2: Run the integration test**

```powershell
bun test tests/integration/orchestrator-e2e.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 3: Run the full test suite**

```powershell
bun test
```

Expected: PASS — every test from Tasks 3–13 (logger 4, slug 6, config 8, state-store 11, orchestrator 9, agentStage 4, claude-agent-runner 5, revisionLoop 6, checkpoint 4, e2e 2 = **59 tests**).

- [ ] **Step 4: Run typecheck**

```powershell
bun run typecheck
```

Expected: PASS (no diagnostics).

- [ ] **Step 5: Commit**

```powershell
git add tests/integration/orchestrator-e2e.test.ts
git commit -m "test(integration): add end-to-end mock-stage pipeline test"
```

---

## Task 14: CLI scaffolding (placeholder commands)

**Files:**
- Create: `src/cli/index.ts`

The CLI is a stub at this stage — full commands (`watch`, `run-once`, `run-wi`, `abort-wi`, `replay-wi`) land in later plans alongside the watcher and ADO client. For now we provide `help` and `version` so `bun run start` exits gracefully and the Dockerfile in Task 15 has something to invoke.

- [ ] **Step 1: Write `src/cli/index.ts`**

```typescript
const VERSION = '0.1.0';

function help(): void {
  console.log(`devops-coder v${VERSION}

Usage:
  bun run start         Start the watcher (not yet implemented)
  bun run once          Run a single poll cycle (not yet implemented)
  bun run src/cli/index.ts version
  bun run src/cli/index.ts help

This is a milestone-1/2 skeleton — only 'help' and 'version' are wired.
Other commands print a placeholder and exit 0.
`);
}

const cmd = process.argv[2] ?? 'help';

switch (cmd) {
  case 'help':
  case '--help':
  case '-h':
    help();
    break;
  case 'version':
  case '--version':
  case '-v':
    console.log(VERSION);
    break;
  case 'watch':
  case 'run-once':
    console.log(`[devops-coder] command "${cmd}" is not yet implemented (milestone 1/2 skeleton).`);
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exitCode = 1;
}
```

- [ ] **Step 2: Run `bun run start` and verify it exits cleanly**

```powershell
bun run start
```

Expected: prints the "command 'watch' is not yet implemented" placeholder and exits 0.

- [ ] **Step 3: Verify `bun run src/cli/index.ts version` prints the version**

```powershell
bun run src/cli/index.ts version
```

Expected: prints `0.1.0` and exits 0.

- [ ] **Step 4: Typecheck**

```powershell
bun run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/cli/index.ts
git commit -m "feat(cli): add help/version scaffolding for milestone-1 skeleton"
```

---

## Task 15: Dockerfile + entrypoint.sh

**Files:**
- Create: `Dockerfile`
- Create: `entrypoint.sh`

These mirror `DevOpsInvestigateWorkItems`'s Dockerfile and entrypoint exactly, except for the working directory mount points and the addition of `WORKTREE_BASE` validation.

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
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
```

- [ ] **Step 2: Write `entrypoint.sh`**

```bash
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
```

- [ ] **Step 3: Build the image**

```powershell
docker build -t devops-coder:dev .
```

Expected: build succeeds end-to-end. The final layer adds the entrypoint and the resulting image is tagged `devops-coder:dev`.

> **If you don't have Docker available locally**, skip Step 3 and verify the Dockerfile syntax with `docker build --check` if you have a remote Docker host, or note in the commit message that the build was deferred to CI. Do not skip writing the Dockerfile.

- [ ] **Step 4: Commit**

```powershell
git add Dockerfile entrypoint.sh
git commit -m "feat(docker): add Dockerfile + entrypoint with volume permission fixup"
```

---

## Task 16: Repository docs + final verification

**Files:**
- Modify: `README.md` (currently a 1-line stub)
- Create: `CLAUDE.md`
- Create: `PATTERNS.md`

- [ ] **Step 1: Replace `README.md` with operational documentation**

```markdown
# DevopsCoder

The fifth agent in our Azure DevOps automation suite, and the first that **writes** to the target repo. DevopsCoder picks up work items tagged `agent implement`, runs an analyzer/coder/test-author/reviewer pipeline against a per-WI git worktree, and opens a draft PR.

This repo currently contains the **milestone-1/2 skeleton** — project bootstrap and a generic stage-based pipeline orchestrator. Real stages (analyzer, coder, test-author, reviewer, draft-pr-creator), the ADO REST client, the worktree manager, and the watcher loop land in subsequent plans under `docs/superpowers/plans/`.

## Tech stack

- Bun (TypeScript)
- Zod for env validation and agent-output schemas
- `@anthropic-ai/claude-agent-sdk` for AI calls — `query()` wrapped in an injectable `AgentRunner` interface; production impl in `src/services/claude-agent-runner.ts` extracts JSON and validates against the per-stage Zod schema
- `bun:test` for tests
- Docker (`oven/bun:1`) for deployment

## Commands

| Command | Purpose |
|---------|---------|
| `bun install` | Install dependencies |
| `bun test` | Run the full test suite |
| `bun run typecheck` | TypeScript type checking |
| `bun run start` | Start the watcher (placeholder until the watcher lands) |
| `bun run once` | Single poll cycle (placeholder) |

## Layout

```
src/
  cli/        — CLI entry point
  config/     — Zod env schema + loader
  pipeline/   — Stage interface, orchestrator, agentStage / revisionLoop / checkpoint factories
  services/   — Claude SDK wrapper (claude-agent-runner.ts) — production AgentRunner impl
  state/      — Per-work-item PipelineStateStore
  types/      — Shared types (AppConfig, PipelineState, ...)
  utils/      — Logger, slugify
tests/
  config/, pipeline/, services/, state/, utils/  — unit tests
  integration/                                   — end-to-end mock-stage pipeline test
docs/
  superpowers/plans/                             — implementation plans
```

## Local setup

1. Copy `.env.example` to `.env` and fill in the Azure DevOps PAT, org, project, and `TARGET_REPO_PATH` / `WORKTREE_BASE`.
2. `bun install`
3. `bun test`

## Docker

`docker build -t devops-coder:dev .` produces an image patterned on the sibling agents — `oven/bun:1` base, non-root `claude` user, persistent volumes for `.state` and the Claude Code auth directory. The entrypoint validates `TARGET_REPO_PATH` and `WORKTREE_BASE`, generates `/app/repo-paths.json` from any extra mounts under `/repos/`, and drops to the `claude` user before starting the app.

See `PATTERNS.md` for a quick reference of the architectural patterns used.
```

- [ ] **Step 2: Write `CLAUDE.md`**

```markdown
# CLAUDE.md

Guidance for Claude Code working in this repository.

## Project Overview

DevopsCoder is the implement-tagged work-item pipeline for our Azure DevOps automation suite. It is the first agent that writes to the target repo (branches, commits, push, draft PR). It deploys as a Docker container alongside the existing 4 read-only agents.

The repo is currently at the **milestone-1/2 skeleton** stage: project bootstrap + generic stage-based pipeline orchestrator. Real stages, ADO client, worktree manager, and watcher loop land in subsequent plans (see `docs/superpowers/plans/`).

## Architecture

- **Runtime:** Bun (TypeScript)
- **Validation:** Zod for env config and agent output schemas
- **AI:** `@anthropic-ai/claude-agent-sdk` — `query()` is wrapped in an injectable `AgentRunner` interface (`src/pipeline/agent-stage.ts`). The production runner (`src/services/claude-agent-runner.ts`) instructs the model to return JSON only, extracts the JSON from the streamed `result` message, and validates it against the per-stage Zod schema before handing it to the stage's `applyOutput`. Mirrors `src/services/ai-generator.ts` from `DevOpsPullTemplate`.
- **Testing:** `bun:test`
- **State:** per-work-item JSON files under `.state/{workItemId}.json`
- **Pipeline:** stage-based orchestrator. Each stage is a `Stage` (`name`, `canRun`, `execute`). Three factories compose pipelines: `agentStage`, `revisionLoop`, `checkpoint`.

## Key patterns

- **Dependency injection** via interfaces on every external dep (logger, AgentRunner, state store, ADO client when added).
- **Per-WI state** persisted after every stage transition; a `PipelinePauseError` from a stage signals "halt and wait for human" rather than a terminal error.
- **Test fixtures** built with small factory functions (`makeContext`, `makeState`) and `bun:test`'s `mock(...)`.
- **Conventions:** `.ts` extensions in imports (`verbatimModuleSyntax: true`); `type` imports use the `type` keyword.

## Commands

- `bun test` — run all tests
- `bun run typecheck` — TypeScript type checking
- `bun run start` — start the watcher (placeholder)
- `bun run once` — single poll cycle (placeholder)

## File Layout

- `src/cli/` — CLI entry point
- `src/config/` — Zod env validation
- `src/pipeline/` — Stage interface + orchestrator + factories
- `src/services/` — Claude SDK wrapper (`claude-agent-runner.ts`); future ADO client wrappers and watcher land here too
- `src/state/` — `PipelineStateStore`
- `src/types/` — shared interfaces
- `src/utils/` — logger, slugify
- `tests/` — mirrors `src/` layout; `tests/integration/` for cross-cutting tests

## Out of scope (do not introduce)

- Plan-stage / human plan-approval gate
- Self-research analyzer mode
- Multi-target-repo support
- Migration of the existing 4 agents
- Test-suggestion functionality (lives in the separate `DevopsTestSuggester` repo)

## Sibling references

`C:\GeneralDev\DevOpsPullers\DevOpsInvestigateWorkItems` — closest sibling. Mirror its file layout and patterns. Reimplement, don't import.
`C:\GeneralDev\DevOpsPullers\DevOpsCodeReviewer` — for the parallel-subagent review fan-out (used by the reviewer stage in a later plan).
```

- [ ] **Step 3: Write `PATTERNS.md`**

```markdown
# Patterns Reference

Quick reference for the patterns used in this repo. Each links to the source file where it's implemented.

## Zod Config Validation

**File:** `src/config/index.ts`

Env variables are validated at startup using a Zod schema. Required vars throw a descriptive `Invalid configuration:\n  - field: message` error. Optional vars use `.default(...)`. Numeric vars use `.coerce.number()`. `loadConfig()` accepts an optional `env` parameter for testing.

## Per-Work-Item State Store

**File:** `src/state/state-store.ts`

`PipelineStateStore` persists one JSON file per work item under `STATE_DIR`. `save()` updates `updatedAt` on every write. `listResumable()` filters out completed, terminal-failed, and cancelled states — used by the watcher (in a later plan) for crash recovery.

## Stage Interface

**File:** `src/pipeline/stage.ts`

A `Stage` is `{ name, canRun(state), execute(state, ctx) }`. `PipelineContext` carries the shared `config`, `logger`, `abortFlag`, and `now()` accessor. `PipelinePauseError` is the sentinel for "halt and wait for human" — distinct from a thrown `Error`, which the orchestrator records as a terminal failure.

## Pipeline Orchestrator

**File:** `src/pipeline/orchestrator.ts`

`runPipeline({ stages, state, context, store })` iterates stages in order. After each `execute()` it appends a history entry, increments `attempts[stage.name]`, and persists state via the store. `PipelinePauseError` is caught and turned into a `pause` outcome that exits cleanly — no terminal error. Other thrown errors become a terminal-error record and re-throw.

## agentStage Factory

**File:** `src/pipeline/agent-stage.ts`

Wraps a Claude SDK call into a `Stage`. The factory is parameterised by an `AgentRunner` interface (`run<T>({ prompt, schema, tools?, model? })`), keeping the Claude SDK boundary thin and tests trivial — pass a mock runner that returns the parsed shape.

## Production AgentRunner (Claude SDK wrapper)

**File:** `src/services/claude-agent-runner.ts`

`createClaudeAgentRunner({ config, logger })` returns an `AgentRunner` that calls `query()` from `@anthropic-ai/claude-agent-sdk` with `permissionMode: 'bypassPermissions'`, streams the messages, logs cost/tokens on each `result`, then runs `extractJson()` + `JSON.parse` + `schema.safeParse()` on the final text. `extractJson()` strips ` ```json ` fences and surrounding prose. `AgentOutputParseError` carries the raw model output so the caller can attach it to the work item if useful. Pattern mirrors `src/services/ai-generator.ts` in `DevOpsPullTemplate`; only the pure `extractJson` helper is unit-tested.

## revisionLoop Factory

**File:** `src/pipeline/revision-loop.ts`

Pairs a producer stage with a reviewer stage and loops up to `maxAttempts`. `isApproved(state)` is the success predicate. Optional `onExhausted` hook lets the caller post a comment / set a tag when the loop runs out of attempts.

## checkpoint Factory

**File:** `src/pipeline/checkpoint.ts`

A `Stage` whose `detect()` returns whether a human-action gate has cleared. If not cleared, throws `PipelinePauseError` to halt the pipeline; on the next run the orchestrator resumes from the same checkpoint and re-runs `detect()`.

## Logger

**File:** `src/utils/logger.ts`

`createLogger(prefix?)` returns `{ info, error }`. Every line is prefixed with an ISO-second timestamp; `error()` appends `:: <message>` if an `Error`/value is passed.

## Slug

**File:** `src/utils/slug.ts`

`slugify(input, maxLen=40)` for branch names. Lowercases, replaces non-alnum with `-`, trims hyphens, truncates and re-trims. Falls back to `'wi'` for inputs with no alphanumerics.

## Test fixtures

**Convention:** small factory functions (`makeContext`, `makeState`, `mockState`) per test file; `bun:test`'s `mock()` for stub functions; `mkdtempSync(join(tmpdir(), 'prefix-'))` for filesystem fixtures. No global mocking, no module mocking.
```

- [ ] **Step 4: Run final verification — full test suite**

```powershell
bun test
```

Expected: PASS, 59 tests across 10 test files.

- [ ] **Step 5: Run final typecheck**

```powershell
bun run typecheck
```

Expected: PASS, no diagnostics.

- [ ] **Step 6: (If Docker available) re-verify the build**

```powershell
docker build -t devops-coder:dev .
```

Expected: image rebuilds successfully, smaller delta this time because of the layer cache.

- [ ] **Step 7: Confirm `git status` is clean**

```powershell
git status
```

Expected: `nothing to commit, working tree clean` (after the next commit).

- [ ] **Step 8: Commit docs**

```powershell
git add README.md CLAUDE.md PATTERNS.md
git commit -m "docs: add README, CLAUDE.md, PATTERNS.md for milestone-1/2 skeleton"
```

- [ ] **Step 9: Verify final state matches the plan's deliverables**

Run, in order:

```powershell
bun install
bun run typecheck
bun test
```

Each must exit 0. Output of `bun test` must show **59 tests passing across 10 files**: `tests/utils/logger.test.ts` (4), `tests/utils/slug.test.ts` (6), `tests/config/config.test.ts` (8), `tests/state/state-store.test.ts` (11), `tests/pipeline/orchestrator.test.ts` (9), `tests/pipeline/agent-stage.test.ts` (4), `tests/services/claude-agent-runner.test.ts` (5), `tests/pipeline/revision-loop.test.ts` (6), `tests/pipeline/checkpoint.test.ts` (4), `tests/integration/orchestrator-e2e.test.ts` (2).

If any of these fail, do **not** mark the plan complete — debug the failure first (use systematic-debugging) and fix the root cause before committing.

---

## Plan-completion checklist

After Task 16 you should have:

- [ ] `package.json`, `tsconfig.json`, `.gitignore`, `.dockerignore`, `.env.example` in repo root
- [ ] `Dockerfile` and `entrypoint.sh` in repo root, build verified (or noted as deferred to CI)
- [ ] `README.md`, `CLAUDE.md`, `PATTERNS.md` in repo root
- [ ] Full `src/` tree (`cli/`, `config/`, `pipeline/`, `services/`, `state/`, `types/`, `utils/`)
- [ ] Full `tests/` tree mirroring `src/`, plus `tests/integration/` and `tests/setup.ts`
- [ ] `bun test` green — 59 tests passing
- [ ] `bun run typecheck` green
- [ ] Stage interface with `canRun` / `execute` semantics
- [ ] `runPipeline` orchestrator with persistence, pause, abort, and resume
- [ ] `agentStage`, `revisionLoop`, `checkpoint` factories
- [ ] Production `createClaudeAgentRunner` wrapping `query()` from `@anthropic-ai/claude-agent-sdk` with JSON extraction + Zod validation
- [ ] Per-WI `PipelineStateStore` with `load` / `save` / `delete` / `listAll` / `listResumable`
- [ ] An end-to-end integration test exercising the whole stack on mock stages

## What's next (later plans)

- **Plan 2:** ADO REST client (work items, comments, tags, PRs) — patterned on `DevOpsInvestigateWorkItems`'s `azure-devops-client.ts`
- **Plan 3:** Worktree manager (`worktree.ts`) — `git worktree add/remove/list`, crash-recovery scan
- **Plan 4:** Real analyzer stage end-to-end against a live work item
- **Plan 5:** Coder + test-author + reviewer + revisionLoop wired with real Claude calls
- **Plan 6:** draft-pr-creator
- **Plan 7:** Watcher loop + concurrency pool + docker-compose integration
