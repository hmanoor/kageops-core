# Agent Reference

Nine agents. Each has a fixed role, a default model tier, and a specific
failure mode. This page is the one-stop reference.

## The roster

### Sensei — Orchestrator

Sensei never writes code or produces artifacts directly. Its job is to plan,
route, gate, and escalate. It reads your brief, decomposes it into tasks,
assigns tasks to the right agents, monitors progress, and decides whether
a phase gate passes.

**When Sensei is slow:** it's waiting on an agent that's stuck or on the AI
call itself. Check the Activity feed for `task.stalled` events.

**When Sensei is wrong about a task assignment:** that's usually a brief
ambiguity. Rewrite the failing section of the brief to be more explicit.
Sensei doesn't take manual task re-routing.

---

### Scout — Strategist

First agent on every project. Scout's output feeds Blueprint's architecture
and Herald's copy. A weak Scout output (e.g. "no prior art found") often
signals a vague brief.

**Tasks:** market research, competitive analysis, requirements gathering,
feasibility assessment, PRD writing.

**Default model tier:** medium (Sonnet-class). Scout doesn't need Opus —
it's reading and summarising, not reasoning about hard problems.

**Failure modes:**
- Returns boilerplate if the brief has no domain information.
- Can loop on "requirements gathering" if the brief is contradictory.

---

### Blueprint — Architect

Turns Scout's research into a concrete system design. Blueprint decides
file structure, tech stack, data models, and API contracts. Its output is
what Forge works from.

**Tasks:** architecture design, system design, technical spec, API design,
data model design.

**Default model tier:** high (Opus-class). Architecture decisions compound
— a wrong call here costs multiple Forge retry cycles.

**Failure modes:**
- Over-engineers when the brief is small. Add "keep it simple" constraints.
- Proposes tech stacks the brief didn't ask for. Specify the stack
  explicitly if it matters.

---

### Pixel — Designer

Generates the visual layer. Pixel produces `index.html` + `styles.css` (and
optionally `script.js`) for the UI-build step, then Forge implements the
feature tasks on top.

**Tasks:** UI build, wireframe, visual design, interaction design, design
system.

**Default model tier:** varies — follows the active preset's Pixel slot, or
the design provider if one is set. This is the most model-sensitive agent.

**Failure modes:**
- CSS class drift — outputs HTML class names with no matching CSS rule.
  Fixed by the CSS completeness gate (retry) and the explicit "every class
  needs a rule" instruction in the Forge scaffold prompt.
- Activity rail appearing in Mission Control mock — removed from brief spec.

---

### Forge — Engineer

The workhorse. Forge gets the most tasks and runs the longest. It writes
all the code — scaffolds the project, implements features, fixes acceptance
failures, and writes tests.

**Tasks:** scaffold, feature, acceptance-fix, test-write, refactor.

**Default model tier:** medium-high (Sonnet+). Forge does volume work;
Opus on every call gets expensive fast.

**Failure modes:**
- Writes HTML classes with no CSS. Mitigated by CSS completeness gate.
- Produces `script.js` without `index.html` or `styles.css` (usually a
  task routing issue from a vague brief).
- Acceptance-fix loops: exhausts `MAX_ACCEPTANCE_RETRIES` (2) without
  fixing all violations. Human escalation follows.

---

### Cipher — Data Specialist

Handles everything database-adjacent. On projects without a database, Cipher
is often idle.

**Tasks:** schema design, seed data, query writing, data migration, report
generation.

**Default model tier:** medium (Sonnet-class).

**Failure modes:**
- Generates Postgres-flavoured SQL on a SQLite project. Specify the DB
  engine in the brief.
- May duplicate Blueprint's data model if both are asked to "design the
  database". Route clearly: Blueprint does logical model, Cipher does
  physical schema and queries.

---

### Aegis — Platform Engineer

Handles infrastructure, CI/CD, GitHub integration, and deployments. On
simple static-site projects, Aegis writes the deployment config but is
otherwise quiet.

**Tasks:** infra-setup, deploy, GitHub config, CI pipeline, env scaffolding.

**Default model tier:** medium (Sonnet-class).

**Failure modes:**
- Azure credentials missing → deployment step fails silently. Confirm
  `AZURE_*` keys are in keychain before a project with deployments.
- Pushes to wrong GitHub repo if the per-project mapping isn't set.

---

### Vigil — Quality Guardian

Reviews every other agent's output. Vigil runs after Forge and before the
phase gate. High Vigil spend is a signal that review prompts are too long
or that Forge is producing low-quality code.

**Tasks:** code review, test review, acceptance check, security scan.

**Default model tier:** medium-low. Vigil does pattern matching and
structured evaluation — it doesn't need raw reasoning power.

**Failure modes:**
- Vigil dominating spend: review prompt is too broad. Tighten it to
  "check these three things" not "check everything".
- Vigil flags false positives that block Forge's acceptance retry. Check
  the exact violation message before overriding.

---

### Herald — Marketer

Last agent to act on most projects. Herald writes the launch copy, social
posts, and any user-facing content that isn't the product itself.

**Tasks:** marketing copy, social post, email draft, launch checklist,
product naming.

**Default model tier:** medium (Sonnet-class). Copy quality is brief-
sensitive, not model-sensitive.

**Failure modes:**
- Generates copy in the wrong voice if no brand guidelines are in the
  brief. Include one paragraph describing the brand tone.
- May repeat Scout's competitive summary verbatim. Guide it: "write new
  copy for the launch email, don't summarise Scout's research".

---

## Speciality matrix

Each agent has a numeric score (0–10) for each skill it's been evaluated on.
These are populated by real project runs — not hand-tuned. View them in the
**Autonauts** panel → agent card → Speciality Scorecard.

High scores (≥8) in a skill mean the agent has a strong track record there.
Low scores (≤3) are either skills rarely called on, or areas where the agent
has struggled historically.

## Changing which model an agent uses

Open **Configuration → Agent Providers** and pin an agent to a specific
model. This overrides the active preset for that agent only.

Common overrides:
- Pixel → Opus 4.7 (design quality)
- Vigil → Haiku 4.5 (review is cheap to run)
- Sensei → Sonnet 4.6 (decomposition doesn't need Opus)
