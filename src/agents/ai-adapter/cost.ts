/**
 * Token pricing + cost math.
 *
 * Rates are approximate (USD per 1M tokens) and fall back to `default`
 * for unknown models.
 *
 * F-363: Claude CLI and Codex CLI are subscription-billed — the response
 * envelope doesn't include per-call cost, so the budget-kill saw $0 and
 * never fired. We now apply SYNTHETIC pricing derived from the underlying
 * model's API rate. The CLI doesn't actually charge per call (the operator
 * paid for Anthropic Pro / OpenAI Plus monthly), but a synthetic figure
 * gives KageOps a comparable signal for budget caps, cost dashboards, and
 * benchmark math. See `PRICE_TABLE_REFRESHED_AT` for the date these
 * numbers were verified.
 *
 * Lookup precedence:
 *   1. Exact model-string match
 *   2. OpenRouter-style `openrouter/<vendor>/<model>` — strip the prefix
 *      and look up the vendor/model variant
 *   3. Vendor-keyed fuzzy match (any key whose name appears in the model
 *      string — handles versioned IDs like `claude-sonnet-4-20250514`
 *      vs `claude-sonnet-4`)
 *   4. `default` rates
 */

/**
 * F-369: Operators need to know how fresh the rates below are. Bumping
 * this constant signals "I checked the pricing pages on this date".
 * Surface this in the cost-gauge UI with a "Pricing data refreshed 3h ago"
 * style label so operators trust the budget numbers.
 */
export const PRICE_TABLE_REFRESHED_AT = '2026-05-14';

const COST_PER_M_TOKENS: Record<string, { input: number; output: number }> = {
    // Anthropic API model IDs (full versioned IDs)
    'claude-sonnet-4-20250514':   { input: 3.0,  output: 15.0 },
    'claude-opus-4-20250514':     { input: 15.0, output: 75.0 },
    'claude-haiku-3-5-20241022':  { input: 0.8,  output: 4.0 },

    // Anthropic short IDs (also used by OpenRouter routing tags)
    'claude-sonnet-4':            { input: 3.0,  output: 15.0 },
    'claude-sonnet-4.5':          { input: 3.0,  output: 15.0 },
    'claude-sonnet-4.6':          { input: 3.0,  output: 15.0 },
    'claude-opus-4':              { input: 15.0, output: 75.0 },
    'claude-opus-4.7':            { input: 15.0, output: 75.0 },
    'claude-haiku-4':             { input: 0.8,  output: 4.0 },
    'claude-haiku-4.5':           { input: 1.0,  output: 5.0 },

    // OpenAI — GPT-5 family rates are placeholder estimates following
    // the GPT-4-turbo pricing tier; replace when OpenAI publishes
    // actual numbers. Listed input/output is USD per 1M tokens.
    'gpt-5.5':                    { input: 12.0, output: 36.0 },
    'gpt-5.4':                    { input: 10.0, output: 30.0 },
    'gpt-5.3':                    { input: 8.0,  output: 24.0 },
    'gpt-4o':                     { input: 2.5,  output: 10.0 },
    'gpt-4o-mini':                { input: 0.15, output: 0.6 },
    'gpt-4-turbo':                { input: 10.0, output: 30.0 },
    'o1':                         { input: 15.0, output: 60.0 },
    'o1-mini':                    { input: 3.0,  output: 12.0 },

    // Google
    'gemini-2.5-flash':           { input: 0.075, output: 0.3 },
    'gemini-2.5-pro':             { input: 1.25,  output: 5.0 },
    'gemini-1.5-flash':           { input: 0.075, output: 0.3 },
    'gemini-1.5-pro':             { input: 1.25,  output: 5.0 },

    // DeepSeek (popular budget routing on OpenRouter)
    'deepseek-chat':              { input: 0.27, output: 1.10 },
    'deepseek-coder':             { input: 0.27, output: 1.10 },
    'deepseek-r1':                { input: 0.55, output: 2.19 },

    // F-363: subscription CLIs no longer hardcoded to $0. We charge them at
    // the equivalent API rate so budget-kill + cost dashboards have a real
    // signal. The CLI doesn't actually meter per-call — the operator paid a
    // monthly subscription — but the synthetic number is comparable across
    // presets and trips the budget cap when a runaway pipeline would have
    // burned real money on the API.
    //
    // claude-cli routes to Sonnet 4.6 by default (see [[kageops-cli-providers]])
    'claude-cli':                 { input: 3.0,  output: 15.0 },
    // codex-cli routes to o4-mini by default
    'codex-cli':                  { input: 3.0,  output: 12.0 },

    // Fallback when nothing matches
    'default':                    { input: 1.0,  output: 3.0 },
};

/**
 * Look up the per-1M-token rates for a model string. Handles the
 * three common shapes (exact, openrouter-prefixed, vendor-fuzzy)
 * before falling through to default rates.
 *
 * Exported for tests. Use `calculateCost()` for cost math.
 */
export function resolveRates(model: string): { readonly input: number; readonly output: number } {
    if (COST_PER_M_TOKENS[model] !== undefined) {
        return COST_PER_M_TOKENS[model];
    }

    // OpenRouter-style: openrouter/<vendor>/<model> or openrouter/<model>
    if (model.startsWith('openrouter/')) {
        const trimmed = model.slice('openrouter/'.length);
        // Try the trailing segment first (most specific): vendor/model → model
        const lastSlash = trimmed.lastIndexOf('/');
        const tail = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
        if (COST_PER_M_TOKENS[tail] !== undefined) {
            return COST_PER_M_TOKENS[tail];
        }
        // Then the vendor/model whole
        if (COST_PER_M_TOKENS[trimmed] !== undefined) {
            return COST_PER_M_TOKENS[trimmed];
        }
    }

    // Fuzzy: any rate-table key that appears as a substring of the model
    // string. Catches things like `anthropic/claude-sonnet-4` where the
    // table has `claude-sonnet-4`.
    for (const key of Object.keys(COST_PER_M_TOKENS)) {
        if (key === 'default') continue;
        if (model.includes(key)) return COST_PER_M_TOKENS[key];
    }

    return COST_PER_M_TOKENS['default'];
}

export function calculateCost(model: string, tokensIn: number, tokensOut: number): number {
    const rates = resolveRates(model);
    return (tokensIn * rates.input + tokensOut * rates.output) / 1_000_000;
}

export function estimateTokens(text: string): number {
    // Rough estimate: ~4 characters per token
    return Math.ceil(text.length / 4);
}
