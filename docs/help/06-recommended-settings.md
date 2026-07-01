# Recommended Settings

Pre-baked recipes for the four scenarios people actually use KageOps in.
Pick the one that matches your situation, drop in the env vars, restart.

## 1. "Just exploring — what does this thing do?"

You want to see KageOps run end-to-end on small projects without
spending money or thinking about settings.

```bash
export KAGEOPS_PRESET=ollama                  # local Ollama models
export KAGEOPS_DESIGN_PROVIDER=in-house        # whatever the preset says
export KAGEOPS_MAX_RUN_USD=0.50                # safety cap (won't be hit)
export KAGEOPS_DISABLE_GIT=1                   # skip per-task branches
```

Pre-reqs: have Ollama running locally with one decent coding model
(e.g. `qwen3-coder-next:cloud` via Ollama Cloud, or `qwen2.5-coder:14b`
locally if you have the GPU).

Quality: low–medium. Speed: depends on your hardware. Cost: $0.

## 2. "Subscription user — Claude Pro / Max"

You already pay for Claude Pro and want the best quality your sub gets you.

```bash
export KAGEOPS_PRESET=claude-cli-premium       # Opus 4.7 across the team
export KAGEOPS_DESIGN_PROVIDER=in-house        # let preset's Pixel slot drive UI
export KAGEOPS_MAX_RUN_USD=2.00                # ignored under sub but set anyway
export ANTHROPIC_API_KEY=$YOUR_KEY             # CLI usage falls back to this
```

This routes everything through the Claude CLI, so cost is $0 against
your Pro subscription. Pixel uses Opus 4.7 (best UI quality available
without paying per-token).

If you want to A/B GPT-5 against Opus for design only:
```bash
export KAGEOPS_DESIGN_PROVIDER=openai-ui
export OPENAI_API_KEY=sk-...
```
Now Pixel routes through OpenAI directly while everything else stays
on the Claude subscription.

## 2b. "Subscription user — ChatGPT Plus / Pro"

You pay for ChatGPT instead of (or as well as) Claude. KageOps will
route every agent through the local Codex CLI against your subscription.

```bash
export KAGEOPS_PRESET=codex-cli                # all agents → codex CLI
export KAGEOPS_DESIGN_PROVIDER=in-house         # preset-driven Pixel
export KAGEOPS_MAX_RUN_USD=2.00                 # ignored under sub but set anyway
unset OPENAI_API_KEY                            # avoid pay-per-token mode
# Optional: pin a specific Codex model
# export KAGEOPS_CODEX_CLI_ARGS="--approval-mode auto-edit"
```

Pre-reqs:
- `npm install -g @openai/codex`
- Run `codex login` once interactively (Codex stores its subscription
  token outside the env)

Cost: $0 against your ChatGPT subscription. Speed: similar to
claude-cli — bounded by the CLI's per-request latency. Quality: very
strong on engineering / dev-tooling tasks.

## 3. "Pay-per-token — best quality per dollar"

You want OpenRouter's price arbitrage — frontier-quality output for the
cheapest model that does the job per agent.

```bash
export KAGEOPS_PRESET=openrouter_standard
export KAGEOPS_DESIGN_PROVIDER=claude-ui       # pin Sonnet for UI, others get cheaper models
export KAGEOPS_MAX_RUN_USD=2.00                # hard cap PER PROJECT — start here
export OPENROUTER_API_KEY=sk-or-...
export ANTHROPIC_API_KEY=$YOUR_KEY             # claude-ui needs this directly
```

Typical project cost: $0.30–$2.00 depending on size. The composite
quality on the Landing Page benchmark is usually within 5 points of
the all-Opus subscription run.

## 4. "Privacy-first — fully local"

You can't (or won't) send data off-machine. Everything runs locally.

```bash
export KAGEOPS_PRESET=ollama
export KAGEOPS_DESIGN_PROVIDER=in-house
export KAGEOPS_DB_MODE=embedded                 # default, but explicit
unset DATABASE_URL                              # don't accidentally hit external pg
unset OPENROUTER_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY
```

Pre-reqs: local Ollama with capable models. For decent design output
you need at least a 7-30B coder model.

Quality: depends entirely on your local model. Cost: $0 + electricity.

## Cost cap reference

`KAGEOPS_MAX_RUN_USD` is a **hard kill** — KageOps polls every 3
seconds and aborts when spend hits the cap. Recommended starting points:

| Project type            | Cap         |
|-------------------------|-------------|
| Static landing page     | $0.50–$2.00 |
| Single-page app (SPA)   | $1.00–$3.00 |
| Multi-page CRUD app     | $3.00–$8.00 |
| Full backend + frontend | $5.00–$15.00|

Always **dry-run first** (`--dry-run` on the headless runner) to get a
token estimate before running for real.

## Per-agent overrides (advanced)

You don't need a custom preset to swap one agent's model. Open
**Configuration → Agent Providers** and pin individual agents:

- Pixel on Opus, everyone else on Sonnet — best ROI for UI-heavy work
- Forge on Sonnet, Vigil on Haiku — Vigil's reviews barely benefit from Opus
- Sensei on a fast model, others on what they need — Sensei does
  decomposition, doesn't need raw IQ

These overrides supersede the preset for that single agent only.

## When to flip APO on

`KAGEOPS_APO_ENABLED=1` turns on Auto Prompt Optimization. **Don't enable
it on day one.** Wait until you've done 5+ runs and have a sense of
where prompts are weak. APO proposes prompt mutations overnight and
scores them against a golden-task corpus. It never auto-applies.

Recommended once you've earned the right to APO:
```bash
export KAGEOPS_APO_ENABLED=1
export KAGEOPS_APO_EVAL_MODEL=openrouter/openai/gpt-4o-mini  # cheap eval
export KAGEOPS_APO_MIN_DELTA=0.05                            # only persist >5% improvements
```
