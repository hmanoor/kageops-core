# Design Providers

A **design provider** is who actually generates the visual UI for Pixel's
`ui-build` task. It's a separate concept from the preset — the preset
controls everything else, but UI generation is special enough to have
its own switch.

## The providers

| Provider     | What it uses                                            | When to pick it                                       |
|--------------|---------------------------------------------------------|-------------------------------------------------------|
| `in-house`   | Pixel's preset-configured model (whatever it is)        | Default. Cheapest. Quality follows the preset.        |
| `claude-ui`  | Pinned Claude Sonnet with a design-tuned system prompt  | Better visual quality than in-house, predictable cost |
| `openai-ui`  | OpenAI GPT-5.x via the OpenAI API directly              | Strong on Tailwind / dense visual layouts             |
| `v0`         | Vercel v0 (not yet wired)                               | —                                                     |
| `figma`      | Figma importer (not yet wired)                          | —                                                     |
| `locofy`     | Locofy (not yet wired)                                  | —                                                     |

## How a provider is selected

Priority, highest first:

1. `KAGEOPS_DESIGN_PROVIDER=<name>` environment variable
2. `<KAGEOPS_DATA_DIR>/active-design-provider.txt` (single-line file)
3. The dropdown in **Configuration → About → Active Design Provider**
4. Default: `in-house`

## ⚠️ Important: this is independent of the preset

`KAGEOPS_PRESET=claude-cli-premium` and
`KAGEOPS_DESIGN_PROVIDER=openai-ui` are **two separate switches**. The
preset still controls Sensei, Scout, Blueprint, Forge, Cipher, Aegis,
Vigil, and Herald. Only **Pixel's UI-generation step** routes through
the design provider.

Mental model: the design provider is a "Pixel-only override" that wraps
the preset's Pixel slot.

## API keys required

Each non-in-house provider needs its own key in the keychain or env:

| Provider     | Key var (env)        | Notes                                  |
|--------------|----------------------|----------------------------------------|
| `claude-ui`  | `ANTHROPIC_API_KEY`  | Same key as Claude API preset          |
| `openai-ui`  | `OPENAI_API_KEY`     | Required — provider falls back without |
| `v0`         | `V0_API_KEY`         | Provider not implemented yet           |

If the key is missing, `provider.isAvailable()` returns false and Sensei
falls back to `in-house` **silently** (logs only, no UI alert). Always
check the log for `[headless] Design provider: <name>` to confirm.

## Quick switch

In the UI:

1. Open **Configuration** (gear icon, bottom-left).
2. Drop your key in the **API Keys** tab.
3. Open the **About** tab.
4. Pick the provider in **Active Design Provider** dropdown.
5. Restart the run.

From a shell, for a one-off run:

```bash
export KAGEOPS_DESIGN_PROVIDER=openai-ui
export OPENAI_API_KEY=sk-...
npm run dev
```
