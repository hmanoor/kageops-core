# Mission Control

Mission Control is the default view — the first thing you see when KageOps
opens. It has three zones: left sidebar, centre flow, and right (Sensei chat).

## Left sidebar

**Operation mode** (top three buttons):

| Mode         | What it does                                                     |
|--------------|------------------------------------------------------------------|
| Supervised   | Agents work; you approve at phase gates. Default.                |
| Autonomous   | Agents proceed through all phases after Design & Planning.       |
| Chat Only    | Sensei and the Gatekeepers (Ping/Zing) chat only; no orchestration. |

**Project list** (below mode): every project in the active data dir, sorted
most-recent-first. Status dots: grey (pending), amber (running), green
(complete), red (error / awaiting approval).

**Activity feed** (bottom): a rolling tail of the last ~200 agent events
across all projects. Click any row to see the full event payload (prompt,
response, cost). Also available as a dedicated full-page view in the Activity
tab on the left rail.

Collapse the sidebar with the `‹` button in its header to give more room
to the flow panel.

## Centre: Agent Flow

The flow panel shows the current project's agent work as a series of tiles.

Each tile shows:
- **Agent name** + sigil
- **Current task** title
- **Status indicator**: idle / working / complete / failed
- **Elapsed time** for the current task

Click a tile to expand it — you'll see the agent's **streaming output** as
it works: its reasoning, the code it's writing, any tool calls it makes.

If a task fails, the tile turns red and shows the last error line. Expand it
to see the full stack trace / AI response.

### Phase progress bar

Above the flow tiles, a horizontal bar shows which phase you're currently in
and how many of the six phases are complete. Completed phases are filled;
the active phase pulses.

### Approval prompts

When Sensei needs your input (gate failure, trust boundary), a banner appears
above the flow tiles:

```
⚠ Sensei needs your approval — [Review] [Approve] [Reject]
```

Click **Review** to read the full escalation in the Sensei chat before
deciding.

## Right: Sensei Chat

Open with the speech-bubble icon in the top-right, or press `⌘ /` (`Ctrl /`
on Windows). This is a direct line to the Sensei orchestrator.

What you can ask Sensei:

- "Why did this phase fail?"
- "What's the plan for Phase 5?"
- "Which agent is slowest right now?"
- "What's my total cost for this project?"
- "Show me the acceptance failures for this run."

What Sensei can't do:

- Re-route tasks that are already assigned.
- Override gate decisions retrospectively.
- Know your personal billing details or platform account.

Sensei also has a second personality in the UI — **the Gatekeepers** (Ping
and Zing), two foil characters that audit plans from opposing angles. They
appear in the chat when Sensei is reviewing a phase output.

## Starting a project

1. Click **New project** (top-right button in Mission Control).
2. Fill in the name (used as the workspace slug) and description.
3. Optional: paste reference content, SVGs, design tokens, or requirements
   directly into the description — agents will use it verbatim.
4. Set **Trust level**: Low (approve each phase), Medium (approve between
   phases), High (auto-proceed everywhere after Design).
5. Click **Start**. Sensei will begin decomposing immediately.

## Keyboard shortcuts

| Shortcut             | Action                              |
|----------------------|-------------------------------------|
| `⌘ /` / `Ctrl /`    | Open / close Sensei chat            |
| `⌘ K` / `Ctrl K`    | Open Command Palette                |
| `⌘ N` / `Ctrl N`    | New project                         |
| `Esc`                | Close modal / overlay               |

## Notifications

The bell icon (top-right header) shows system notifications:
- Phase gate decisions
- Budget cap warnings
- Approval requests
- Agent errors that blocked a task

Click **Mark all read** to clear them.
