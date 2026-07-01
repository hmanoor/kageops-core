/**
 * Retry-budget resolution (PR-6 "retry-budget hardening").
 *
 * The three self-heal loops — build-fix, acceptance-fix, deploy-preview — each
 * bound how many times Sensei auto-dispatches a Forge/Aegis remediation task
 * before escalating to a human. Those budgets were silent hardcoded 2s; this
 * makes each one dial-able per run via a `KAGEOPS_MAX_*_RETRIES` env var,
 * completing the env-dial theme of the deploy-readiness program (the gate
 * kill-switches let you dial the *checks*; this dials the *self-heal effort*).
 *
 *   unset / blank / non-integer → the loop's built-in default (don't crash a
 *                                 run on a typo).
 *   0                           → no auto-remediation; escalate to a human on
 *                                 the FIRST failure (inspect-every-failure mode,
 *                                 e.g. cheap/benchmark runs that shouldn't burn
 *                                 Forge spend on a self-heal loop).
 *   1..MAX_RETRY_BUDGET         → that many auto-fix attempts.
 *   > MAX_RETRY_BUDGET          → clamped to MAX_RETRY_BUDGET (a runaway budget
 *                                 would burn unbounded Forge spend + wall-clock).
 *   < MIN_RETRY_BUDGET          → clamped to MIN_RETRY_BUDGET.
 *
 * Pure + env-injectable so it is trivially unit-testable.
 */

/** Floor for any resolved budget. 0 = "no auto-retry, escalate immediately". */
export const MIN_RETRY_BUDGET = 0;
/** Ceiling for any resolved budget — a runaway value can't unbound Forge spend. */
export const MAX_RETRY_BUDGET = 10;

/**
 * Resolve a self-heal loop's retry budget from its env var. Unset, blank, or
 * non-integer → `def`; a valid integer is clamped to [MIN, MAX].
 * `env` is injectable for tests; defaults to `process.env`.
 */
export function resolveRetryBudget(
    varName: string,
    def: number,
    env: NodeJS.ProcessEnv = process.env,
): number {
    const raw = (env[varName] ?? '').trim();
    if (raw === '') return def;
    const n = Number(raw);
    // Reject non-integers (NaN, 2.5, Infinity) — fall back to the default
    // rather than abort the run on a typo.
    if (!Number.isInteger(n)) return def;
    return Math.min(MAX_RETRY_BUDGET, Math.max(MIN_RETRY_BUDGET, n));
}

// Canonical env var names — referenced by Sensei's remediation loops AND
// surfaced in docs/help/04-env-vars.md.
export const RETRY_ENV = {
    /** build-fix self-heal loop (P2-03). */
    build: 'KAGEOPS_MAX_BUILD_RETRIES',
    /** acceptance-fix self-heal loop. */
    acceptance: 'KAGEOPS_MAX_ACCEPTANCE_RETRIES',
    /** deploy-preview scheduling loop (P2-05). */
    deployPreview: 'KAGEOPS_MAX_DEPLOY_PREVIEW_RETRIES',
} as const;
