# Pro Tips — Dos and Don'ts

Patterns that change outcomes. Most of these came from real runs going
sideways. Worth reading even if you only have 5 minutes.

## How to write a project description

The single biggest quality lever isn't the model — it's the brief. A
weak brief produces weak output regardless of which preset you pick.

### ✅ DO

- **Spell out every required section / page / id.** Sensei decomposes
  the brief into agent tasks; Vigil checks the output against the brief.
  Specific IDs in the brief become specific assertions during
  acceptance retry.
- **Paste real reference content.** SVGs, color codes, design tokens,
  competitor screenshots, exact copy you want. The agents inline this
  verbatim — no game of telephone.
- **State the visual language as a list of rules**, not adjectives.
  "Slate #141414 surface, hairline #FFFFFF1A borders, no shadows"
  beats "modern minimal aesthetic".
- **Forbid things explicitly.** "No drop shadows. No gradients. No
  emoji." If a constraint isn't in the brief, the agents will guess.
- **Include the elements you want copied** (sigil SVG paths, brand
  marks, etc.) inline in the brief. Don't just point at a folder.

### ❌ DON'T

- **Don't write vague benefit copy.** "Beautiful and modern" is
  marketing language, not a brief.
- **Don't bury the requirements in prose.** Use bullet points and
  fenced code blocks. The decomposer parses structured briefs better
  than essays.
- **Don't reuse the same name twice for different projects.** KageOps
  duplicate-checks by slug; you'll either get a name conflict or
  Sensei picks up state from the previous run.
- **Don't omit the visual constraints if you have them** — the agents
  invent a colour palette in seconds and you'll lose 20 minutes
  iterating it back to your real brand.

## Watching a run

### ✅ DO

- **Watch the headless log for the settings banner.** First ~30 lines
  list the active preset, design provider, projects dir, budget cap.
  If any of those don't match your intent, kill and restart. 30
  seconds of confirmation saves a wasted run.
- **Open Mission Control alongside.** It surfaces Sensei's plan, the
  agent flow, and live cost ticker. The headless log is firehose — the
  UI is structured.
- **Open the workspace folder in your file manager.** As Forge writes
  files, you can `index.html` in the browser and see the in-progress
  result. Way faster than waiting for completion.
- **Tail the costs.** Per-agent spend in the Cost Intelligence panel.
  If one agent is consuming everything, that's a prompt problem — fix
  the brief or override the model on just that agent.

### ❌ DON'T

- **Don't `Ctrl-C` a headless run if you can help it.** The orchestrator
  cleans up tasks gracefully on SIGTERM but kill -9 leaves zombie
  rows in `tasks` and `agent_logs` that the next run trips on.
- **Don't ignore the `[headless] Design provider: …` line.** If it
  says `in-house` and you wanted `openai-ui`, the run is producing
  data for the wrong provider — see Troubleshooting.
- **Don't run two arms in the same data dir.** Each parallel run gets
  its own `KAGEOPS_DATA_DIR` (e.g. `~/.kageops-bench-A`,
  `~/.kageops-bench-B`). They share Postgres state otherwise and
  corrupt each other.

## When the output is weak

### ✅ DO (in this order)

1. **Improve the brief.** Add specifics. Inline reference content. State
   forbidden patterns. Wave 4-5 of KageOps showed prompt structure
   moves the composite score more than model swaps.
2. **Look at the AcceptanceGate failures** in the headless log. They
   tell you exactly which required IDs / classes are missing. Add
   them to the brief verbatim.
3. **Try `KAGEOPS_DESIGN_PROVIDER=claude-ui`** before reaching for a
   different preset. Pinning Sonnet with the design system prompt is
   often a bigger win than upgrading to Opus.
4. **Compare two presets head-to-head** with `scripts/benchmark-runner.ts`.
   You'll see real cost-per-quality data and stop guessing.

### ❌ DON'T

- **Don't reach for "use a bigger model" first.** It rarely solves the
  underlying problem (which is usually prompt or validation logic).
  And it doubles your cost.
- **Don't manually fix the output and re-run.** That's a one-shot win
  but doesn't scale. Fix the brief or the prompt instead — the agent
  will produce that better output every time after.
- **Don't enable APO until you have a baseline.** APO needs golden
  tasks and a sense of what "good" looks like. On day one you'd be
  optimizing for noise.

## Cost discipline

### ✅ DO

- **Always set `KAGEOPS_MAX_RUN_USD`.** Even if you trust the preset.
  Even if it's a small project. The cost killer is your last line of
  defence against a runaway loop.
- **Dry-run first** for any spec >2KB. The headless runner's
  `--dry-run` flag estimates tokens without spending. If the estimate
  is over your comfort, tighten the brief or raise the cap.
- **Use cheap models for cheap jobs.** Vigil's review tasks rarely
  benefit from Opus. Sensei's decomposition usually doesn't need
  Sonnet. Match the model to the work.
- **Watch `agent_logs.cost_usd`** in the Cost Intelligence panel during
  the run. If one agent is running away, kill the run, fix the brief,
  retry.

### ❌ DON'T

- **Don't run real projects without the cap.** A buggy loop with no
  cap can spend $50 in 10 minutes. There is no refund.
- **Don't enable Opus for every agent.** It's 5x Sonnet cost for tasks
  that don't need it. The premium presets pin Opus only where it
  matters.
- **Don't share an OpenAI / Anthropic key with paid usage if it's also
  on a free trial.** KageOps will happily burn your trial credits in
  one run.

## Phase gates and trust levels

### ✅ DO

- **Set `--trust low` for first runs** of a new project type. Sensei
  pauses for approval at every phase boundary so you can sanity-check.
- **Promote to `--trust medium` once you've tuned the brief** for that
  shape of project. Skips approvals between agents within a phase but
  still pauses at phase boundaries.
- **Use `--trust high` only for benchmark / replay runs** where you
  already know the output is going to be good.

### ❌ DON'T

- **Don't bypass acceptance retries.** When AcceptanceGate fails and
  Sensei spawns an `acceptance-fix` task, that's the system catching a
  real defect. Let it run.
- **Don't override Sensei's task plan** unless you really know the
  graph. The decomposer builds dependency edges that the manual flow
  doesn't reproduce.

## Benchmarking

### ✅ DO

- **Use `scripts/benchmark-runner.ts`** for any "preset A vs preset B"
  comparison. Single-arm runs feel useful but the comparison is what
  matters.
- **Spawn each arm in its own data dir.** Already covered by the
  benchmark runner — but worth knowing why: shared Postgres state
  poisons cross-arm comparisons.
- **Re-run after fixing tooling bugs.** Old benchmark data from before
  a fix doesn't compare to post-fix data — it represents a different
  product.

### ❌ DON'T

- **Don't compare arms with different specs.** You can vary the model
  OR the brief, not both.
- **Don't trust composite scores under 60.** They're not differentiated
  enough to draw conclusions; the noise floor is too high.
- **Don't shrug off "preset file missing — falling back to default"
  warnings.** That's the silent fallback that invalidates a benchmark.
  See Troubleshooting → "My preset isn't being used".

## When to ask Sensei vs change settings

### ✅ ASK SENSEI when

- You're unsure why a project went the way it did
- You want a recommendation on which preset to use for a new project
- You need to understand a phase failure or build error
- You want a tour of your agent_logs / cost data

### 🛠️ CHANGE SETTINGS when

- A specific model is wrong for a specific agent → Configuration →
  Agent Providers
- You hit a budget cap and need to raise it → `KAGEOPS_MAX_RUN_USD`
- Cross-cutting routing change → swap the active preset
- You want a different design language → swap design provider, not
  preset

Sensei doesn't know your billing or your subjective taste — so don't
ask it which model is "best", ask it which model fit which task in
**your runs.**
