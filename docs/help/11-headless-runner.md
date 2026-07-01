# Headless Runner

The headless runner lets you trigger the full KageOps pipeline from the
command line — no Electron window required. It's how benchmarks, CI runs,
and automated project generation work.

## Basic usage

```bash
# Dry run first — no AI calls, no spend
npx tsx src/cli/headless-runner.ts --dry-run \
  --name "MyApp" \
  --description "A landing page for a time-tracking SaaS"

# Live run with a budget cap
KAGEOPS_PRESET=openrouter_standard \
KAGEOPS_MAX_RUN_USD=1.00 \
  npx tsx src/cli/headless-runner.ts \
  --name "MyApp" \
  --description "..."

# Pass the description from a file (for long briefs)
npx tsx src/cli/headless-runner.ts \
  --name "MyApp" \
  --description-file path/to/spec.txt
```

## All flags

| Flag                      | Description                                                         |
|---------------------------|---------------------------------------------------------------------|
| `--name <name>`           | Project name. Used as the workspace slug.                           |
| `--description <text>`    | Project brief. Inline string.                                       |
| `--description-file <path>` | Load brief from a file. Preferred for long specs.               |
| `--dry-run`               | Parse and plan only — no AI calls, no workspace, no spend.          |
| `--resume <project-id>`   | Resume an interrupted project from its last known phase.            |
| `--trust <low\|medium\|high>` | Phase gate trust level. Default: `low`.                       |
| `--preset <name>`         | Override `KAGEOPS_PRESET` for this run only.                        |

## Reading the settings banner

Every live run prints a settings banner at the top:

```
─────────────────────────────────────────
 KageOps Headless Runner
─────────────────────────────────────────
 Project:         MyApp
 Preset:          openrouter_standard
 Design Provider: claude-ui
 Projects Dir:    /Users/you/kageops-projects
 Data Dir:        /Users/you/.kageops
 Budget cap:      $1.00
 Trust level:     low
 Git:             enabled
─────────────────────────────────────────
```

**Always confirm this matches your intent before the run reaches Phase 2.**
If any line is wrong, `Ctrl-C` and correct the env var.

## Dry run

`--dry-run` is free. It runs Sensei's decomposition logic against your brief,
prints the planned tasks and phase breakdown, and exits. Use it to:

- Estimate how many tasks the run will produce (correlates with cost).
- Catch brief parsing issues before spending money.
- Verify the preset and design provider are wired correctly.

A dry run that produces 0 tasks usually means the brief is malformed or the
zombie timeout is too short.

## Resuming interrupted runs

```bash
npx tsx src/cli/headless-runner.ts --resume <project-id>
```

`project-id` is a UUID printed in the settings banner:
```
 Project ID:      a1b2c3d4-...
```

The runner loads the project from the database, checks `projects.current_phase`,
and re-routes any pending tasks or decomposes the phase fresh. Cost tracking
continues from the existing run record.

## Running parallel benchmark arms

Each arm needs its own data dir and projects dir to avoid PGlite lock
contention and cross-arm state pollution:

```bash
# Arm A
KAGEOPS_DATA_DIR=~/.kageops-bench-A \
KAGEOPS_PROJECTS_DIR=~/bench/arm-A \
KAGEOPS_PRESET=openrouter_standard \
  npx tsx src/cli/headless-runner.ts --name "BenchA" --description-file spec.txt &

# Arm B
KAGEOPS_DATA_DIR=~/.kageops-bench-B \
KAGEOPS_PROJECTS_DIR=~/bench/arm-B \
KAGEOPS_PRESET=claude-cli-premium \
  npx tsx src/cli/headless-runner.ts --name "BenchB" --description-file spec.txt &

# Arm C — Codex CLI subscription
KAGEOPS_DATA_DIR=~/.kageops-bench-C \
KAGEOPS_PROJECTS_DIR=~/bench/arm-C \
KAGEOPS_PRESET=codex-cli \
  npx tsx src/cli/headless-runner.ts --name "BenchC" --description-file spec.txt &
```

Or use `scripts/benchmark-runner.ts` which handles data-dir isolation and
parallel spawning automatically.

## Disabling git for throwaway runs

```bash
KAGEOPS_DISABLE_GIT=1 \
  npx tsx src/cli/headless-runner.ts ...
```

Git ops become no-ops — no `git init`, no per-task branches, no commits.
The pipeline still runs end-to-end. Useful for benchmarks where you don't
want commit history.

## Approval handling in headless mode

When Sensei emits `approval.required` (gate failure, budget hit), the
headless runner prints the escalation and waits indefinitely. It will NOT
auto-approve even at `--trust high`.

To approve from the shell, open the Command Center in Electron and use the
approval queue, or use the forthcoming `--auto-approve-gates` flag (not yet
implemented).
