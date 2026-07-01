# Agent Architecture

**Version:** 1.0  
**Date:** 2026-05-06  
**Applies to:** KageOps v2.3+

---

## Overview

Every KageOps agent (Scout, Blueprint, Forge, Vigil, Pixel, Cipher, Aegis, Herald) is built from the same pattern: a TypeScript class that extends `AutonautAgent`, the abstract base class defined in [src/agents/autonaut-agent.ts](../../src/agents/autonaut-agent.ts).

The base class provides all infrastructure — AI calls, file I/O, git, event bus, budget enforcement, safety — and leaves exactly one method for each specialist to implement: `executeTask()`.

```
┌─────────────────────────────────────────────────────────┐
│                     AutonautAgent                        │
│              (Abstract Base Class)                       │
│                                                         │
│  IDENTITY          TOOLS              SAFETY            │
│  ─────────         ─────              ──────            │
│  name              askAI()            Budget enforcer   │
│  role              readFile()         Shell allowlist   │
│  skills[]          writeFile()        Path traversal    │
│  systemPrompt      executeCommand()   Security scanner  │
│  modelConfig       gitCommit()        Loop detector     │
│                    webResearch()      Task timeout      │
│                    publishEvent()                       │
│                    reportProgress()                     │
│                                                         │
│  abstract executeTask(task): Promise<void>  ← YOU FILL  │
└─────────────────────────────────────────────────────────┘
                         ▲
          extends (each specialist)
                         │
    ┌────────┬───────────┼──────────┬──────────┐
    │        │           │          │          │
  Scout  Blueprint     Forge      Vigil     Herald  ...
```

---

## The 5 Building Blocks

Every agent is built from five things. Three are defined in the specialist file; two are inherited from the base class.

### 1. Identity (constructor arguments)

```typescript
// src/agents/specialists/scout.ts
constructor(modelConfig: AgentModelConfig) {
    super('scout', 'strategist', SCOUT_SKILLS, modelConfig, SYSTEM_PROMPT);
    //    name     role          skills[]       AI config    personality
}
```

| Field | Purpose |
|---|---|
| `name` | Unique identifier; used in event routing, DB logs, and branch names |
| `role` | Broad category (engineer, strategist, designer…) |
| `skills[]` | Task types this agent can handle; used by Sensei's task router |
| `modelConfig` | Which AI model to use, temperature, max tokens |
| `systemPrompt` | The agent's personality and behavioral instructions |

### 2. System Prompt — the agent's "soul"

A short, focused string that shapes every AI response this agent produces:

```typescript
// Scout — strategic analyst
const SYSTEM_PROMPT =
    'You are Scout, a strategic analyst and product manager. You research thoroughly, ' +
    'write clearly, and make evidence-based recommendations. Your outputs are well-structured ' +
    'markdown documents with clear headings, data tables, and actionable conclusions.';

// Forge — engineer
const SYSTEM_PROMPT =
    'You are Forge, a senior full-stack engineer. You write clean, tested, production-ready code. ' +
    'You follow the project\'s coding standards and always run tests before committing.';
```

### 3. Skills List — what it knows

A `const` array used by Sensei when routing tasks. Agents will only receive tasks that match entries in this list (via the speciality matrix scores):

```typescript
const SCOUT_SKILLS = [
    'market-research', 'competitive-analysis', 'prd-writing',
    'requirements-gathering', 'feasibility-assessment', 'project-planning',
] as const;

const FORGE_SKILLS = [
    'typescript', 'javascript', 'python', 'react-nextjs',
    'nodejs', 'api-development', 'database-queries', 'testing',
] as const;
```

### 4. `executeTask()` — the specialist's brain

The **only abstract method** every specialist must implement. The base class calls it after setting up the git branch, resetting counters, and starting the task timeout.

```typescript
// Scout: decide which document to write, call AI, write file
async executeTask(task: TaskInfo): Promise<void> {
    this._webContext = await this.gatherWebContext(task);
    switch (task.taskType) {
        case 'prd':                  await this.writePrd(task);                  break;
        case 'market-research':      await this.writeMarketResearch(task);       break;
        case 'competitive-analysis': await this.writeCompetitiveAnalysis(task);  break;
        default:                     await this.handleGenericTask(task);
    }
}

// Forge: full TDD loop per task
async executeTask(task: TaskInfo): Promise<void> {
    switch (task.taskType) {
        case 'implement':
            await this.implementFeature(task);  // RED → GREEN → IMPROVE → commit
            break;
        case 'setup-project':
            await this.setupProject(task);
            break;
    }
}
```

### 5. Inherited Tools (free from the base class)

Specialists don't implement these — they just call them:

| Method | What it does |
|---|---|
| `askAI(prompt, context?)` | Calls the AI model; enforces budget, call caps, loop detection |
| `readFile(repoPath, filePath)` | Reads a file scoped to the project repo |
| `writeFile(repoPath, filePath, content)` | Writes a file; runs security scanner + output sanitizer |
| `executeCommand(task, cmd, args)` | Runs an allowlisted shell command (npm, git, tsc, vitest…) |
| `gitCommit(repoPath, message)` | Stages all changes and commits |
| `reportProgress(task, message)` | Sends a live status update to the UI via the event bus |
| `publishEvent(channel, data)` | Emits an event (e.g. `review.passed`) that Sensei can react to |
| `webResearch(url)` | Scrapes a URL and returns markdown content |

---

## Task Lifecycle

What happens from the moment Sensei assigns a task to when it's marked complete:

```
Sensei publishes "task.assigned" on event bus
           │
           ▼
AutonautAgent.onTaskAssigned()       ← base class
    │
    ├─ Load task row from DB
    ├─ Create git branch: task/<agent>-<taskId>
    ├─ Reset per-task state (loop detector, evidence, AI call counter)
    │
    ▼
agent.executeTask(task)              ← specialist code
    │
    ├─ Scout:  research → askAI() → writeFile(markdown)
    ├─ Forge:  RED (tests) → GREEN (impl) → IMPROVE → gitCommit()
    ├─ Vigil:  lint → test → security scan → publishEvent('review.passed')
    └─ Pixel:  design → askAI() → writeFile(HTML/CSS)
    │
    ▼
Base class wraps up:
    ├─ Write AI response text to tasks.response_text
    ├─ Run verification checks (files written? tests passed?)
    ├─ UPDATE tasks SET status = 'completed'
    └─ Publish "task.completed" → Sensei routes next task
```

If the task throws at any point, the base class catches it, marks the task `failed`, and publishes `task.failed` — the specialist never needs to handle this.

---

## How Two Agents Compare

```
Scout (writes documents)               Forge (writes code with TDD)
────────────────────────               ─────────────────────────────
executeTask():                         executeTask():
  await gatherWebContext()               if static HTML → shortcut path
  switch(taskType):                      switch(taskType):
    case 'prd':                            case 'implement':
      prompt = buildPrdPrompt(task)          RED  = await askAI(buildRedPrompt)
      response = await askAI(prompt)         writeFile(tests)
      await writeOutputFiles(response)       GREEN = await askAI(buildGreenPrompt)
                                             writeFile(impl)
                                             executeCommand('npm', ['test'])
                                             IMPROVE = await askAI(buildImprovePrompt)
                                             gitCommit('feat: ' + task.title)
```

---

## Safety Nets

These run automatically inside the base class. Specialists don't see them but rely on them.

### Inside every `askAI()` call

| Guard | What it does |
|---|---|
| Budget check | Throws `BudgetExceededError` if the project has exceeded its cost cap |
| Per-task call cap | Aborts if `askAI()` is called more than 8× for one task (`KAGEOPS_MAX_AI_CALLS_PER_TASK`) |
| Haiku guard | Rejects prompts >10k tokens on Haiku models (cost bleed prevention) |
| Loop detector | Watches for the same action 3× in a 5-action window; warns and can abort |
| Skill augmentation | Optionally injects relevant skill docs into the system prompt (`KAGEOPS_SKILLS_HOOKS=true`) |
| Pause/intercept | Yields at every AI call; a human can pause, inject guidance, or take over |

### Inside every `writeFile()` call

| Guard | What it does |
|---|---|
| Path traversal check | Resolves the full path and ensures it stays inside `task.repoPath` |
| Security scanner | Flags hardcoded secrets, injection patterns, dangerous API usage |
| Output sanitizer | Strips markdown code fences, BOM, zero-width chars, smart quotes |

### Shell execution (`executeCommand`)

Only commands on an explicit allowlist can be spawned:

```
npm  node  git  tsc  eslint  vitest  jest  docker  terraform  npx  pnpm  yarn
```

Arguments are also checked against a blocklist (e.g. `rm -rf /`, `format C:`, `shutdown`).

---

## Creating a New Agent

To add an agent to KageOps:

1. Create `src/agents/specialists/<name>.ts`
2. Extend `AutonautAgent` and call `super()` with identity fields
3. Implement `executeTask(task: TaskInfo): Promise<void>`
4. Use the inherited tools (`askAI`, `writeFile`, `executeCommand`, etc.) — do not re-implement them
5. Register the agent in `src/agents/agent-registry.ts`

Minimal skeleton:

```typescript
import { AutonautAgent, TaskInfo, AgentModelConfig } from '../autonaut-agent';

const SKILLS = ['your-skill-1', 'your-skill-2'] as const;

const SYSTEM_PROMPT =
    'You are MyAgent, a specialist in X. You do Y with Z quality.';

export class MyAgent extends AutonautAgent {
    constructor(modelConfig: AgentModelConfig) {
        super('myagent', 'my-role', SKILLS, modelConfig, SYSTEM_PROMPT);
    }

    async executeTask(task: TaskInfo): Promise<void> {
        await this.reportProgress(task, 'Starting...');
        const response = await this.askAI(task.description);
        await this.writeOutputFiles(task, response.text);
        await this.gitCommit(task.repoPath, `feat: ${task.title}`);
    }
}
```

---

## Related Documents

- [Architecture Overview](architecture.md) — full system architecture
- [Decision Register](decision-register.md) — locked architectural decisions
- [src/agents/autonaut-agent.ts](../../src/agents/autonaut-agent.ts) — base class source
- [src/agents/specialists/](../../src/agents/specialists/) — all specialist implementations
