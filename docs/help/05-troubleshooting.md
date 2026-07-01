# Troubleshooting

Most KageOps surprises come from **silent fallbacks** — the app keeps
running but with different settings than you intended. Always check the
log first; the warnings are there.

## "My preset isn't being used"

**Symptom:** you set `KAGEOPS_PRESET=claude-cli-premium`, expect Claude
Opus, but the run feels weak / cheap / wrong.

**Likely cause:** the preset file is missing in your active data dir.
KageOps falls back to defaults silently.

**Log clue:**
```
"Preset set but file missing — falling back to default"
```

**Fix:**
```bash
ls "$KAGEOPS_DATA_DIR/agent-config.<preset-name>.json"
# if missing, delete any stale .json and restart so ensurePresetFiles()
# re-seeds from the latest template:
rm "$KAGEOPS_DATA_DIR/agent-config.<preset-name>.json"
# or copy the template manually from your default ~/.kageops/
```

## "My design provider isn't being used"

**Symptom:** you set `KAGEOPS_DESIGN_PROVIDER=openai-ui` (or `claude-ui`)
but the UI looks like it came from your default model.

**Possible causes:**

1. **API key missing.** The provider's `isAvailable()` returned false →
   silent fall-back to `in-house`.
2. **Provider id typo or unsupported value.** The id check fails →
   silent fall-back to `in-house`.

**Log clue:**
```
[headless] Design provider: in-house
```
when you expected to see `[headless] Design provider: openai-ui`.

**Fix:**
- Confirm the key is in env or keychain: `echo ${OPENAI_API_KEY:0:10}`
- Confirm the value spells exactly: `in-house | claude-ui | openai-ui`
- The key takes effect at process start — restart the runner / Electron
  after dropping it.

## "Run hangs and never decomposes tasks"

**Symptom:** Sensei boots, project is created, but no tasks ever appear.

**Cause:** `KAGEOPS_ZOMBIE_TIMEOUT_MS` will eventually abort the run
(default 60s). Common root causes:

- LLM provider unreachable (network blocked)
- API key invalid / out of quota
- Wrong model name in preset (provider rejects it)

**Log clue:** look for HTTP errors from the AI adapter shortly after
`decompose() invoked`. The first task decomposition is always the canary.

## "git checkout failed: not a git repository"

**Symptom:** every agent log line says `git checkout -b ... failed`.

**Cause:** the workspace isn't a git repo — usually because the project
slug had Unicode characters (em-dash `—`, en-dash `–`, accented letters)
that the slug validator rejected. KageOps fell back to a "bare directory"
with no `.git`.

**Workaround:**
```bash
export KAGEOPS_DISABLE_GIT=1
# turns off all git ops — branches, commits, merges become no-ops
```

**Real fix:** rename the project to ASCII-only.

## "claude-cli / codex-cli says 'binary not found'"

**Symptom:**
```
Claude CLI binary not found. Install with `npm install -g @anthropic-ai/claude-code` …
Codex CLI binary not found. Install with `npm install -g @openai/codex` …
```

**Cause:** Electron processes don't always inherit the shell `PATH`, so
even when `which claude` / `which codex` works in your terminal the
spawn() call inside KageOps can still fail.

**Fix:** point KageOps at the absolute binary path:
```bash
export KAGEOPS_CLAUDE_CLI_PATH=/opt/homebrew/bin/claude
export KAGEOPS_CODEX_CLI_PATH=/opt/homebrew/bin/codex
# Windows examples:
#   KAGEOPS_CLAUDE_CLI_PATH=C:\Users\you\AppData\Roaming\npm\claude.cmd
#   KAGEOPS_CODEX_CLI_PATH=C:\Users\you\AppData\Roaming\npm\codex.cmd
```

If the CLIs aren't installed, install them:
```bash
npm install -g @anthropic-ai/claude-code   # claude-cli preset
npm install -g @openai/codex               # codex-cli preset
```

## "codex-cli preset returns 401 / Authentication failed"

**Cause:** `OPENAI_API_KEY` is set in your env. Codex CLI uses API-key
mode (paid pay-per-token) when the key is present instead of the
ChatGPT subscription. KageOps strips this from the subprocess env, but
a stale `.env` file or shell export elsewhere can re-introduce it.

**Fix:**
1. `unset OPENAI_API_KEY` in the shell that launches KageOps
2. Remove `OPENAI_API_KEY=` lines from any `.env` that the app might be loading
3. Sign in interactively once: `codex login` (Codex stores its
   subscription token outside the env)
4. Restart Electron / the headless runner

The same pattern applies to `claude-cli` with `ANTHROPIC_API_KEY` —
remove it from env and run `claude login` interactively.

## "Sensei reports 'provider: claude' even though I picked the codex-cli preset"

**Cause:** older builds (before the `parseModelString` fix) defaulted
bare CLI provider names to the Claude API. The seeded preset shipped
with bare `'codex-cli'` model strings that silently routed to Anthropic.

**Fix:** upgrade to a build that includes the
`fix(ai-adapter): route bare codex-cli/claude-cli model strings`
patch. Then either:
- delete `<KAGEOPS_DATA_DIR>/agent-config.codex-cli.json` and restart
  so the seeder re-writes the canonical `codex-cli/codex-cli` form, or
- edit the file by hand and replace each `"model": "codex-cli"` with
  `"model": "codex-cli/codex-cli"`.

Confirm the routing by typing `/models` in the Command Center — the
truth-block should now report `provider: codex-cli` for every agent.

## "Run was killed at 95% — what happened?"

**Cause:** `KAGEOPS_MAX_RUN_USD` cap hit. The budget killer polls every
3 seconds; once `MAX(SUM(agent_logs.cost_usd), tokens_out * $3/M) >= cap`,
the run is aborted.

**Log clue:** `Budget cap reached — cancelling project`.

**Fix:** raise the cap (`export KAGEOPS_MAX_RUN_USD=2.00`) and re-run.
Always start with a dry run first to estimate.

## "Where is the workspace? I can't find the output"

The run writes to:
```
$KAGEOPS_PROJECTS_DIR/<project-slug>/
```

If you didn't set `KAGEOPS_PROJECTS_DIR`, it defaults to a platform path.
You can confirm in the headless runner output:
```
Projects Dir: <path>
```

## "I changed a setting in Configuration but nothing happened"

Most settings are read **at process start**. After changing an env var
or preset:

1. Save / write the value
2. Stop any in-flight runs
3. Restart Electron (or the headless runner)

The exception: **Per-Agent overrides** (Configuration → Agent Providers)
take effect on the next task pickup, not the next process boot.

## Still stuck?

- Check **Configuration → Environment** for the actual resolved values
- Check **Configuration → About** for which preset and design provider
  are currently active
- The headless runner prints a settings banner at the top of its log —
  confirm everything matches expectations before letting it run
