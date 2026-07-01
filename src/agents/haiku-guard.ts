/**
 * Haiku heavy-prompt guard (escalation).
 *
 * Haiku models give poor results on very large prompts while still burning
 * tokens, so KageOps caps the prompt size sent to a Haiku model. The original
 * guard HARD-FAILED the task on breach — which, when an agent like Vigil (a
 * code reviewer fed large context) was routed to Haiku with no fallback,
 * failed every attempt and spammed the run.
 *
 * This decides the better outcome: ESCALATE the call to a capable model — the
 * first configured non-Haiku fallback, or a same-provider Sonnet default —
 * rather than fail. Setting `KAGEOPS_HAIKU_GUARD=block` restores the old
 * hard-fail. Pure + env-injectable so it unit-tests without an agent.
 *
 * Env:
 *   KAGEOPS_HAIKU_GUARD               escalate (default) | block
 *   KAGEOPS_HAIKU_PROMPT_TOKEN_LIMIT  override the 10k default token cap
 *   KAGEOPS_HAIKU_ESCALATION_MODEL    force a specific escalation target
 */

export type HaikuGuardAction = 'allow' | 'escalate' | 'block';

export interface HaikuGuardDecision {
    readonly action: HaikuGuardAction;
    /** The model to send to instead — present when `action === 'escalate'`. */
    readonly model?: string;
    /** Operator-facing message — present when `action === 'block'`. */
    readonly reason?: string;
}

export const HAIKU_GUARD_ENV = 'KAGEOPS_HAIKU_GUARD';
export const HAIKU_LIMIT_ENV = 'KAGEOPS_HAIKU_PROMPT_TOKEN_LIMIT';
export const HAIKU_ESCALATION_ENV = 'KAGEOPS_HAIKU_ESCALATION_MODEL';

const DEFAULT_LIMIT = 10_000;

/**
 * Same-provider capable default used when no non-Haiku fallback is configured.
 * Kept provider-local so CLI/subscription auth stays intact (no cross-provider
 * API-key surprise). Providers without an entry fall back to `block`.
 */
const PROVIDER_ESCALATION: Readonly<Record<string, string>> = {
    'claude-cli': 'claude-cli/claude-sonnet-4-6',
    'claude': 'claude/claude-sonnet-4-6',
};

function isHaikuModel(model: string): boolean {
    return model.toLowerCase().includes('haiku');
}

function providerOf(model: string): string {
    const i = model.indexOf('/');
    return i > 0 ? model.slice(0, i) : '';
}

function parseLimit(raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** First configured fallback that isn't itself a Haiku model. */
function firstNonHaikuFallback(fallbackModels: readonly string[]): string | undefined {
    return fallbackModels.find((m) => m.trim() !== '' && !isHaikuModel(m));
}

/**
 * Resolve where a guarded Haiku call should escalate to. Precedence:
 *   1. KAGEOPS_HAIKU_ESCALATION_MODEL (explicit operator override)
 *   2. first configured non-Haiku fallback
 *   3. same-provider Sonnet default
 *   → null when none apply (caller blocks).
 */
export function resolveHaikuEscalationTarget(
    model: string,
    fallbackModels: readonly string[],
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    const forced = env[HAIKU_ESCALATION_ENV]?.trim();
    if (forced !== undefined && forced !== '') return forced;
    const fb = firstNonHaikuFallback(fallbackModels);
    if (fb !== undefined) return fb;
    return PROVIDER_ESCALATION[providerOf(model)] ?? null;
}

/**
 * Decide what to do with a prompt about to be sent to `model`. Non-Haiku
 * models and within-budget Haiku prompts are always allowed. An over-budget
 * Haiku prompt escalates (default) to a capable model, or blocks when
 * `KAGEOPS_HAIKU_GUARD=block` or no escalation target exists.
 */
export function resolveHaikuGuard(
    model: string,
    fallbackModels: readonly string[],
    estTokens: number,
    env: NodeJS.ProcessEnv = process.env,
): HaikuGuardDecision {
    const limit = parseLimit(env[HAIKU_LIMIT_ENV], DEFAULT_LIMIT);
    if (!isHaikuModel(model) || estTokens <= limit) return { action: 'allow' };

    const reason =
        `Haiku prompt guard: ${estTokens} tokens exceeds ${Math.round(limit / 1000)}k limit for ${model}. ` +
        `Use a larger model or trim context.`;

    const mode = (env[HAIKU_GUARD_ENV] ?? 'escalate').trim().toLowerCase();
    if (mode === 'block') return { action: 'block', reason };

    const target = resolveHaikuEscalationTarget(model, fallbackModels, env);
    if (target === null) return { action: 'block', reason };
    return { action: 'escalate', model: target };
}
