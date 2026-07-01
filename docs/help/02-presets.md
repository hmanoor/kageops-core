# Presets

A **preset** is a JSON file that says which AI model each of your nine
agents uses. Different presets exist for different price/quality tradeoffs.

## The three you'll actually use

| Preset                  | Cost / project | When to use it                                      |
|-------------------------|----------------|-----------------------------------------------------|
| `claude-cli-premium`    | $0 (sub) — slow | Default when you have a Claude Pro subscription     |
| `codex-cli`             | $0 (sub) — slow | When you have a ChatGPT Plus / Pro subscription instead |
| `openrouter_standard`   | ~$0.30–$2.00   | Best quality per dollar; pay-per-token              |
| `openrouter_budget`     | ~$0.05–$0.30   | Cheap exploration runs                              |
| `ollama`                | $0 (local)     | Fully offline; quality varies per local model       |

Both `claude-cli-premium` and `codex-cli` route every agent through a
local CLI binary against your existing subscription — no API keys
required. Pick the one that matches whichever assistant you already pay
for. Install commands:

```bash
# Claude CLI — requires a Claude Pro subscription
npm install -g @anthropic-ai/claude-code

# Codex CLI — requires a ChatGPT Plus / Pro subscription
npm install -g @openai/codex
```

## Where do presets live?

```
<KAGEOPS_DATA_DIR>/agent-config.<preset-name>.json
```

`KAGEOPS_DATA_DIR` defaults to `~/.kageops/`. So out of the box:

```
~/.kageops/agent-config.claude-cli-premium.json
~/.kageops/agent-config.codex-cli.json
~/.kageops/agent-config.openrouter_standard.json
…
```

Each file maps every agent (`scout`, `blueprint`, `pixel`, etc.) to a
specific model and a `maxTokens` cap.

## How a preset is selected

Priority, highest first:

1. `KAGEOPS_PRESET=<name>` environment variable
2. `<KAGEOPS_DATA_DIR>/active-preset.txt` (one line, the preset name)
3. The preset selected in the UI dropdown (Configuration → About → Preset)
4. Default: `claude-cli` (subscription routing)

## ⚠️ The preset trap

If `KAGEOPS_PRESET=foo` points to a file that **doesn't exist**, KageOps
will log a warning and **silently fall back to defaults** instead of
failing. The defaults are the values hard-coded in
`src/agents/agent-config.ts` — usually `ollama/gpt-oss:120b-cloud` for
most agents.

Symptom: you set a premium preset, expect Opus 4.7, but the run goes
through Ollama and the output looks weak.

How to spot it in the log:

```
"Preset set but file missing — falling back to default"
```

How to fix:

```bash
# delete any stale preset file so the app re-seeds it
rm "$KAGEOPS_DATA_DIR/agent-config.<name>.json"
# restart Electron — ensurePresetFiles() will write a fresh template
```

Or copy the template manually from your default `~/.kageops/` location.

## Per-agent overrides

You can override one agent without writing a whole new preset.

In **Configuration → Agent Providers**, pick an agent (e.g. Pixel),
choose a model + provider. This **supersedes** the active preset for
that single agent only. Useful for "I want Opus only for design, not for
the rest of the team".
