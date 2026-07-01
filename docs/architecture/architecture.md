# KageOps - System Architecture Document

**Version:** 3.0.0
**Date:** 2026-05-06
**Status:** Decisions #57–#61 locked. Phase 3.0 direction: Auth gateway (Clerk), Stripe billing, Enterprise SSO (Entra ID / Okta / SAML), Team collaboration (human task claiming, comments, project assignments), Communication connectors (Slack, Discord, MS Teams). Active branch: `feat/auth-team-collaboration`.
**Domains:** kageops.ai | kageops.dev

---

## 1. Vision & Overview

**KageOps** is a multi-agent orchestration platform that takes ideas from concept to finished product. Built as a desktop application with ninja-themed AI agents (the **Autonauts**), coordinated by an orchestrator (**Sensei**) and human oversight, accessed through the Command Center.

**Brand hierarchy:**
- **KageOps** — the platform (the product users install)
- **Sensei** — orchestrator (never does task work directly; reachable from the Command Center)
- **Autonauts** — the 8-agent team (Scout, Blueprint, Pixel, Forge, Cipher, Aegis, Vigil, Herald)

**Core principles:**
- **Local-first, privacy-respecting** — all data stays on your machine by default
- **Human-in-the-loop** — configurable autonomy with approval gates
- **Idea to product** — full lifecycle from discovery to deployed, tested, documented product
- **Future-proof** — designed for scale, Azure cloud burst, and extensibility
- **Agent specialization** — fewer agents with broader skills, scored by a living speciality matrix
- **Team-native** — humans and agents share the same task board; humans can claim, comment, and approve

---

## 1a. Identity & Monetisation Architecture (v3.0)

```
User opens KageOps
  │
  ▼
Auth Window (Clerk)
  ├─ Email / password / magic link
  ├─ Google OAuth / GitHub OAuth
  └─ Enterprise SSO → MS Entra ID / Okta / Google WS (SAML 2.0 or OIDC)
  │
  ▼  JWT with { plan, org_id, org_role }
Plan Selection (first login) → Stripe Checkout (in browser)
  │       Stripe webhook → Vercel Function → Clerk publicMetadata.plan
  ▼
Command Center (plan-gated)
  ├─ Free: 1 project, 20 runs/mo
  ├─ Starter ($12/mo): unlimited projects, no team
  ├─ Team ($49/mo, 5 seats): project assignments, SSO, APO, connectors
  └─ Enterprise ($149/mo): unlimited seats, custom SSO, self-hosted Docker
```

**Key components:**
- `src/main/auth-window.ts` — BrowserWindow for sign-in/sign-up
- `src/renderer/auth/` — Clerk SDK UI (vanilla TS, no React)
- `src/shared/plan-gate.ts` — feature flag map keyed on plan tier
- `src/connectors/` — Slack / Discord / MS Teams outbound event connectors
- `api.kageops.ai/webhooks/stripe` — Vercel Function (Stripe → Clerk sync)

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    COMMAND CENTER                             │
│              (Electron + Optional Web Dashboard)             │
│                                                              │
│  ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│  │  Mission    │ │ Chat     │ │ Kanban   │ │ IDE-style   │  │
│  │  Control    │ │ First    │ │ Board    │ │ View        │  │
│  │  (default)  │ │          │ │          │ │             │  │
│  └────────────┘ └──────────┘ └──────────┘ └─────────────┘  │
│                                                              │
│  Components: Agent Feed | Phase Timeline | Agent Chat        │
│  Sensei Chat | Kanban | Speciality Matrix | Build Status     │
│  Cost Tracker | Approval Queue (with details) | Notifications│
│  Orchestration Flow Graph | Phase Graph | Config Panel       │
│  Model Routing | Deployments | Team Members | Agent Mgmt     │
│  Document Upload | Cost Intelligence | Code Graph            │
│  Agent Intercept (v2.3): Live Stream | Pause/Resume |        │
│  Takeover/Handback | Guidance Injection                      │
│  Live HUD: events/min | live spend | latest activity        │
│  Status Bar: DB | Orchestrator | active agents | projects    │
└──────────────────────────┬───────────────────────────────────┘
                           │ Electron IPC / WebSocket
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                      SENSEI (Orchestrator)                    │
│                                                              │
│  Responsibilities:                                           │
│  • Task decomposition & routing (via speciality matrix)      │
│  • Agent benchmarking & matrix updates                       │
│  • Build/deploy/pipeline monitoring                          │
│  • Cross-project communication                               │
│  • External comms (Teams, Email, SMS)                      │
│  • Approval gate enforcement                                 │
│  • Trust level management                                    │
│  • Event bus monitoring & override                           │
│  • Reporting & daily summaries                               │
│                                                              │
│  Model: Configurable (Claude Opus/Sonnet, GPT, local Ollama) │
└──────────────────────────┬───────────────────────────────────┘
                           │
              ┌────────────┼────────────────┐
              │      EVENT BUS              │
              │  (Postgres LISTEN/NOTIFY)   │
              │                             │
              │  Events: task.created,      │
              │  task.completed,            │
              │  review.requested,          │
              │  approval.required,         │
              │  build.failed, etc.         │
              └────────────┬────────────────┘
                           │
        ┌──────┬───────┬───┴───┬───────┬───────┬───────┬──────┐
        │      │       │       │       │       │       │      │
    ┌───▼──┐┌──▼──┐┌───▼──┐┌──▼──┐┌───▼──┐┌───▼──┐┌──▼──┐┌──▼──┐
    │Scout ││Blue-││Pixel ││Forge││Cipher││Aegis ││Vigil││Hera-│
    │      ││print││      ││     ││      ││      ││     ││ld   │
    │Strat-││Arch-││Desig-││Engi-││Data  ││Plat- ││Qual-││Mark-│
    │egist ││itect││ner   ││neer ││Spec. ││form  ││ity  ││eter │
    └───┬──┘└──┬──┘└───┬──┘└──┬──┘└───┬──┘└──┬───┘└──┬──┘└──┬──┘
        │      │       │      │       │      │       │      │
        └──────┴───────┴──────┴───────┴──────┴───────┴──────┘
                           │
              ┌────────────┼────────────────┐
              │                             │
    ┌─────────▼─────────┐    ┌──────────────▼──────────────┐
    │   POSTGRES +       │    │   GIT REPOS                 │
    │   PGVECTOR         │    │                             │
    │                    │    │   template/  (golden)       │
    │   • projects       │    │   projects/                 │
    │   • tasks          │    │     ├── sales-dashboard/    │
    │   • agent_logs     │    │     ├── mobile-app/         │
    │   • decisions      │    │     └── data-pipeline/      │
    │   • speciality_    │    │   shared/                   │
    │     matrix         │    │     ├── autonauts-utils/    │
    │   • comms_queue    │    │     └── autonauts-ui/       │
    │   • build_status   │    │                             │
    │   • doc_embeddings │    │                             │
    │   • code_summaries │    │                             │
    └────────────────────┘    └─────────────────────────────┘
```

---

## 3. Product Lifecycle (6 Phases)

Every project follows this lifecycle. Phase gates are configurable — can be manual approval or auto-approved based on trust level.

```
┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────┐
│  Phase 1  │───▶│  Phase 2  │───▶│  Phase 3  │───▶│  Phase 4  │───▶│  Phase 5  │───▶│  Phase 6  │
│ Discovery │    │   POC     │    │ Business  │    │ Design &  │    │Development│    │ Launch &  │
│           │    │           │    │ Viability │    │ Planning  │    │           │    │ Growth    │
└───────────┘    └───────────┘    └───────────┘    └─────┬─────┘    └───────────┘    └───────────┘
                                                         │
                                                    ★ AUTONOMOUS
                                                      TOGGLE ★
                                                  (After approval,
                                                   can auto-proceed
                                                   through 5 & 6)
```

### Phase 1: Discovery & Idea Initiation
- **Primary agents:** Scout (strategy), Blueprint (feasibility)
- **Outputs:** Concept brief, market research report, feasibility assessment
- **Gate:** Human approves idea viability before investing in POC

### Phase 2: Proof of Concept
- **Primary agents:** Forge (code), Blueprint (architecture), Cipher (data)
- **Outputs:** Minimal viable POC, technical validation report
- **Gate:** Human reviews POC, decides go/no-go

### Phase 3: Business Viability Analysis
- **Primary agents:** Scout (competitive/financial), Herald (market positioning)
- **Outputs:** Competitive analysis, financial projections, risk assessment, ROI evaluation
- **Gate:** Human approves business case

### Phase 4: Design & Planning
- **Primary agents:** Scout (requirements), Pixel (UX), Blueprint (architecture), all agents (planning)
- **Outputs:** PRD, wireframes/mockups, system architecture, tech stack decision, project plan with milestones
- **Gate:** Human approves design. Option to toggle autonomous mode for remaining phases.

### Phase 5: Development & Execution
- **Primary agents:** Forge (code), Cipher (data), Aegis (infra), Vigil (QA), Pixel (UI implementation)
- **Outputs:** Working software, test suites, infrastructure code, deployment configs
- **Gate:** Two automated gates run after all development tasks complete, then human approval (or auto-approve if autonomous):
  1. **BuildVerificationGate** — runs `npm install`, `npm run build`, `npm test` in the project repo. Skips intelligently for static-only projects (no `package.json`) and scaffolds that declare `build: "tsc"` without any `.ts` sources. Windows uses `npm.cmd` with `shell:true`. Includes polyfills for missing jsdom browser APIs (`matchMedia`, `IntersectionObserver`, `ResizeObserver`, `requestAnimationFrame`) to prevent false-positive runtime violations in gate-environment code that doesn't reflect real browser bugs.
  2. **AcceptanceGate** — deterministic spec-fidelity check with two-tier severity rules. Extracts required HTML element IDs from `project.description` and verifies each appears in the produced `index.html`. Rules marked `MUST` block phase advancement; rules marked `SHOULD` emit warnings but do not block. On failure, Sensei creates an `acceptance-fix` task for Forge (max 2 retries). During retry loop, the best-known violation state is tracked per project; whenever violations decrease, workspace HEAD is tagged `agent/forge/best-attempt`. On retry exhaustion, workspace is restored to the best tag before human escalation, guaranteeing final review always sees the best attempt.
  - Both gates run independently — a build failure must never hide a spec violation, and vice versa.

### Phase 6: Launch & Growth
- **Primary agents:** Aegis (deploy), Vigil (monitoring), Herald (go-to-market), Scout (KPIs)
- **Outputs:** Deployed product, monitoring dashboards, marketing materials, performance reports
- **Gate:** Human approves production deployment

---

## 4. Agent Roster

### 4.1 Agent Overview

| # | Name | Role | Headband | Item | AI Model |
|---|------|------|----------|------|----------|
| 0 | **Sensei** | Orchestrator | White | Scroll | Configurable (recommended: strongest available) |
| 1 | **Scout** | Strategist | Green | Spyglass | Configurable per task |
| 2 | **Blueprint** | Architect | Silver | Compass | Configurable per task |
| 3 | **Pixel** | Designer | Pink | Paintbrush | Configurable per task |
| 4 | **Forge** | Engineer | Orange | Hammer | Configurable per task |
| 5 | **Cipher** | Data Specialist | Cyan | Data streams | Configurable per task |
| 6 | **Aegis** | Platform Engineer | Navy | Shield | Configurable per task |
| 7 | **Vigil** | Quality Guardian | Gold | Magnifying glass | Configurable per task |
| 8 | **Herald** | Marketer | Red | Megaphone | Configurable per task |

### 4.2 Sensei (Orchestrator) — Detailed

Sensei is a separate, unbiased system component. Never performs task work directly.

**Core responsibilities:**
- Decomposes ideas into tasks with dependencies
- Routes tasks to agents using the speciality matrix
- Benchmarks agents periodically (test tasks, scores output quality)
- Updates speciality matrix based on benchmark results and real task outcomes
- Monitors builds, deployments, pipelines in real-time
- Manages cross-project awareness (knows what's happening across all active projects)
- External communications: Teams messages, Outlook emails, SMS alerts (Azure Communication Services)
- Enforces approval gates based on project trust level
- Resolves agent conflicts (e.g., architecture disagreements)
- Provides daily/weekly status summaries to human
- Supervises agent output quality in real-time, flags concerns

### 4.3 Agent Speciality Matrix

A living scoring matrix maintained by Sensei. Scores range 0-9 per skill per agent.

**Example matrix:**

| Skill | Scout | Blueprint | Pixel | Forge | Cipher | Aegis | Vigil | Herald |
|-------|-------|-----------|-------|-------|--------|-------|-------|--------|
| React/Next.js | 2 | 4 | 6 | 9 | 1 | 3 | 6 | 1 |
| Spark/Databricks | 1 | 3 | 0 | 3 | 9 | 2 | 4 | 0 |
| Terraform/IaC | 0 | 5 | 0 | 2 | 1 | 9 | 5 | 0 |
| PRD Writing | 9 | 3 | 2 | 1 | 1 | 0 | 5 | 3 |
| UI Wireframing | 3 | 2 | 9 | 3 | 0 | 0 | 4 | 2 |
| API Design | 4 | 8 | 1 | 9 | 3 | 3 | 6 | 0 |
| Security Review | 1 | 5 | 0 | 5 | 2 | 6 | 9 | 0 |
| Marketing Copy | 2 | 0 | 3 | 0 | 0 | 0 | 3 | 9 |

**Matrix maintenance:**
- Initialized with sensible defaults
- Benchmarked periodically: Sensei gives agents test tasks, scores output
- Updated after real tasks: success/failure rates tracked per skill
- Gaps flagged: "No agent scores above 4 on mobile development"
- Used by Sensei for routing: highest-scoring agent for the task gets assigned

---

## 5. AI Model Strategy

### 5.1 Provider Support

| Provider | Type | Cost | Privacy | Agentic? |
|----------|------|------|---------|----------|
| Claude (API/CLI) | Cloud | Paid per token | Cloud-processed | Yes — full file/terminal access |
| OpenRouter | Cloud marketplace | Paid per token (varies by model) | Cloud-processed | Depends on model |
| Ollama | Local | Free | 100% local | Chat only (no file access) |
| GPT (OpenAI) | Cloud | Paid per token | Cloud-processed | Via Codex CLI |
| Gemini (Google) | Cloud | Paid per token | Cloud-processed | Via Gemini CLI |

### 5.2 Model Assignment

- Each agent role has a configurable model selector
- Sensei recommends optimal model per task based on:
  - Task complexity
  - Required capabilities (agentic vs chat)
  - Cost budget
  - Privacy requirements
- Human validates Sensei's recommendation, can override, then approves
- Configuration stored per-project in `.autonauts/agent-config.json`

### 5.3 Provider Quirks & Adaptation

- **OpenAI adapter (GPT-5, o1/o3/o4/gpt-6):** These reasoning models reject custom temperature values and only accept the default (1.0). The adapter automatically omits the `temperature` field for these model families, mirroring the existing `max_completion_tokens` → `max_completion_tokens` field rename logic.

---

## 6. Data Architecture

### 6.1 Three-Layer Storage

```
┌─────────────────────────────────────────────────────────────┐
│                    LAYER 1: GIT (per project)               │
│                                                             │
│   Code, documents, PRDs, specs, architecture docs,          │
│   designs, tests, infrastructure code, marketing assets     │
│   Audit trail via git history (commits, blame, diff)        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│          LAYER 2: POSTGRES + PGVECTOR (cross-project)       │
│                                                             │
│   Structured Data:                                          │
│   ├── projects          (all active projects)               │
│   ├── tasks             (breakdown, status, assignee, deps) │
│   ├── agent_logs        (actions, timestamps, quality)      │
│   ├── decisions         (ADRs, approvals, rejections)       │
│   ├── speciality_matrix (skill scores, benchmarks)          │
│   ├── comms_queue       (Teams, email, SMS pending)       │
│   └── build_status      (CI/CD pipeline state)              │
│                                                             │
│   Vector Data (pgvector):                                   │
│   ├── doc_embeddings    (chunked project docs)              │
│   ├── decision_embeddings (architecture decisions)          │
│   └── code_summaries    (module/function summaries)         │
│                                                             │
│   Full-Text Search:                                         │
│   └── tsvector indexes on docs, logs, decisions             │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│            LAYER 3: EMBEDDING PIPELINE (Ollama)             │
│                                                             │
│   • Watches git repos for file changes                      │
│   • Chunks and embeds documents via local Ollama model      │
│   • Stores vectors in Postgres pgvector tables              │
│   • Enables Sensei semantic search:                         │
│     "What did we decide about authentication?"              │
│     → finds relevant ADR without knowing exact file path    │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Database Schema (Core Tables)

```sql
-- Projects
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    repo_path TEXT NOT NULL,
    phase TEXT NOT NULL DEFAULT 'discovery',
    trust_level TEXT NOT NULL DEFAULT 'low',  -- low, medium, high
    autonomous_after_design BOOLEAN DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tasks
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    title TEXT NOT NULL,
    description TEXT,
    phase TEXT NOT NULL,
    assigned_agent TEXT,  -- sensei, scout, blueprint, etc.
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER DEFAULT 0,
    depends_on UUID[],
    output_path TEXT,  -- path in git repo to output artifact
    quality_score NUMERIC(3,1),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- Agent Logs
CREATE TABLE agent_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    task_id UUID REFERENCES tasks(id),
    agent TEXT NOT NULL,
    action TEXT NOT NULL,
    model_used TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd NUMERIC(10,6),
    quality_score NUMERIC(3,1),
    duration_ms INTEGER,
    output_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Speciality Matrix
CREATE TABLE speciality_matrix (
    agent TEXT NOT NULL,
    skill TEXT NOT NULL,
    score NUMERIC(3,1) NOT NULL DEFAULT 5.0,
    benchmark_count INTEGER DEFAULT 0,
    last_benchmarked TIMESTAMPTZ,
    PRIMARY KEY (agent, skill)
);

-- Decisions (Architecture Decision Records)
CREATE TABLE decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    title TEXT NOT NULL,
    context TEXT,
    decision TEXT NOT NULL,
    alternatives TEXT,
    consequences TEXT,
    status TEXT NOT NULL DEFAULT 'proposed',  -- proposed, approved, rejected
    decided_by TEXT,  -- human or agent name
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Communication Queue
CREATE TABLE comms_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    channel TEXT NOT NULL,  -- teams, slack, email
    recipient TEXT,
    subject TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Build Status
CREATE TABLE build_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    pipeline TEXT NOT NULL,  -- github-actions, azure-pipelines
    run_id TEXT,
    status TEXT NOT NULL,
    branch TEXT,
    commit_sha TEXT,
    url TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vector Embeddings (pgvector)
CREATE TABLE doc_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    file_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding VECTOR(1536),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON doc_embeddings USING ivfflat (embedding vector_cosine_ops);
```

---

## 7. Agent Communication

### 7.1 Event Bus Architecture

All agent communication flows through a Postgres LISTEN/NOTIFY event bus with Sensei oversight. NOTIFY payloads are capped at 8000 bytes (libpq limit); oversized events (>7500 bytes) are truncated with a `_truncated: true` marker, while full event data is logged to the `agent_logs` table as the source of truth.

```
┌─────────────────────────────────────────────────────────┐
│                    EVENT BUS                             │
│              (Postgres LISTEN/NOTIFY)                    │
│                                                         │
│  Channels:                                              │
│  ├── task.*          (task lifecycle events)             │
│  ├── review.*        (quality review events)             │
│  ├── approval.*      (human approval gate events)        │
│  ├── build.*         (CI/CD events)                      │
│  ├── intercept.*     (v2.3 collaborative intercept)      │
│  └── agent.*         (agent status/benchmark/stream)     │
│                                                         │
│  NOTIFY payload cap: 7500 bytes (8000 - 500 headroom)   │
│  Full audit trail: agent_logs table (all events)        │
│  Oversized event marker: _truncated: true               │
└─────────────────────────────────────────────────────────┘
         │
         │  ALL events (truncated if >7500 bytes)
         ▼
┌─────────────────┐
│     SENSEI       │──── Monitors everything
│                  │──── Logs to agent_logs table
│   Trust: LOW     │──── Approves every handoff
│   Trust: MEDIUM  │──── Approves phase transitions only
│   Trust: HIGH    │──── Monitors passively, intervenes on anomalies
└─────────────────┘
```

### 7.2 Event Types

| Event | Publisher | Subscribers | Sensei Action |
|-------|-----------|-------------|---------------|
| `task.created` | Sensei | Assigned agent | Logs, tracks |
| `task.assigned` | Agent picking up work | Sensei | Updates dashboard |
| `task.progress` | Working agent | Sensei, Command Center | Live feed update |
| `task.completed` | Finishing agent | Sensei, dependent agents | Routes to next step |
| `task.blocked` | Blocked agent | Sensei | Attempts resolution, may escalate |
| `task.failed` | Failed agent | Sensei | Retry or escalate to human |
| `review.requested` | Any agent | Vigil | Queues review |
| `review.passed` | Vigil | Sensei, original agent | Proceeds to next phase |
| `review.rejected` | Vigil | Sensei, original agent | Re-routes for fix |
| `approval.required` | Sensei | Human (Command Center) | Blocks until human responds. `data.reason` (when set) signals a blocking escalation — headless auto-approve refuses these. |
| `approval.granted` | Human | Sensei, waiting agents | Unblocks pipeline |
| `build.failed` | CI/CD webhook | Sensei, Aegis | Sensei alerts human, Aegis investigates |
| `build.verification.passed` | BuildVerificationGate | Sensei | Logs; Phase 5 may advance if acceptance also passes |
| `build.verification.failed` | BuildVerificationGate | Sensei | Escalates to human approval with `data.reason` (not auto-recoverable) |
| `acceptance.passed` | AcceptanceGate | Sensei | Logs; artifact satisfies spec |
| `acceptance.failed` | AcceptanceGate | Sensei | Creates `acceptance-fix` task for Forge with violations (max 2 retries) |
| `agent.benchmark` | Sensei | Speciality matrix | Updates scores |
| `agent.stream` | Working agent | Command Center | Live output feed for intercept panel; triggers Live HUD pulse (events/min, live spend, latest headline) |
| `intercept.pause` | Human (Command Center) | Target agent | Agent cooperatively blocks at next yield point |
| `intercept.resume` | Human (Command Center) | Target agent | Unblocks paused agent |
| `intercept.guidance` | Human (Command Center) | Target agent | Prepends guidance to next AI call |
| `intercept.takeover` | Human (Command Center) | Target agent | Agent stops work, marks task as taken over |
| `intercept.handback` | Human (Command Center) | Sensei | Sensei re-routes task back to agent with optional guidance |
| `intercept.acknowledged` | Target agent | Command Center | Confirms agent received the intercept command |
| `project.resumed` | Sensei | Command Center | Emitted by `restartStalledProject()`; re-routes pending tasks for dispatch |

### 7.3 Live HUD & Resilience (v2.3 Wave 2)

Command Center status bar includes a real-time Live HUD that pulses on every event-bus activity:

- **Live indicator** — pulsing dot on event receipt (any channel)
- **Events/min** — rolling 60-second window event count; decays to zero if silent
- **Live spend** — session-cumulative cost from `agent.stream` events (reads `costUsd`)
- **Latest activity** — headline of the last event (headline truncated to 80 chars, auto-fades after 6 s)

All metrics update without re-rendering the full status bar (CSS animations + targeted DOM updates).

### 7.4 Restart Stalled Project (v2.3 Wave 2)

`Sensei.restartStalledProject(projectId)` resets assigned/in-progress tasks back to pending and re-routes them for dispatch. Safe to call repeatedly (idempotent). Emits `project.resumed` event with `reason: 'restart-stalled'` and requeued count.

---

## 8. Infrastructure & Deployment

### 8.1 Docker Compose Architecture (Local)

```yaml
services:
  # Database
  autonauts-db:
    image: pgvector/pgvector:pg16
    ports: ["5432:5432"]
    volumes: [autonauts_data:/var/lib/postgresql/data]
    environment:
      POSTGRES_DB: autonauts
      POSTGRES_PASSWORD: ${DB_PASSWORD}

  # Orchestrator
  sensei:
    build: ./containers/sensei
    depends_on: [autonauts-db]
    volumes:
      - ./projects:/projects
      - ./template:/template
    environment:
      DATABASE_URL: postgres://...
      AI_PROVIDER: ${SENSEI_MODEL}

  # Specialist Agents (one container each)
  scout:
    build: ./containers/agent
    environment: { AGENT_ROLE: scout, DATABASE_URL: ..., AI_PROVIDER: ... }
    volumes: [./projects:/projects]
    deploy: { resources: { limits: { cpus: '2', memory: 4G } } }

  blueprint:
    build: ./containers/agent
    environment: { AGENT_ROLE: blueprint, ... }
    # ... same pattern for all 8 agents

  # Local AI
  ollama:
    image: ollama/ollama
    ports: ["11434:11434"]
    volumes: [ollama_models:/root/.ollama]
    deploy: { resources: { limits: { cpus: '4', memory: 8G } } }

volumes:
  autonauts_data:
  ollama_models:
```

### 8.2 Azure Cloud Burst (Future)

When local resources are exhausted, Sensei can spin up Azure Container Instances:

```
Local Docker          ──── capacity exceeded ────▶  Azure ACI
(your machine)                                      (same images)

sensei (local)        ──── routes task to ────▶     forge-burst-1 (ACI)
                                                    cipher-burst-1 (ACI)

autonauts-db (local)  ◀──── connects back ────      (via Azure VPN/tunnel)
```

- Same container images used locally and on ACI
- Agent containers are stateless — connect to local or cloud Postgres
- Sensei monitors resource usage, triggers burst when thresholds exceeded
- Cost: ~$0.045/hr per container, billed per second
- Existing Azure subscription used

---

## 9. Security Architecture

### 9.1 Secret Management Layers

```
┌────────────────────────────────┐
│  Layer 1: OS Keychain          │
│  (Windows Credential Manager)  │
│                                │
│  Stores: AI API keys,          │
│  Azure credentials,            │
│  GitHub PATs                   │
└────────────┬───────────────────┘
             │ fetched at runtime
             ▼
┌────────────────────────────────┐
│  Layer 2: Encrypted Vault      │
│  (per project, AES-256)        │
│                                │
│  Stores: DB passwords,         │
│  service tokens,               │
│  connection strings            │
└────────────┬───────────────────┘
             │ decrypted in memory
             ▼
┌────────────────────────────────┐
│  Sensei                        │
│  Injects secrets into agent    │
│  container env vars at launch  │
│  Agents NEVER see raw secrets  │
└────────────────────────────────┘
             │
             │ future escalation
             ▼
┌────────────────────────────────┐
│  Layer 3: Azure Key Vault      │
│  (production/team scenarios)   │
│  Managed Identity support      │
└────────────────────────────────┘
```

### 9.2 Git Security

- `.gitignore` enforced: no `.env`, no vault files, no credentials
- Pre-commit hook scans for leaked secrets (API keys, tokens, passwords)
- Agents cannot push secrets to git — Sensei validates before commit

---

## 10. Integration Map

```
┌─────────────────────────────────────────────────────────────────┐
│                           KAGEOPS                               │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Source    │  │ Comms    │  │ CI/CD    │  │ Cloud         │  │
│  │ Control  │  │          │  │          │  │ (Azure)       │  │
│  │          │  │          │  │          │  │               │  │
│  │ • GitHub │  │ • Teams  │  │ • GitHub │  │ • ACI         │  │
│  │          │  │ • Outlook│  │   Actions│  │ • Key Vault   │  │
│  │          │  │ • SMS    │  │ • Azure  │  │ • SQL/Cosmos  │  │
│  │          │  │          │  │   Pipes  │  │ • Functions   │  │
│  │          │  │          │  │          │  │ • Storage     │  │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────┘  │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Design   │  │ PM       │  │ AI       │  │ Other         │  │
│  │          │  │          │  │ Models   │  │               │  │
│  │ • Figma  │  │ • Notion │  │          │  │ • npm/PyPI    │  │
│  │ • Canva  │  │   (export│  │ • Claude │  │ • Docker Hub  │  │
│  │ • Code-  │  │    only) │  │ • OpenRtr│  │ • Confluence  │  │
│  │   based  │  │ • Built- │  │ • Ollama │  │ • Google Drive│  │
│  │          │  │   in     │  │ • GPT    │  │               │  │
│  │          │  │          │  │ • Gemini │  │               │  │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 11. Project Workspace Structure

### 11.1 Template + Spawn Model

```
autonauts/
├── template/                    ← golden template repo (cloned for each project)
│   ├── .autonauts/
│   │   ├── project.json         ← project metadata, trust level, phase
│   │   ├── task-graph.json      ← local cache of task dependencies
│   │   └── agent-config.json    ← per-agent model overrides
│   ├── docs/
│   │   ├── discovery/
│   │   ├── business/
│   │   ├── design/
│   │   └── decisions/
│   ├── designs/
│   │   ├── wireframes/
│   │   ├── mockups/
│   │   └── user-flows/
│   ├── src/
│   ├── tests/
│   ├── infra/
│   │   ├── terraform/
│   │   ├── docker/
│   │   └── ci-cd/
│   ├── data/
│   │   ├── pipelines/
│   │   ├── models/
│   │   └── schemas/
│   ├── marketing/
│   │   ├── brand/
│   │   ├── copy/
│   │   └── campaigns/
│   ├── .gitignore
│   └── README.md
│
├── projects/                    ← spawned independent repos
│   ├── sales-dashboard/.git
│   ├── mobile-app/.git
│   └── data-pipeline/.git
│
└── shared/                      ← shared packages across projects
    ├── autonauts-utils/
    └── autonauts-ui-components/
```

### 11.2 Project Creation Flow

1. User tells Sensei: "Build me a sales dashboard"
2. Sensei clones `template/` into `projects/sales-dashboard/`
3. Sensei registers project in Postgres `projects` table
4. Sensei customizes `.autonauts/project.json` with name, description
5. User sets trust level (low/medium/high)
6. Sensei decomposes idea into Phase 1 tasks
7. Events fire, agents begin work

---

## 12. Command Center UI

### 12.1 Default View: Mission Control

```
┌─────────────────────────────────────────────────────────────┐
│  AUTONAUTS COMMAND CENTER                    [MC][CH][KB][ID]│
├──────────────────────┬──────────────────────────────────────┤
│                      │                                      │
│   ACTIVE PROJECTS    │   AGENT ACTIVITY FEED                │
│   ┌───────────────┐  │   ┌──────────────────────────────┐  │
│   │ Sales Dash    │  │   │ 10:23 Forge: Completed API   │  │
│   │ Phase 5 ████░ │  │   │ 10:24 Vigil: Reviewing PR    │  │
│   │ 12/15 tasks   │  │   │ 10:25 Aegis: Deploying stg   │  │
│   ├───────────────┤  │   │ 10:26 Sensei: Gate reached    │  │
│   │ Mobile App    │  │   │ ★ APPROVAL NEEDED             │  │
│   │ Phase 3 ██░░░ │  │   └──────────────────────────────┘  │
│   │ 5/20 tasks    │  │                                      │
│   └───────────────┘  │   APPROVAL QUEUE (2 pending)         │
│                      │   ┌──────────────────────────────┐  │
│   AGENT STATUS       │   │ ⚡ Sales Dash: Approve deploy │  │
│   ┌───────────────┐  │   │ ⚡ Mobile App: Approve PRD    │  │
│   │ Sensei  ● idle│  │   └──────────────────────────────┘  │
│   │ Scout   ● busy│  │                                      │
│   │ Forge   ● busy│  │   BUILD STATUS                       │
│   │ Vigil   ● rev │  │   ┌──────────────────────────────┐  │
│   │ Aegis   ● dep │  │   │ Sales: ✓ passing (2m ago)    │  │
│   │ Others  ● idle│  │   │ Mobile: ✗ FAILED (fix ready) │  │
│   └───────────────┘  │   └──────────────────────────────┘  │
│                      │                                      │
│   COST TRACKER       │   SENSEI CHAT                        │
│   Today: $2.47       │   ┌──────────────────────────────┐  │
│   This week: $14.20  │   │ Ask Sensei anything...        │  │
│                      │   └──────────────────────────────┘  │
└──────────────────────┴──────────────────────────────────────┘
```

### 12.2 Available Views

| View | Shortcut | Use Case |
|------|----------|----------|
| Mission Control | Default | Monitor everything at a glance |
| Chat-first | Switch | Deep conversation with agents |
| Kanban Board | Switch | Visual task management per project |
| IDE-style | Switch | Developer-focused file + terminal view |

### 12.3 Project Lifecycle Controls (v2.4)

Projects transition through a state machine that the Projects panel exposes directly — no terminal required.

```
   ┌────────┐   start (dry / live)   ┌────────┐
   │ new    │ ─────────────────────► │ active │◄──┐
   └────────┘                         └────┬───┘   │ resume
                                           │       │
                                pause ─────┼──────►┐ │
                                           │      ┌┴─┴─────┐
                                           │      │ paused │
                                           │      └────┬───┘
                     cancel ◄───────────────┘          │ resume
                       │                               ▼
                       ▼                         ┌──────────┐
                ┌───────────┐   phase-gate ✓    │ completed │
                │ cancelled │ ◄──────────────── └──────┬────┘
                └──────┬────┘                          │
                       │                               │
                       ├────────── archive ◄───────────┤
                       ▼
                ┌──────────┐    hard-delete   ┌─────────┐
                │ archived │ ───────────────► │  gone   │
                └────┬─────┘                  └─────────┘
                     │  restore
                     └─────────────────► active
```

- **Start (Dry / Live)** — the Projects panel "Start" split-button kicks off a run in-process. Dry runs invoke `headless-runner --dry-run` (no AI, heuristic cost preview). Live runs spawn a child `tsx` process with a mandatory `KAGEOPS_MAX_RUN_USD` cap inherited from settings.
- **Pause / Resume** — cooperative, layered on v2.3 intercept (decision #30). Broadcasts `intercept.pause` to every agent on the project and sets `projects.status='paused'`. Agents yield at their next `askAI()` — no partial file writes, no forced kill.
- **Cancel** — terminal. Stops budget-kill watcher, unassigns in-flight tasks, status=`cancelled`.
- **Archive** — soft-delete (status=`archived`). Hides project from the default Projects list but preserves workspace + tasks + logs. Reversible via Restore.
- **Hard-delete** — available only from the Archived view, double-confirm. CASCADEs DB rows and removes `project.repo_path` from disk.

### 12.4 Artifact Browser (v2.4)

A dedicated panel for inspecting what the agents actually produced, distinct from the Knowledge Base (which indexes *uploaded* docs).

```
┌─────────────────────────────────────────────────────────────┐
│  ARTIFACT BROWSER — wanderlust-blog                         │
├──────────────────────┬──────────────────────────────────────┤
│  FILE TREE           │  PREVIEW                             │
│  ▼ wanderlust-blog/  │  ┌──────────────────────────────┐   │
│    ▶ assets/         │  │  <!DOCTYPE html>             │   │
│    ▼ pages/          │  │  <html lang="en">             │   │
│      • index.html  🎨│  │  <head>...                    │   │
│      • about.html    │  │                               │   │
│      • stories.html  │  │  [Preview] [Source] [Raw]     │   │
│    • style.css       │  └──────────────────────────────┘   │
│                      │                                      │
│  🎨 = agent-produced │  META                                │
│                      │  Size 4.2 KB  Modified 2m ago        │
│  [Download zip]      │  Producer: Forge  Task T-017         │
│  [Push to GitHub]    │  [Open in new window] [Live preview] │
└──────────────────────┴──────────────────────────────────────┘
```

Implementation notes:

- Tree lives in `src/renderer/command-center/artifact-browser-panel.ts`; filesystem reads go through new `project.listFiles(projectId, subPath)` and `project.readFile(projectId, path)` IPC handlers on the main process, both guarded against path traversal against `project.repo_path`.
- Rendering pipeline: text/markdown/code → Prism.js / marked in-panel; HTML → sandboxed iframe (`sandbox="allow-scripts"`) with `file://` asset proxy; images → `<img>` via `file://`; binary → metadata only.
- Agent attribution: file path cross-referenced against `tasks.output_path` to surface a "🎨 produced by Forge" badge and link back to the task detail.
- Download produces a zip honouring `.gitignore`; live preview spawns a short-lived `http-server` for static sites.

---

## 13. Privacy & Data Policy

KageOps is local-first for project work, with a thin cloud layer for identity and billing.

- **Project data stays local.** Project files, task state, agent logs, and embedded Postgres data all live on the user's machine. None of this is ever sent to KageOps servers.
- **AI providers.** Conversations are handled by the CLI/API the user configures per agent. KageOps does not intercept, store, or transmit chat content beyond what the provider requires. Any data sent to cloud providers is governed by their respective terms.
- **Local-only AI option.** Ollama provides fully on-device AI with zero cloud dependency. Combined with offline mode, KageOps can run entirely without internet after initial activation.
- **Identity (Clerk).** Sign-in stores only a short-lived session token in the OS keychain. Email + display name + plan claim live in Clerk's database; password is never stored or transmitted by KageOps.
- **Billing (Stripe).** KageOps never sees the user's card. Subscription state syncs from Stripe webhooks → Clerk publicMetadata.plan; only the plan name is read by the desktop app.
- **No app-side telemetry.** KageOps collects no usage analytics, no crash reports, no opt-in/opt-out beacons. Only Clerk and Stripe see what their respective products inherently see.
- **Azure burst (optional).** When using cloud burst, container workloads run in the user's own Azure subscription. No third-party access.

---

## 14. Testing & Quality Strategy

### 14.1 Quality Pipeline

```
Agent completes task
        │
        ▼
┌───────────────────┐
│ AUTOMATED CHECKS  │ ← ALWAYS run (non-negotiable)
│                   │
│ • Build passes    │
│ • Unit tests pass │
│ • Smoke tests     │
│ • Lint/format     │
│ • Secret scan     │
│ • Coverage (80%+) │
└────┬────────┬─────┘
     │Pass    │Fail
     ▼        ▼
  Continue   Block → Agent fixes → Re-run
     │
     ▼
┌────────────────┐
│ RISK ASSESSMENT│ ← Sensei evaluates
│ (by Sensei)    │
└──┬──────────┬──┘
 High/Med    Low
   │          │
   ▼          ▼
┌──────────┐ Proceed
│ VIGIL AI │ (logged)
│ REVIEW   │
└──┬────┬──┘
  Pass  Fail
   │     │
   ▼     ▼
Proceed Reject → Agent reworks
```

### 14.2 Risk-Based Review Triggers

| Risk Level | Vigil AI Reviews? | Examples |
|-----------|------------------|---------|
| High | Always | Code, infrastructure, security, DB migrations, deployments |
| Medium | At phase gates | Documents, API designs, data models |
| Low | Spot-check only | Marketing copy, READMEs, comments |

### 14.3 Trust Level Overlay

| Trust Level | Automated | Vigil AI | Human Review |
|-------------|----------|----------|-------------|
| Low | All run | Every task | Every phase gate |
| Medium | All run | High-risk tasks + gates | Phase gates only |
| High | All run | Spot-checks (20%) | Final deployment only |

---

## 15. Error Handling & Recovery

### 15.1 Tiered Escalation

All error scenarios follow a tiered approach — self-heal first, escalate if needed.

**Agent Task Failure:**
```
1. Retry same agent, same model (feed back error)
2. Retry same agent, stronger model (Ollama → Claude)
3. Route to different agent (Blueprint helps Forge)
4. Escalate to human (full failure log)
5. Sensei updates speciality matrix (track failure patterns)
```

**Agent Unresponsive:**
```
1. Timeout (10 min default) → kill container, restart
2. Second timeout → restart with higher resources
3. Third timeout → alert human (Teams + Email + SMS)
4. Sensei re-routes pending tasks (no bottleneck)
```

**Bad Deployment:**
```
1. Health check fails → auto-rollback (< 60 seconds)
2. Alert human: "Rolled back. Here's why."
3. Sensei creates investigation task (Vigil + Aegis)
4. Human decides: fix forward or stay on rollback
5. Deployment freeze until resolved
```

### 15.2 Alert Priority Routing

| Priority | Triggers | Channels |
|----------|----------|----------|
| Critical | Deployment failure, security breach | SMS + Teams + Email |
| High | Agent stuck, approval needed | Teams + Email |
| Medium | Task failed, retry in progress | Teams only |
| Low | Benchmark complete, status update | Dashboard only |

---

## 16. MVP Roadmap

### v0.1 — "Idea to Product" (Foundation)

The MVP must demonstrate the full lifecycle: idea in → deployed product out.

| Component | Ships |
|-----------|-------|
| **Agents** | Sensei + Scout + Blueprint + Forge + Vigil + Aegis |
| **Infra** | Postgres + Docker Compose + Ollama + GitHub + GitHub Actions |
| **UI** | Mission Control (project status, Sensei chat, approval queue, agent feed) |
| **Comms** | Command Center notifications only |

**v0.1 Demo Flow:**
```
You: "Build me a task tracker web app"
  → Phase 1: Scout researches, writes concept brief
  → ★ You approve ★
  → Phase 2: Forge builds quick POC
  → ★ You approve ★
  → Phase 3: Scout writes viability assessment
  → ★ You approve → toggle autonomous ★
  → Phase 4: Blueprint designs architecture, Scout writes PRD
  → Phase 5: Forge builds, Vigil tests, automated checks pass
  → Phase 6: Aegis deploys to Azure
  → Result: Working app, deployed, tested, documented
```

### v0.2 — "Creative & Data"
- Agents: + Pixel (designer) + Cipher (data specialist)
- UI: + Speciality matrix dashboard + all 4 views
- Infra: + Azure services integration

### v0.3 — "Go to Market"
- Agents: + Herald (marketer)
- Comms: + Teams + Email (Outlook)
- UI: + Cost tracker

### v1.0 — "Production"
- Infra: + Azure cloud burst (ACI)
- Comms: + SMS (Azure Communication Services)
- Integrations: + Figma + Notion (export) + web dashboard
- Full speciality matrix benchmarking

### v1.1 — "Command Center Polish" (Done)
- Orchestration Flow Panel (LangGraph-inspired SVG with bezier curves)
- Phase Graph Panel (interactive lifecycle timeline)
- Agent Detail Panel (per-agent metrics and task history)
- Agent Management Panel (enable/disable, model config)
- Deployments Panel (Azure ACI target management)
- Team Members Panel (human collaborator roster)
- Document Upload Panel (per-project doc attachment)
- Config Panel (API keys, env vars, agent providers)
- Approval Queue with expandable details (task breakdown, phase summary)
- Sensei chat persona (orange theme, typing indicator, expandable)
- Model identity drift prevention (periodic system prompt reinforcement)
- Global CSS normalization (consistent forms, buttons, typography)

### v1.2 — "Competitive Intelligence" (Done)
- Full competitive analysis: LangSmith/LangGraph vs Goose vs KageOps
- Feature comparison matrix (58 features, 12 categories)
- Goose feature inheritance audit (10/10 core features shipped)
- Roadmap influenced by LangSmith + Goose gaps
- SaaS product architecture planning (hybrid Electron + cloud)
- Plugin integration analysis: Security Guidance, Code Review, Frontend Design, Caveman, Code-Review-Graph, Superpowers
- 22 new backlog items (B-200 to B-221) from integration analysis

### v1.2.1 — "Plugin Integration Wave 1" (Complete — 2026-04-11)
- Caveman inter-agent mode (40-60% token cost reduction) — `src/agents/caveman-mode.ts`
- Verification gates on task completion (evidence-based proof) — `src/agents/verification-gate.ts`
- Two-stage review (spec compliance → code quality) — `src/agents/review-stages.ts`
- Security scanner pre-write hook (8 vulnerability patterns) — `src/agents/security-scanner.ts`
- Multi-agent parallel review fleet — `src/agents/review-fleet.ts`
- Risk-scored change detection for Vigil — `src/agents/risk-scorer.ts`
- Context compression before dispatch — `src/agents/context-compressor.ts`
- Blueprint exact task specifications (2-5 min tasks) — `src/agents/task-spec-format.ts`
- TDD enforcement in Forge (RED→GREEN→REFACTOR) — `src/agents/tdd-workflow.ts`
- Frontend Design framework for Pixel — `src/agents/design-brief.ts`
- Community-based task routing — `src/orchestrator/community-router.ts`
- 3-arm eval methodology — `src/agents/eval-framework.ts`
- Terse review output format — `src/agents/terse-review-format.ts`
- REVIEW.md convention support — `src/agents/review-config.ts`
- Severity classification (Important/Nit/Pre-existing) — `src/agents/severity-classifier.ts`
- Systematic debugging workflow (4-phase) — `src/agents/debug-workflow.ts`
- GitHub Actions injection scanning — `src/agents/gha-scanner.ts`
- WebSocket brainstorming server for Pixel — `src/agents/brainstorm-server.ts`
- Wiki generation from code structure — `src/agents/wiki-generator.ts`
- Cross-repo search for multi-project — `src/workspace/cross-repo-search.ts`
- Auto-resolve review threads on fix — `src/agents/review-resolver.ts`
- Test suite: 1386 tests, 71 test files
- Inspired by: Caveman, Superpowers, Anthropic Code Review, Security Guidance, Code-Review-Graph, Frontend Design

### v2.3 — "Collaborative Agent Intercept" (Complete — 2026-04-18)
- Live intercept panel: pause/resume agent, inject guidance, take over task, hand back with context
- Agent stream channel publishes to Command Center in real-time
- Sensei routes intercept commands back to paused agents
- See decision #48.

### v2.5 — "Design Provider Pluggability" (Complete — 2026-04-25)
- `DesignProvider` interface (`src/agents/design/design-provider.ts`) — pluggable UI-generation backend consumed by Pixel's `ui-build` task handler.
- Two providers shipped: `InHouseProvider` (uses the active preset's Pixel model — cheap tier compatible) and `ClaudeUiProvider` (pins Claude Sonnet with a production-UI system prompt; preset-independent so UI quality stays high even on budget presets). ClaudeUi is NOT Anthropic's claude.ai/design web product — that surface has no public API; this is a direct-prompt Sonnet wrapper.
- `ProviderRegistry` wired through both `headless-runner.ts` and `orchestrator-bootstrap.ts` so CLI and Electron paths get identical provider selection.
- Selection persists to `<KAGEOPS_DATA_DIR>/active-design-provider.txt` (env `KAGEOPS_DESIGN_PROVIDER` overrides). Command Center Model Routing panel now has a second dropdown for live selection.
- Task decomposer prompt rewritten so landing pages / marketing sites / visually-heavy SPAs route to `pixel:ui-build` (previously all HTML went through Forge `implement` tasks producing empty scaffolds).
- Both provider system prompts hardened: JS is opt-in, DOM lookups must be null-guarded, scripts must run after `DOMContentLoaded` — driven by jsdom runtime smoke catching `null.addEventListener` in Sonnet's output.
- See decision #49.

### v2.3 Wave 2 — "Shell Replacement" (Complete — 2026-04-27)
- **Frameless window** ([src/main/command-center-window.ts](src/main/command-center-window.ts)) — `titleBarStyle: 'hidden'` with custom drag-region wiring in top bar
- **Radial orchestration flow** ([src/renderer/command-center/orchestration-flow-panel.ts](src/renderer/command-center/orchestration-flow-panel.ts)) — Sensei at center, agents on concentric ring; replaces linear graph
- **Static agent sigils** — nine individual SVG sigils in the Command Center; minimal, symbolic design
- **Live HUD** ([src/renderer/command-center/status-bar.ts](src/renderer/command-center/status-bar.ts)) — events/min, live spend, latest activity ticker in system bar
- **Custom preset CRUD** ([src/main/app-config-store.ts](src/main/app-config-store.ts)) — createPreset/deletePreset/getPreset; persists to `~/.kageops/agent-config.<name>.json`
- **Restart-stalled-project IPC** ([src/orchestrator/sensei.ts](src/orchestrator/sensei.ts) + [src/main/project-lifecycle-ipc.ts](src/main/project-lifecycle-ipc.ts)) — resets assigned/in-progress tasks, re-routes pending
- **Mark C Kanji-fold branding** — simplified brand mark (stylized 金 C), replaces full logo on overlay
- See decisions #50–#51.

### v1.3 — "Trace Intelligence" (Planned)
- Hierarchical trace tree panel (Sensei → agent → LLM → tool)
- Trace correlation IDs across agent_logs
- Run type taxonomy (orchestrate, llm, tool, review, deploy, file-io)
- Inspired by: LangSmith RunTree

### v1.4 — "Timeline View" (Planned)
- Waterfall/Gantt-chart showing parallel/sequential agent work
- Latency metrics (P50, P99) per agent and task type
- Bottleneck identification
- Inspired by: LangSmith waterfall view

### v1.5 — "Evaluation Framework" (Planned)
- Dataset-driven benchmarking of agent quality
- LLM-as-judge scoring for task outputs
- Annotation rubrics (structured human scoring beyond approve/deny)
- CI/CD eval integration (quality gates on PRs)
- Inspired by: LangSmith evaluation system

### v1.6 — "Agent Recipes" (Planned)
- YAML workflow definitions for reusable task patterns
- Parameterized inputs and sub-recipe composition
- Recipe marketplace for team sharing
- Inspired by: Goose Recipes

### v1.7 — "Security Hardening" (Planned)
- Adversary reviewer (hidden secondary AI monitoring for unsafe behavior)
- Prompt injection detection (Unicode stripping, action visualization)
- Pre-commit secret scanning hook
- Inspired by: Goose Operation Pale Fire

### v1.8 — "Alert Rules Engine" (Planned)
- Configurable thresholds for cost, latency, error rate
- PagerDuty, Slack, webhook notification channels
- Aggregation windows (5/15 min)
- Inspired by: LangSmith alerting system

### v1.9 — "Prompt Playground" (Planned)
- Isolated prompt testing for each agent persona
- Side-by-side model comparison
- Token usage and cost display per test
- Inspired by: LangSmith Playground + Prompt Hub

### v2.0 — "CLI & SaaS" (Planned)
- Terminal REPL interface for power users
- Web dashboard (Next.js) for cloud-only users
- SaaS subscription model (Free/Pro/Enterprise tiers)
- Cloud sync, team collaboration, cloud agent execution
- Inspired by: Goose CLI + LangSmith SaaS

---

## Appendix A: Brand & Naming

| Element | Name | Purpose |
|---------|------|---------|
| Platform | **KageOps** | The product — what users install and reference |
| Agent team | **Autonauts** | The crew of specialist AI agents |

| Domain | kageops.ai | Main website |
| Domain | kageops.dev | Developer docs / portal |

## Appendix C: Cost Guardrails (v1.6)

The platform enforces a layered budget-control stack because multi-agent LLM pipelines can otherwise run up $2+/simple-project through retry loops, over-decomposition, and unbounded TDD iterations.

### Layers (outer-most kills first)

1. **Budget-kill (headless-runner)** — polls `agent_logs` every 3 s. Cancels the project and fails pending tasks when `MAX(SUM(cost_usd), tokens_out × $3/M) >= KAGEOPS_MAX_RUN_USD` (default `$0.25`). The token-est floor catches providers that log `cost_usd = 0`.
2. **Per-task askAI cap (autonaut-agent)** — `KAGEOPS_MAX_AI_CALLS_PER_TASK` (default 8) throws inside the base agent class.
3. **Per-agent maxTokens cap (agent-config)** — built-in ceilings (sensei/scout/vigil/aegis/pixel/cipher/herald 2048, blueprint 3072, forge 4096). Override with `KAGEOPS_MAX_TOKENS_<AGENT>`.
4. **Retry cap (sensei)** — `MAX_TASK_RETRIES = 3` enforced in both `onTaskFailed` and `onReviewRejected`.
5. **Simple-app decomposition bias (task-decomposer)** — SIMPLE-APP GUARD embedded in all phase prompts. Hard caps: 2/1/1/1/1/1 tasks per phase when the description matches counter/todo/calculator/clock/landing-page/dashboard-mock/single-file patterns.
6. **Zombie-project guard (headless-runner)** — aborts runs with 0 tasks after `KAGEOPS_ZOMBIE_TIMEOUT_MS` (default 60 s).
7. **Dry-run preview (headless-runner)** — `--dry-run` prints heuristic task/cost preview with zero AI, zero DB writes, zero bootstrap.

### Reflector & Incidents (self-healing memory)

On `task.failed` the Sensei orchestrator fires `reflectOnFailure` (fire-and-forget) at `src/orchestrator/reflector.ts`. A cheap Haiku (~256 tokens) normalizes the error (strips UUIDs, paths, timestamps, >13-digit numbers) into a stable `signature` and upserts into the `incidents` table. Same failure across runs increments `times_seen` rather than creating duplicates.

### Runs Archive

End-of-run summary rows written to `runs` (immutable): `final_phase`, `final_status` ∈ `{success, budget_killed, incomplete}`, `total_tokens_in/out`, `total_cost_usd`, `killed_by_budget`, `error_message`. Used for per-project cost history without re-aggregating `agent_logs`.

### Provider Presets

Three shipped presets at `<KAGEOPS_DATA_DIR>/agent-config.<preset>.json`:

| Preset | Forge | Blueprint | Others | Approx cost (counter app) |
|---|---|---|---|---|
| `openrouter_standard` | claude-sonnet-4 | claude-sonnet-4 | gemini-2.5-flash | ~$1.00 |
| `openrouter_budget` | deepseek-v3.1 | gemini-2.5-flash-lite | gemini-2.5-flash-lite | ~$0.04 |
| `ollama` | glm-5.1:cloud | qwen3-coder-next:cloud | gpt-oss:120b-cloud | $0.00 (included in Ollama plan) |

Active preset resolution (precedence): `KAGEOPS_PRESET` env → `<KAGEOPS_DATA_DIR>/active-preset.txt` → default `agent-config.json`. Command Center Model Routing panel exposes a dropdown that writes `active-preset.txt`.

#### Custom Preset CRUD (v2.3 Wave 2)

AppConfigStore ([src/main/app-config-store.ts](src/main/app-config-store.ts)) provides:
- `createPreset(name, config)` — writes `~/.kageops/agent-config.<name>.json`
- `deletePreset(name)` — deletes custom preset file
- `getPreset(name)` — reads preset by name
- `listPresets()` — returns all presets (built-in + custom)

All operations validate the config shape (record of agent name → `AgentModelEntry`). Preset selection persists via `active-preset.txt`; CLI/headless mode respects the same resolution chain as Electron.

---

## Appendix D: APO — Automatic Prompt Optimization (v0.11 Phase 4)

Nightly beam-search loop that proposes better system prompts for the deterministic-quality agents, under human review. Inspired by agent-lightning's APO; ported to native TypeScript, stored in our own Postgres, dispatched on our own timer.

### Scope

- **Eligible agents:** `scout`, `herald`, `pixel` (constant `APO_ELIGIBLE_AGENTS` in `src/learning/types.ts`). Forge/Aegis/Blueprint are excluded — their outputs vary too much for a stable reward signal.
- **Propose only.** APO never overwrites a live preset on its own. See decision #48.

### Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│  startApoScheduler()  setTimeout loop, unref(), opt-in     │
│                         KAGEOPS_APO_ENABLED=1              │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
              ┌────── for each eligible agent ──────┐
              ▼                                     ▼
   loadBaselinePrompt(agent)           loadGoldenTasks(agent)
   (exported SYSTEM_PROMPT             (src/learning/golden-tasks.json
    from specialists/)                  — held-out corpus)
              │                                     │
              └──────────────────┬──────────────────┘
                                 ▼
              ┌────────── optimize() ──────────┐
              │  src/learning/apo-engine.ts    │
              │  beam_width=4, branch=3, r=5   │
              │  mutatePrompt + evalPrompt     │
              └────────────────┬───────────────┘
                               ▼
              reward_delta >= KAGEOPS_APO_MIN_DELTA (0.02) ?
                     │                         │
                     │ yes                     │ no
                     ▼                         ▼
        persistProposedOptimization      discarded (logged only)
        (prompt_optimizations row,
         status='proposed')
                     │
                     ▼
         Command Center → APO History panel
         (operator reviews LCS diff, accepts)
                     │
                     ▼
                applyWinner()
        (writes ~/.kageops/agent-config.<preset>.json
         + timestamped .apo-backup-<ts>.json for rollback)
```

### Module map (`src/learning/`)

| File | Responsibility |
|------|---------------|
| `apo-engine.ts` | Beam search (beam_width=4, branch=3, rounds=5) |
| `prompt-mutator.ts` | LLM-driven rewriter, gradient-style critique |
| `live-eval.ts` | Scores candidate prompts against held-out tasks |
| `reward-from-logs.ts` | Derives scalar reward from `agent_logs` |
| `golden-tasks.ts` + `.json` | Held-out task corpus, per-agent |
| `optimization-record.ts` | CRUD for `prompt_optimizations` (proposed → accepted → rolled_back) |
| `apply-winner.ts` | Writes accepted prompt to preset + `.apo-backup` |
| `rollback.ts` | B-478 — restore preset from any `.apo-backup-*.json` |
| `apo-scheduler.ts` | `startApoScheduler(deps, opts)` — 24 h loop with `onRunComplete` hook |

### Data model

`prompt_optimizations` (see `src/db/schema.sql`):
- `agent_name`, `baseline_prompt`, `optimized_prompt`, `reward_delta`, `n_samples`
- `status` ∈ `{proposed, accepted, rolled_back}` — lifecycle guarded by `optimization-record.ts`
- No `CHECK` constraint on delta at the schema level; scheduler filters below `0.02` in-app so the UI isn't cluttered with noise

### UI (Command Center)

- **APO History** panel (v0.11) — lists all `prompt_optimizations`; clicking a row renders a line-level LCS diff with color-coded add/remove.
- **APO Rollback** panel (B-478) — lists `.apo-backup-*.json` files; a single click restores the preset and records status=`rolled_back`.

Both panels use pure-function HTML builders (`diffLines`, `buildHistoryHtml`, `buildDiffHtml` in `apo-history-panel.ts`) so they're testable without jsdom.

### Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `KAGEOPS_APO_ENABLED` | unset | `=1` starts the scheduler at app boot |
| `KAGEOPS_APO_EVAL_MODEL` | `openrouter/openai/gpt-4o-mini` | Model used by `live-eval.ts` |
| `KAGEOPS_APO_MUTATOR_MODEL` | `claude/claude-haiku-3-5-20241022` | Model used by `prompt-mutator.ts` |

The scheduler is started from `main.ts` → `bootstrapApoScheduler()` right after `bootstrapOrchestrator` and stopped from `app.on('before-quit')`.

---

## Appendix B: Origin — Desktop Pets

KageOps evolved from the Lil Agent desktop pet concept (Ping & Zing). As of 2026-04-29 (`chore/remove-ping-zing`), the overlay window and chat window were removed. The Command Center is now the single Electron window and the sole entry point for Sensei interaction.
