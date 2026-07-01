/**
 * Gate-mode kill-switches (PR-2 "verification teeth").
 *
 * The deploy-readiness checks (G5 module-load init, G6 migration validation,
 * the required-payment-initiator rule, and the generated Playwright e2e run)
 * are blocking by default — correctness over cost. Each is individually
 * dial-able per run via a `KAGEOPS_GATE_*` env var so an operator can downgrade
 * a noisy check to advisory (`warn`) or disable it entirely (`off`) without a
 * code change.
 *
 *   block (default) → a violation fails the gate and spawns a Forge fix-task.
 *   warn            → a violation is logged + published as a non-blocking
 *                     warning (the pre-PR-2 behaviour) but never blocks.
 *   off             → the check does not run at all.
 *
 * Pure + env-injectable so it is trivially unit-testable.
 */

export type GateMode = 'block' | 'warn' | 'off';

const BLOCK_TOKENS: ReadonlySet<string> = new Set(['block', 'blocking', 'on', '1', 'true', 'yes']);
const WARN_TOKENS: ReadonlySet<string> = new Set(['warn', 'warning', 'advisory']);
const OFF_TOKENS: ReadonlySet<string> = new Set(['off', 'none', 'skip', 'disabled', '0', 'false', 'no']);

/**
 * Resolve a gate's mode from its env var. Unset / unrecognised → `def`.
 * `env` is injectable for tests; defaults to `process.env`.
 */
export function gateMode(
    varName: string,
    def: GateMode = 'block',
    env: NodeJS.ProcessEnv = process.env,
): GateMode {
    const raw = (env[varName] ?? '').trim().toLowerCase();
    if (raw === '') return def;
    if (BLOCK_TOKENS.has(raw)) return 'block';
    if (WARN_TOKENS.has(raw)) return 'warn';
    if (OFF_TOKENS.has(raw)) return 'off';
    return def;
}

// Canonical env var names — referenced by the gates AND surfaced in docs/help.
export const GATE_ENV = {
    /** Brief implies payments ⇒ a checkout/subscription initiator must exist. */
    requiredInitiator: 'KAGEOPS_GATE_REQUIRED_INITIATOR',
    /** When payments ARE wired, they're wired correctly (signature verify, env price, user-keyed). */
    paymentIntegrity: 'KAGEOPS_GATE_PAYMENT_INTEGRITY',
    /** No placeholder/fabricated values (lorem, fake contacts, unfilled gaps) in shipped UI. */
    fabrication: 'KAGEOPS_GATE_FABRICATION',
    /** G5 — no module-load-time SDK construction reading process.env. */
    moduleInit: 'KAGEOPS_GATE_MODULE_INIT',
    /** G6 — generated migrations apply cleanly to a fresh DB. */
    migration: 'KAGEOPS_GATE_MIGRATION',
    /** Generated Playwright e2e suite runs green in the build gate. */
    e2e: 'KAGEOPS_GATE_E2E',
} as const;
