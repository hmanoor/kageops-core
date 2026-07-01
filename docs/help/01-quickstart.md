# Quickstart

Welcome to KageOps. This is the 60-second version.

## First launch — the setup wizard

The first time you open KageOps, a 6-step **setup wizard** walks you through
the essentials so you don't have to hunt through Settings:

1. Welcome
2. **Pick a model preset** — `claude-cli-premium` (Claude Pro subscription), `codex-cli` (ChatGPT Plus / Pro subscription), `openrouter_budget` (cheapest), or `ollama` (100% local)
3. **Trust level** — how autonomous Sensei should be
4. **API keys** — only the ones your chosen preset needs (stored in OS Keychain)
5. **Default budget cap** — hard kill in USD per run
6. Ready — drops you into the New Project modal with everything prefilled

You can skip the wizard at any step (top-right `×`) and re-run it later from
the command palette: `⌘K` / `Ctrl+K` → "Run setup wizard".

Every time you click **New Project** afterwards, a small **quickflow drawer**
on the right of the modal shows a 4-item checklist that auto-ticks as you
fill the form. Settings inherit from your last project; tick "Don't show
this again" if you want it out of the way.

## What is KageOps?

KageOps is a desktop app that runs **a team of nine AI agents** to take an
idea from concept to shipped product. You describe what you want, and the
agents — coordinated by **Sensei** — research, design, code, review, and
deploy it.

The agents are called the **Autonauts**:

| Agent     | Role                                  |
|-----------|---------------------------------------|
| Sensei    | Orchestrator. Plans, routes, gates.   |
| Scout     | Researcher. Markets, prior art.       |
| Blueprint | Architect. System design.             |
| Pixel     | Designer. Visual + interaction.       |
| Forge     | Engineer. Writes the code.            |
| Cipher    | Data specialist. Schemas, queries.    |
| Aegis    | Platform engineer. Infra, deploys.    |
| Vigil     | Quality guardian. Reviews, tests.     |
| Herald    | Marketer. Copy, launch.               |

## Your first project

1. Open the **Mission Control** view (left rail, home icon).
2. Click **New project** in the top-right.
3. Give it a name and a description. The richer the description, the
   better the result — paste designs, requirements, links.
4. Click **Start**. Sensei will decompose the work, route it to agents,
   and stream progress live.
5. Watch the **agent flow** in the centre panel. Each tile shows the
   agent's current task; click for the streaming output.

## Three things to understand before you ship a real project

These three concepts trip everyone up. Each has its own page:

- **[Presets](02-presets.md)** — which model each agent uses
- **[Design providers](03-design-providers.md)** — who builds the UI
- **[Environment variables](04-env-vars.md)** — how everything is wired

If a run does something unexpected, the answer is almost always one of
these three. Start with **[Troubleshooting](05-troubleshooting.md)** when
that happens.

## Where things live

| Where                                              | What's there                              |
|----------------------------------------------------|-------------------------------------------|
| `~/.kageops/` (or `KAGEOPS_DATA_DIR`)              | Presets, active selections, embedded PG   |
| `<KAGEOPS_PROJECTS_DIR>/<project-slug>/`           | The actual code your agents wrote         |
| `agent_logs` table (in PG)                         | Every action, every cost, every retry     |
| Mission Control → Cost Intelligence                | Per-agent spend, per-project totals       |
| Mission Control → Code Graph                       | Module + function call graph              |
| `docs/runs/<timestamp>_<slug>.md`                  | Auto-generated run report after each project |

## What to read next

- **[Recommended settings](06-recommended-settings.md)** — pre-baked
  recipes for the four scenarios people actually use KageOps in.
- **[Pro tips · do/don't](07-pro-tips.md)** — the brief-writing,
  cost-discipline, and benchmarking patterns that separate a great
  run from a wasted one.
- **[Presets](02-presets.md)** + **[Design providers](03-design-providers.md)**
  — the two concepts that account for ~80% of "why is the output not
  what I expected" questions.
