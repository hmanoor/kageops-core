# Environment Variables

One-page reference. Sorted by what you'll touch most.

## The precedence rule (always)

Every setting follows the same precedence, **highest first**:

1. **Environment variable** (export in shell, `.env`, or process env)
2. **Per-data-dir config file** (e.g. `active-preset.txt`)
3. **UI dropdown** (in Configuration panel)
4. **Hard-coded default** (in `src/agents/agent-config.ts`)

If a setting "isn't taking effect", the answer is almost always that a
**higher-precedence layer is overriding you silently.** Check env first.

## Core routing

| Variable                       | What it does                                  | Default                |
|--------------------------------|-----------------------------------------------|------------------------|
| `KAGEOPS_PRESET`               | Which agent-config preset to use              | `claude-cli`           |
| `KAGEOPS_DESIGN_PROVIDER`      | Who generates the UI (Pixel only)             | `in-house`             |
| `KAGEOPS_DATA_DIR`             | Where presets/keychain/embedded PG live       | `~/.kageops/`          |
| `KAGEOPS_PROJECTS_DIR`         | Where new project workspaces are created      | platform default       |
| `DATABASE_URL`                 | If set, uses external Postgres; if not, PGlite | unset (embedded)      |
| `KAGEOPS_DB_MODE`              | `embedded` or `external` — explicit override   | auto-detect            |

## Cost guardrails (NON-NEGOTIABLE for live runs)

| Variable                       | What it does                                                       | Default        |
|--------------------------------|--------------------------------------------------------------------|----------------|
| `KAGEOPS_MAX_RUN_USD`          | Hard budget cap. Run is killed when spend ≥ this                   | `0.25`         |
| `KAGEOPS_MAX_AI_CALLS_PER_TASK`| Per-task askAI cap                                                 | `8`            |
| `KAGEOPS_MAX_TOKENS_<AGENT>`   | Override the per-agent maxTokens cap (uppercase agent name)        | per-preset     |
| `KAGEOPS_ZOMBIE_TIMEOUT_MS`    | Abort runs that decompose no tasks within this window              | `60000` (60s)  |

⚠️ Never run a real project without `KAGEOPS_MAX_RUN_USD`. Costs can run
hours in the background.

## Hosting & deployment (opt-in)

By default the **open build runs locally** — a green build + tests finishes a
project on your machine, no cloud account needed. To have KageOps **deploy your
generated app to Vercel** instead, set these:

| Variable               | What it does                                                                 | Default          | Read in |
|------------------------|-----------------------------------------------------------------------------|------------------|---------|
| `KAGEOPS_NO_HOSTING`   | `1` = run-locally (skip cloud deploy). The open build defaults to `1`; set `0` to enable deploy. | `1` (open build) | `src/shared/hosting-mode.ts` |
| `KAGEOPS_VERCEL_TOKEN` | Vercel deploy token (or store it in the OS keychain)                         | unset            | `src/deployers/vercel-deployer.ts` |
| `KAGEOPS_VERCEL_SCOPE` | Vercel team / username — avoids the "Loading teams…" hang                    | unset            | `src/deployers/vercel-deployer.ts` |
| `KAGEOPS_APP_ENV_FILE` | Dotenv file with the **built app's** runtime keys (Stripe, Clerk, Neon `DATABASE_URL`…) | unset | `src/orchestrator/app-env-file.ts` |

The `KAGEOPS_APP_ENV_FILE` keys are the **generated app's own** credentials —
KageOps injects them into `.env.local` for the build + the Vercel deploy, and
never into its own process env. (These have nothing to do with a KageOps
subscription; you bring your own Vercel + Stripe accounts.)

### The key register (desktop — no env file needed)

On desktop you don't need `KAGEOPS_APP_ENV_FILE` at all. In the New-Project
deployment section, enter the app secrets and tick **"Save these secrets to the
key register (OS keychain)"**. KageOps stores them in your OS keychain
(Windows Credential Manager / macOS Keychain / libsecret) keyed by project, and
picks them up automatically on later runs of that project. App-env resolution
order (highest first): `KAGEOPS_APP_ENV_FILE` → encrypted `deployment_config`
(commercial builds) → **key register** (open; the open build's persistent
store). Secrets never touch the repo or leave your machine. Read in
`src/main/app-env-keychain.ts`.

## Provider API keys

| Variable                  | Used by                                |
|---------------------------|----------------------------------------|
| `ANTHROPIC_API_KEY`       | Claude API preset, claude-ui provider  |
| `OPENROUTER_API_KEY`      | OpenRouter presets                     |
| `OPENAI_API_KEY`          | openai-ui design provider              |
| `GOOGLE_API_KEY`          | Gemini routing                         |
| `OLLAMA_API_KEY`          | Ollama Cloud (local Ollama needs none) |
| `GITHUB_TOKEN`            | GitHub integration (repos, PRs)        |

These are also stored in the OS Keychain — env vars are the fallback
when Keychain is unavailable (CI, headless, no `keytar`).

## Toggles

| Variable                  | What it does                                        | Default     |
|---------------------------|-----------------------------------------------------|-------------|
| `KAGEOPS_DISABLE_GIT`     | Short-circuits all git ops to no-ops (benchmarks)   | unset (off) |
| `KAGEOPS_APO_ENABLED`     | Turns on the nightly Auto Prompt Optimization       | unset (off) |
| `KAGEOPS_HEADLESS_TIMEOUT_MS` | Kill switch for headless runs                   | none        |

## Deploy-readiness gates (kill-switches)

Each deploy-readiness check is **blocking by default** (correctness over cost) —
a violation fails the gate and auto-spawns a Forge fix-task. Dial any of them to
`warn` (logged, non-blocking) or `off` (skipped) per run. Accepted values:
`block` / `warn` / `off`.

| Variable                            | Check                                                              | Default |
|-------------------------------------|-------------------------------------------------------------------|---------|
| `KAGEOPS_GATE_REQUIRED_INITIATOR`   | Brief implies payments ⇒ a checkout/subscription initiator exists | `block` |
| `KAGEOPS_GATE_PAYMENT_INTEGRITY`    | Payments wired correctly (signature-verify · env price · user-keyed) | `block` |
| `KAGEOPS_GATE_MODULE_INIT`          | G5 — no module-load-time SDK init reading `process.env`           | `block` |
| `KAGEOPS_GATE_MIGRATION`            | G6 — migrations apply cleanly to a fresh DB; seed/auth model ok   | `block` |
| `KAGEOPS_GATE_FABRICATION`          | No placeholder/fabricated values in shipped UI (lorem, fake contacts, unfilled gaps) | `block` |
| `KAGEOPS_GATE_E2E`                  | Run the generated Playwright suite as a build step                | `off`   |

`KAGEOPS_GATE_E2E` defaults **off** — Playwright needs browser binaries + a
running server, which most hosts lack; turn it on where e2e is set up.

### Self-heal retry budgets

When a gate fails, Sensei auto-dispatches a Forge/Aegis remediation task and
re-runs the gate, up to a per-loop budget; on exhaustion it escalates to a human.
Each budget is dial-able per run (integer, **clamped to `0..10`**). Set to `0`
to skip auto-remediation entirely and escalate on the **first** failure
(inspect-every-failure / cheap-run mode). Invalid or non-integer values fall
back to the default rather than aborting the run.

| Variable                            | Loop                                          | Default |
|-------------------------------------|-----------------------------------------------|---------|
| `KAGEOPS_MAX_BUILD_RETRIES`         | build-fix (build/test/static-check failures)  | `2`     |
| `KAGEOPS_MAX_ACCEPTANCE_RETRIES`    | acceptance-fix (missing IDs / vertical-slice) | `2`     |
| `KAGEOPS_MAX_DEPLOY_PREVIEW_RETRIES`| deploy-preview scheduling (Vercel)            | `2`     |

### Setup copilot

Sensei surfaces just-in-time credential prompts (Stripe/Clerk/DB) when a
project's brief needs them, validated at entry. Turn it off to suppress the
prompts entirely for a run.

| Variable                  | What it does                                        | Default  |
|---------------------------|-----------------------------------------------------|----------|
| `KAGEOPS_SETUP_COPILOT`   | `prompt` = surface credential setup proposals; `off` = silent | `prompt` |

## APO (Automatic Prompt Optimization)

Off by default. Opt in only.

| Variable                          | What it does                                       |
|-----------------------------------|----------------------------------------------------|
| `KAGEOPS_APO_ENABLED`             | Set to `1` to turn on the scheduler                |
| `KAGEOPS_APO_EVAL_MODEL`          | Model used to score candidate prompts              |
| `KAGEOPS_APO_MUTATOR_MODEL`       | Model used to generate prompt mutations            |
| `KAGEOPS_APO_MIN_DELTA`           | Min score improvement to persist a proposal        |

APO is propose-only — it never auto-applies a winning prompt. You
review and accept manually in the APO tab.

## Per-provider tuning

| Variable                          | Provider     | What it does                  |
|-----------------------------------|--------------|-------------------------------|
| `KAGEOPS_OPENAI_UI_MODEL`         | openai-ui    | Override (e.g. `openai/gpt-5.5`) |
| `KAGEOPS_OPENAI_UI_MAX_TOKENS`    | openai-ui    | Output cap                    |
| `KAGEOPS_CLAUDE_CLI_PATH`         | claude-cli   | Absolute path to the `claude` binary if not on PATH |
| `KAGEOPS_CLAUDE_CLI_TIMEOUT_MS`   | claude-cli   | Subprocess timeout (default 300000) |
| `KAGEOPS_CODEX_CLI_PATH`          | codex-cli    | Absolute path to the `codex` binary if not on PATH |
| `KAGEOPS_CODEX_CLI_TIMEOUT_MS`    | codex-cli    | Subprocess timeout (default 300000) |
| `KAGEOPS_CODEX_CLI_ARGS`          | codex-cli    | Space-separated extra args (e.g. `--approval-mode auto-edit`) |

## How to inspect what's actually set

In the running app: **Configuration → Environment** tab — every var is
listed with its current value.

In a shell: `env | grep KAGEOPS`
