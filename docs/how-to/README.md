# How-to guides

Short, narrated screen-capture videos of the real KageOps app — no mockups,
no staged UI. Each video is produced by an automated pipeline that drives the
actual application and records it, so guides are regenerated whenever the UI
changes and never drift from the product you're running.

Videos are hosted on GitHub's CDN (not committed to the repo), so cloning
stays lightweight.

## Episode 01 — First launch & setup wizard (1:55)

What the six-step first-launch wizard configures and why: choosing a model
preset (quality vs cost, per-agent models, CLI install commands), trust levels,
API keys (stored in your OS keychain, never plaintext), the per-run budget
kill-switch, and landing in the New Project flow with your defaults pre-wired.

https://github.com/user-attachments/assets/ce1a32b3-4419-4181-b78b-21ff2312cdbe

## Episode 02 — Your first project: writing the brief (1:44)

The New Project screen, end to end: writing a brief that gets good results,
project types and deployment configuration, the Phases & Tasks tree with quick
presets (hand-pick exactly what the agents may do), the budget cap and trust
level, and what Dry Run vs Create & Start each mean.

https://github.com/user-attachments/assets/b4b63d0c-ca79-4373-9f24-de8e11bd386c

## Episode 03 — The live run, end to end (2:11)

A real supervised run, filmed start to finish. Sensei decomposes the brief, the
Autonauts work through all six phases, and each phase gate pauses for a human
approval on camera — six of them. Agent work runs in timelapse; the run finishes
with a completed project and a build report. Real models, real spend, no cuts
that hide a failure.

https://github.com/user-attachments/assets/4c1fdc49-8a68-4c11-a55c-c9980e76626b

## Episode 04 — What did it build? (1:20)

Reviewing the output honestly. The Completed tab and project card, the artifact
browser, a look at the actual generated code, the build report with per-agent
detail, and the produced page rendered live in the app.

https://github.com/user-attachments/assets/b6158b73-bcd6-4426-b75a-8815c7140f65

## Episode 05 — The Command Center tour (1:36)

The whole surface in one pass: operating modes (supervised / autonomous /
direct), the project board with filters and search, the orchestration flow graph
and its fullscreen view, the bottom panel (agent activity, approvals, logs, CLI,
build), the agent roster, model routing, cost intelligence, and the Sensei chat
dock.

https://github.com/user-attachments/assets/05809cef-8584-4bc4-9ba7-be7913b31e12

## Episode 06 — Agents & model routing (1:36)

Which model runs which agent, and how to change it. The nine-agent roster and
scorecard, per-agent model configuration, the preset grid with a preset switched
on camera, fallback chains for when a provider fails, and building a custom
preset.

https://github.com/user-attachments/assets/6be35ead-3b23-4c07-bd9c-a363a0ffb58d

## Episode 07 — Trust, gates & intervention (1:24)

How you stay in control of a running project. A live run where one gate is
approved, the next is **denied** — and returns after the agents rework it —
plus pausing and resuming mid-run, and the cascade to completion once you let
it go.

https://github.com/user-attachments/assets/4382aaea-e885-42a7-915b-ed36dde0a3ef

## Episode 08 — Cost controls (1:57)

The money guardrails, end to end. The per-project budget cap as a hard kill (not
a warning), dry-run-first, the Cost Intelligence ledger with per-agent and
per-provider breakdowns, editing a running project's cap and watching it take
effect, and the layers underneath: per-task call caps, per-agent token limits,
and a stall timeout.

https://github.com/user-attachments/assets/8d95a406-ab0e-4a4a-b0ff-b45be6e9c82c

## Episode 09 — Headless runner & CLI (2:12)

The engine from a plain terminal — no window, one command, an exit code. Config
via environment variables, the dry-run plan and its per-preset cost estimate, and
a live run in timelapse. It ends honestly: after three repair attempts the
artifact still missed an element the brief required, so the acceptance gate
refused to sign off and asked for a human. Headless will approve a phase; it will
never rubber-stamp a quality failure.

https://github.com/user-attachments/assets/7603589b-2a50-43ae-858b-3a665c51a75c

---

Prefer text? The same ground is covered in the [Quickstart](../../README.md#quickstart).
