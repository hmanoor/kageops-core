# KageOps CLI — Terminal Reference

The KageOps CLI is a command REPL built directly into the **Terminal** tab of
Mission Control. It gives you keyboard-driven access to every orchestration
action — approvals, retries, agent control, project management — without
leaving the dashboard.

Type `/` in the Terminal input to open the command palette. Start typing to
filter. Press `↑` / `↓` to navigate, `Tab` or `Enter` to complete,
`Escape` to dismiss.

---

## How commands work

Lines starting with `/` are intercepted before they reach the shell and routed
to the KageOps CLI. Everything else runs in the underlying shell (PowerShell,
bash, or CMD — choose from the toolbar dropdown).

Commands that require arguments (e.g. `/approve`) are filled with a trailing
space so you can type the argument immediately. Commands with no arguments
(e.g. `/status`) complete and execute in one keystroke.

---

## System

### `/status`

Shows the current state of the KageOps runtime: database connection, orchestrator
health, and agent readiness.

```
❯ /status
  db                   connected
  orchestrator         running
  agents               9 registered
```

### `/help`

Prints this command list inline in the terminal scrollback.

---

## Projects

### `/projects`

Lists all active projects (excludes completed, archived, and cancelled).

```
❯ /projects
  ID        Name                      Phase                 Status
  a1b2c3d4  Landing Page v2           development           active
  e5f6a7b8  Auth Service              design-planning       active
```

### `/projects all`

Same as `/projects` but includes completed and archived projects.

### `/sensei <message>`

Sends a message directly to the Sensei orchestrator and prints the reply inline.
Use this to ask Sensei about a project, request a plan change, or get a cost
breakdown.

```
❯ /sensei why is the development phase taking so long?
  [Sensei] Project a1b2c3d4 has 3 feature tasks pending. Forge is blocked
  waiting for Cipher's schema to complete — that task is currently assigned
  and should finish in the next cycle...
```

---

## Approvals

### `/approvals`

Shows all projects currently waiting for human approval (the gate escalation
queue).

```
❯ /approvals
  ID        Name                      Phase
  a1b2c3d4  Landing Page v2           development → launch-growth
```

### `/approve <projectId>`

Approves a pending gate and lets the project proceed to the next phase.
`projectId` can be the full UUID or the 8-character short ID from `/projects`.

```
❯ /approve a1b2c3d4
  ✓ Approved: a1b2c3d4
```

### `/deny <projectId> [reason]`

Rejects a pending gate. The project moves to `paused` state. Optionally include
a reason — it's logged to `agent_logs` for future reference.

```
❯ /deny a1b2c3d4 design does not match the brief
  ✗ Denied: a1b2c3d4 — design does not match the brief
```

---

## Retry & Recovery

Use these when a task or phase fails due to a transient error (network blip,
model timeout, API rate limit) and you want to re-run it without starting the
entire project over.

### `/retry-task <taskId>`

Resets a single failed task back to `pending` and re-routes it. The task must
be in `failed` status — tasks in other states are left untouched.

Get task IDs from the **Artifact Browser** (Mission Control → project → Tasks
tab) or from the `agent_logs` table.

```
❯ /retry-task 9f4e2a1b-c3d4-...
  ✓ Task re-queued (project a1b2c3d4)
```

### `/retry-phase <projectId> <phase>`

Resets **all failed tasks** in a specific phase back to `pending` and re-drives
the router. Use this when an entire phase stalled (e.g. Forge tasks all failed
due to a model outage during `development`).

Valid phase names:

| Phase name           | Description                          |
|----------------------|--------------------------------------|
| `discovery`          | Scout's research phase               |
| `poc`                | Blueprint's feasibility assessment   |
| `business-viability` | Market fit and positioning           |
| `design-planning`    | System design, wireframes            |
| `development`        | Forge writes code; Vigil reviews     |
| `launch-growth`      | Herald copy; Aegis deploy; final QA  |

```
❯ /retry-phase a1b2c3d4 development
  ✓ Re-queued 3 tasks in "development"
```

### `/retry-failed <projectId>`

Retries **all** failed tasks across the entire project at once. Use this as a
blunt-force recovery after a network outage affected multiple phases.

```
❯ /retry-failed a1b2c3d4
  ✓ Re-queued 5 tasks
```

**When to use which:**

| Situation | Command |
|-----------|---------|
| One specific task failed | `/retry-task <taskId>` |
| All tasks in a phase failed | `/retry-phase <projectId> <phase>` |
| Multiple phases affected | `/retry-failed <projectId>` |
| Project process is fully stuck (crash recovery) | Use **Restart** in the project panel |

---

## Agent Control (Intercept)

These commands let you intervene in a running agent's execution in real time.
They require both the agent name and the task ID — get these from the Activity
feed or the Autonauts panel.

### `/agents`

Lists all registered agents and their current state.

```
❯ /agents
  forge          in-progress  · task: 9f4e2a1b
  vigil          idle
  scout          idle
  ...
```

### `/pause <agent> <taskId>`

Pauses a running agent at the next safe checkpoint. The agent finishes its
current AI call before suspending — it will not stop mid-generation.

```
❯ /pause forge 9f4e2a1b-c3d4-...
  ✓ Paused forge
```

### `/resume <agent> <taskId>`

Resumes a paused agent. The agent picks up exactly where it left off.

```
❯ /resume forge 9f4e2a1b-c3d4-...
  ✓ Resumed forge
```

### `/inject <agent> <taskId> <message>`

Injects a guidance message into a paused (or running) agent's context. The
agent incorporates the guidance on its next AI call. Use this to course-correct
without stopping the run.

```
❯ /inject forge 9f4e2a1b use CSS Grid instead of Flexbox for the main layout
  ✓ Guidance injected into forge
```

### `/takeover <agent> <taskId>`

Transfers control of a task from the agent to you. The agent stops; the task
moves to `awaiting-human` state. When you're done, use the Autonauts panel to
hand the task back.

```
❯ /takeover forge 9f4e2a1b-c3d4-...
  ✓ Task taken over from forge
```

---

## Tips

- **Short IDs work.** The CLI accepts any string for `projectId` and `taskId`.
  If you paste a short ID (first 8 chars) it still resolves correctly because
  the underlying query matches by prefix — but always prefer the full UUID when
  you have it.

- **Combine with Agent Logs.** Open the **Agent Logs** tab alongside the
  Terminal tab. The logs show real-time subprocess output from every agent, so
  you can watch `/retry-task` take effect without switching panels.

- **`/sensei` is your escalation path.** Before reaching for `/deny` or
  `/takeover`, ask Sensei what's happening. It has the full project context and
  can often diagnose the root cause faster than reading raw logs.

- **The shell still works.** Non-`/` lines go straight to PowerShell / bash /
  CMD. You can mix regular shell commands and KageOps CLI commands in the same
  session. For example:

  ```
  ❯ /projects
  ❯ cd ~/.kageops/workspaces/landing-page-v2
  ❯ ls -la
  ❯ /retry-task 9f4e2a1b-...
  ```
