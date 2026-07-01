/**
 * Parse a model string of the form `provider/model` into a ProviderConfig.
 *
 * Special-case: bare strings that are themselves a CLI provider name
 * (`claude-cli`, `codex-cli`) are treated as `<provider>/<provider>` so
 * the dispatcher routes correctly. Without this, a bare `codex-cli`
 * model string falls into the generic "no slash → claude provider"
 * default and silently routes to the Claude API — the runtime bug user
 * caught on 2026-05-10 where the codex-cli preset's `{model: "codex-cli"}`
 * entries were being parsed as `{provider: "claude", model: "codex-cli"}`
 * and breaking subscription routing.
 *
 * Other bare strings (e.g. legacy `claude-sonnet-4-20250514` aliases)
 * still default to the Claude provider.
 */

import type { AiProvider, ProviderConfig } from './types';

const BARE_CLI_PROVIDERS: ReadonlyArray<AiProvider> = ['claude-cli', 'codex-cli'];

export function parseModelString(modelString: string): ProviderConfig {
    const parts = modelString.split('/');

    if (parts.length === 1) {
        const bare = parts[0];
        if ((BARE_CLI_PROVIDERS as readonly string[]).includes(bare)) {
            // Bare CLI provider name → use it as both provider and model.
            // The CLI providers' own argv builders strip `--model <name>`
            // when name === provider, so the subprocess uses the CLI's
            // default model (Codex picks `gpt-5-codex` etc., Claude CLI
            // picks Sonnet etc.).
            return { provider: bare as AiProvider, model: bare };
        }
        return { provider: 'claude', model: bare };
    }

    const provider = parts[0] as AiProvider;
    const model = parts.slice(1).join('/');
    return { provider, model };
}
