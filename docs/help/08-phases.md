# The 6-Phase Pipeline

Every KageOps project moves through six fixed phases. Understanding them
helps you know what's happening, when to intervene, and why Sensei pauses
for approval at certain points.

## The phases

| # | Phase                | What happens                                                    |
|---|----------------------|-----------------------------------------------------------------|
| 1 | Discovery            | Scout researches the market, competitor landscape, and constraints |
| 2 | POC                  | Blueprint proposes an architecture; Sensei validates feasibility |
| 3 | Business Viability   | Scout + Herald assess market fit, pricing, positioning          |
| 4 | Design & Planning    | Blueprint + Pixel produce system design, task breakdown, wireframes |
| 5 | Development          | Forge writes code; Vigil reviews; Cipher handles data; Aegis prepares infra |
| 6 | Launch & Growth      | Herald writes copy; Aegis deploys; Vigil does final QA          |

## Phase gates

Between every pair of phases there is a **gate** — a point where Sensei
evaluates the output of the previous phase before proceeding.

Gates do two things:

1. **Quality check** — does the phase output meet the acceptance criteria?
2. **Trust check** — does your trust level allow auto-proceed?

If a gate fails, Sensei either spawns a remediation task (e.g.
`acceptance-fix` for failed HTML assertions) or escalates to you with
`approval.required`.

## Trust levels

Set with the operation mode button in the Mission Control left sidebar, or
with the `--trust` flag on the headless runner:

| Level      | What it means                                                                   |
|------------|---------------------------------------------------------------------------------|
| `low`      | Pause at every phase boundary. You approve before each new phase starts.        |
| `medium`   | Auto-proceed within a phase; pause between phases.                              |
| `high`     | Auto-proceed through all phases after Design & Planning completes.              |

`autonomous_after_design` flag (in project settings): if true, equivalent
to `high` for phases 5 and 6 even if you're on `low` for the first four.

## What the Development phase looks like

Phase 5 is the longest. Sensei decomposes it into individual tasks routed to
specific agents:

1. Forge receives `scaffold` → creates workspace, `package.json`, base
   `index.html` + `styles.css`.
2. Each feature in the brief becomes a `feature` task — Forge implements one
   at a time, commits, then moves on.
3. After all tasks complete, **BuildVerificationGate** runs `npm install`,
   `npm run build`, `npm test`. Failures block Phase 6.
4. **AcceptanceGate** checks that every required element from the brief
   exists in the produced `index.html`. Up to 2 retry cycles before
   human escalation.

## The Phase 5 → 6 automated gates in detail

### BuildVerificationGate

- Runs `npm install && npm run build && npm test` in the project workspace.
- Static-only projects (no `package.json`) are skipped — they always pass.
- Fails on any non-zero exit code.
- On failure: `approval.required` is emitted — Sensei escalates, the run
  does NOT auto-proceed.

### AcceptanceGate

- Extracts required HTML element IDs from `project.description`.
- Two tiers: **MUST** (blocks), **SHOULD** (warns).
- On violation: Sensei creates an `acceptance-fix` task for Forge with
  the missing IDs in the task description.
- Maximum 2 retry cycles. On exhaustion, the best-known version is
  restored and human approval is requested.

## Headless runner phase resume

If a run is interrupted mid-phase:

```bash
npx tsx src/cli/headless-runner.ts --resume <project-id>
```

The runner loads the project, finds the current phase in `projects.current_phase`,
and re-routes remaining tasks or decomposes the phase fresh.

## What "approval required" means

When Sensei can't auto-proceed (gate failure, trust check, budget hit), it
emits `approval.required` and the project moves to `awaiting-approval` state.

In the UI: Mission Control shows a red `Needs approval` badge. Open the
project and click **Approve** / **Reject** in the Sensei chat.

In headless mode: the runner prints the escalation and waits. It will NOT
auto-approve gate failures even at `--trust high`.
