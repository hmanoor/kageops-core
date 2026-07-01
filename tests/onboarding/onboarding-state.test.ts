/**
 * OnboardingState unit tests
 *
 * Covers the pure state-machine transitions: valid walk-through, invalid
 * transitions, back-navigation, provider requirement, budget range, and
 * immutability guarantees.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    createOnboardingMachine,
    createInitialState,
    advanceState,
    OnboardingMachine,
    OnboardingState,
    ProviderConfig,
    ONBOARDING_STEP_ORDER,
} from '../../src/onboarding/onboarding-state';

// ── Fixtures ─────────────────────────────────────────

const validProviders: readonly ProviderConfig[] = [
    { name: 'claude', apiKeyConfigured: true },
    { name: 'openai', apiKeyConfigured: false },
];

function walkToReady(machine: OnboardingMachine): OnboardingState {
    machine.advance({ type: 'begin' });
    machine.advance({ type: 'select-preset', preset: 'claude-cli-premium' });
    machine.advance({ type: 'select-trust', trustLevel: 'medium' });
    machine.advance({ type: 'set-providers', providers: validProviders });
    return machine.advance({ type: 'set-budget', budgetCapUsd: 5 });
}

/** Walk to the trust-level step (after begin + select-preset). */
function walkToTrustLevel(machine: OnboardingMachine): void {
    machine.advance({ type: 'begin' });
    machine.advance({ type: 'select-preset', preset: 'claude-cli-premium' });
}

// ── Tests ────────────────────────────────────────────

describe('OnboardingState', () => {
    let machine: OnboardingMachine;

    beforeEach(() => {
        machine = createOnboardingMachine();
    });

    // ── Initial state ───────────────────────────────

    describe('initial state', () => {
        it('starts on welcome with all fields blank', () => {
            const s = machine.getState();
            expect(s.step).toBe('welcome');
            expect(s.preset).toBeNull();
            expect(s.trustLevel).toBeNull();
            expect(s.providers).toEqual([]);
            expect(s.budgetCapUsd).toBeNull();
            expect(s.completedAt).toBeNull();
        });

        it('isComplete() is false on the initial state', () => {
            expect(machine.isComplete()).toBe(false);
        });

        it('createInitialState() matches getState() on a fresh machine', () => {
            expect(machine.getState()).toEqual(createInitialState());
        });
    });

    // ── Happy path ──────────────────────────────────

    describe('happy-path walk-through', () => {
        it('walks welcome → preset → trust-level → providers → budget-cap → ready', () => {
            const afterBegin = machine.advance({ type: 'begin' });
            expect(afterBegin.step).toBe('preset');

            const afterPreset = machine.advance({
                type: 'select-preset',
                preset: 'openrouter_budget',
            });
            expect(afterPreset.step).toBe('trust-level');
            expect(afterPreset.preset).toBe('openrouter_budget');

            const afterTrust = machine.advance({
                type: 'select-trust',
                trustLevel: 'high',
            });
            expect(afterTrust.step).toBe('providers');
            expect(afterTrust.trustLevel).toBe('high');

            const afterProviders = machine.advance({
                type: 'set-providers',
                providers: validProviders,
            });
            expect(afterProviders.step).toBe('budget-cap');
            expect(afterProviders.providers).toHaveLength(2);

            const afterBudget = machine.advance({
                type: 'set-budget',
                budgetCapUsd: 10,
            });
            expect(afterBudget.step).toBe('ready');
            expect(afterBudget.budgetCapUsd).toBe(10);
            expect(afterBudget.completedAt).not.toBeNull();
        });

        it('isComplete() returns true after reaching ready with all fields set', () => {
            walkToReady(machine);
            expect(machine.isComplete()).toBe(true);
        });

        it('completedAt is a valid ISO-8601 timestamp string', () => {
            const s = walkToReady(machine);
            expect(s.completedAt).not.toBeNull();
            // Round-trip through Date should yield the same ISO string
            const roundTrip = new Date(s.completedAt as string).toISOString();
            expect(roundTrip).toBe(s.completedAt);
        });
    });

    // ── Invalid transitions ─────────────────────────

    describe('invalid transitions', () => {
        it('rejects begin from any step other than welcome', () => {
            machine.advance({ type: 'begin' });
            expect(() => machine.advance({ type: 'begin' })).toThrow(/Invalid transition/);
        });

        it('rejects select-preset from welcome', () => {
            expect(() =>
                machine.advance({ type: 'select-preset', preset: 'claude-cli-premium' })
            ).toThrow(/Invalid transition/);
        });

        it('rejects select-trust from welcome', () => {
            expect(() =>
                machine.advance({ type: 'select-trust', trustLevel: 'low' })
            ).toThrow(/Invalid transition/);
        });

        it('rejects set-providers before trust-level', () => {
            walkToTrustLevel(machine);
            expect(() =>
                machine.advance({ type: 'set-providers', providers: validProviders })
            ).toThrow(/Invalid transition/);
        });

        it('rejects set-budget before providers', () => {
            walkToTrustLevel(machine);
            machine.advance({ type: 'select-trust', trustLevel: 'low' });
            expect(() =>
                machine.advance({ type: 'set-budget', budgetCapUsd: 5 })
            ).toThrow(/Invalid transition/);
        });

        it('rejects unknown trust level', () => {
            walkToTrustLevel(machine);
            expect(() =>
                machine.advance({
                    type: 'select-trust',
                    // @ts-expect-error deliberately invalid
                    trustLevel: 'paranoid',
                })
            ).toThrow(/Invalid trust level/);
        });

        it('rejects unknown provider names', () => {
            walkToTrustLevel(machine);
            machine.advance({ type: 'select-trust', trustLevel: 'low' });
            expect(() =>
                machine.advance({
                    type: 'set-providers',
                    // @ts-expect-error deliberately invalid
                    providers: [{ name: 'gemini-pro', apiKeyConfigured: true }],
                })
            ).toThrow(/Invalid provider name/);
        });
    });

    // ── Preset step ─────────────────────────────────

    describe('preset step', () => {
        beforeEach(() => {
            machine.advance({ type: 'begin' });
        });

        it('accepts a well-formed preset name', () => {
            const s = machine.advance({ type: 'select-preset', preset: 'claude-cli-premium' });
            expect(s.step).toBe('trust-level');
            expect(s.preset).toBe('claude-cli-premium');
        });

        it('rejects an empty string', () => {
            expect(() =>
                machine.advance({ type: 'select-preset', preset: '' })
            ).toThrow(/non-empty/);
        });

        it('rejects a name with path traversal', () => {
            expect(() =>
                machine.advance({ type: 'select-preset', preset: '../../etc/passwd' })
            ).toThrow(/Invalid preset name/);
        });

        it('rejects a name with whitespace', () => {
            expect(() =>
                machine.advance({ type: 'select-preset', preset: 'has spaces' })
            ).toThrow(/Invalid preset name/);
        });

        it('rejects a name longer than 64 chars', () => {
            const long = 'a'.repeat(65);
            expect(() =>
                machine.advance({ type: 'select-preset', preset: long })
            ).toThrow(/too long/);
        });

        it('accepts hyphens, underscores, and digits', () => {
            const s = machine.advance({ type: 'select-preset', preset: 'my_preset-v2_2026' });
            expect(s.step).toBe('trust-level');
            expect(s.preset).toBe('my_preset-v2_2026');
        });
    });

    // ── Provider requirement ────────────────────────

    describe('providers step', () => {
        beforeEach(() => {
            walkToTrustLevel(machine);
            machine.advance({ type: 'select-trust', trustLevel: 'low' });
        });

        it('requires at least one provider with apiKeyConfigured=true', () => {
            expect(() =>
                machine.advance({
                    type: 'set-providers',
                    providers: [{ name: 'claude', apiKeyConfigured: false }],
                })
            ).toThrow(/At least one provider/);
        });

        it('rejects an empty provider list', () => {
            expect(() =>
                machine.advance({ type: 'set-providers', providers: [] })
            ).toThrow(/At least one provider/);
        });

        it('accepts a single configured provider', () => {
            const s = machine.advance({
                type: 'set-providers',
                providers: [{ name: 'claude', apiKeyConfigured: true }],
            });
            expect(s.step).toBe('budget-cap');
            expect(s.providers).toHaveLength(1);
        });
    });

    // ── Budget range ────────────────────────────────

    describe('budget-cap step', () => {
        beforeEach(() => {
            walkToTrustLevel(machine);
            machine.advance({ type: 'select-trust', trustLevel: 'low' });
            machine.advance({ type: 'set-providers', providers: validProviders });
        });

        it('rejects 0 (exclusive lower bound)', () => {
            expect(() =>
                machine.advance({ type: 'set-budget', budgetCapUsd: 0 })
            ).toThrow(/Invalid budget cap/);
        });

        it('rejects negative numbers', () => {
            expect(() =>
                machine.advance({ type: 'set-budget', budgetCapUsd: -5 })
            ).toThrow(/Invalid budget cap/);
        });

        it('rejects values above 100', () => {
            expect(() =>
                machine.advance({ type: 'set-budget', budgetCapUsd: 100.01 })
            ).toThrow(/Invalid budget cap/);
        });

        it('accepts the upper bound of 100 (inclusive)', () => {
            const s = machine.advance({ type: 'set-budget', budgetCapUsd: 100 });
            expect(s.step).toBe('ready');
            expect(s.budgetCapUsd).toBe(100);
        });

        it('accepts a small positive value just above 0', () => {
            const s = machine.advance({ type: 'set-budget', budgetCapUsd: 0.01 });
            expect(s.step).toBe('ready');
        });

        it('rejects non-finite values', () => {
            expect(() =>
                machine.advance({ type: 'set-budget', budgetCapUsd: Number.POSITIVE_INFINITY })
            ).toThrow(/Invalid budget cap/);
            expect(() =>
                machine.advance({ type: 'set-budget', budgetCapUsd: Number.NaN })
            ).toThrow(/Invalid budget cap/);
        });
    });

    // ── Back navigation ─────────────────────────────

    describe('back navigation', () => {
        it('preserves data when stepping backward from providers to trust-level', () => {
            walkToTrustLevel(machine);
            machine.advance({ type: 'select-trust', trustLevel: 'medium' });
            const back = machine.advance({ type: 'back' });
            expect(back.step).toBe('trust-level');
            // trustLevel is preserved so the UI can show the prior selection
            expect(back.trustLevel).toBe('medium');
        });

        it('preserves preset when stepping back from trust-level', () => {
            walkToTrustLevel(machine);
            const back = machine.advance({ type: 'back' });
            expect(back.step).toBe('preset');
            expect(back.preset).toBe('claude-cli-premium');
        });

        it('preserves providers when stepping back from budget-cap', () => {
            walkToTrustLevel(machine);
            machine.advance({ type: 'select-trust', trustLevel: 'low' });
            machine.advance({ type: 'set-providers', providers: validProviders });
            const back = machine.advance({ type: 'back' });
            expect(back.step).toBe('providers');
            expect(back.providers).toHaveLength(2);
            expect(back.trustLevel).toBe('low');
        });

        it('stepping back from ready clears completedAt but preserves entered data', () => {
            walkToReady(machine);
            const back = machine.advance({ type: 'back' });
            expect(back.step).toBe('budget-cap');
            expect(back.completedAt).toBeNull();
            expect(back.budgetCapUsd).toBe(5);
            expect(back.trustLevel).toBe('medium');
            expect(back.providers).toHaveLength(2);
        });

        it('rejects back from welcome', () => {
            expect(() => machine.advance({ type: 'back' })).toThrow(/first step/);
        });

        it('isComplete() returns false after stepping back from ready', () => {
            walkToReady(machine);
            expect(machine.isComplete()).toBe(true);
            machine.advance({ type: 'back' });
            expect(machine.isComplete()).toBe(false);
        });
    });

    // ── Reset ───────────────────────────────────────

    describe('reset', () => {
        it('returns the machine to welcome with blank state', () => {
            walkToReady(machine);
            machine.reset();
            const s = machine.getState();
            expect(s.step).toBe('welcome');
            expect(s.preset).toBeNull();
            expect(s.trustLevel).toBeNull();
            expect(s.providers).toEqual([]);
            expect(s.budgetCapUsd).toBeNull();
            expect(s.completedAt).toBeNull();
        });
    });

    // ── Immutability ────────────────────────────────

    describe('immutability', () => {
        it('advance returns a new object per call (no in-place mutation)', () => {
            const s0 = machine.getState();
            const s1 = machine.advance({ type: 'begin' });
            expect(s0).not.toBe(s1);
            // s0 is the original snapshot — must not have been mutated
            expect(s0.step).toBe('welcome');
        });

        it('advanceState pure helper does not mutate its input', () => {
            const input = createInitialState();
            const output = advanceState(input, { type: 'begin' });
            expect(input.step).toBe('welcome');
            expect(output.step).toBe('preset');
            expect(output).not.toBe(input);
        });

        it('returned providers array is not the same reference as the input', () => {
            walkToTrustLevel(machine);
            machine.advance({ type: 'select-trust', trustLevel: 'low' });
            const input: ProviderConfig[] = [
                { name: 'claude', apiKeyConfigured: true },
            ];
            const out = machine.advance({ type: 'set-providers', providers: input });
            expect(out.providers).not.toBe(input);
            expect(out.providers).toEqual(input);
        });
    });

    // ── Seeding ─────────────────────────────────────

    describe('seeding', () => {
        it('accepts a valid seed state', () => {
            const seed: OnboardingState = {
                step: 'providers',
                preset: 'claude-cli-premium',
                trustLevel: 'high',
                providers: [],
                budgetCapUsd: null,
                completedAt: null,
            };
            const m = createOnboardingMachine(seed);
            expect(m.getState()).toEqual(seed);
        });

        it('falls back to fresh state on malformed seed', () => {
            const bad = {
                step: 'not-a-step',
                preset: null,
                trustLevel: null,
                providers: [],
                budgetCapUsd: null,
                completedAt: null,
            } as unknown as OnboardingState;
            const m = createOnboardingMachine(bad);
            expect(m.getState().step).toBe('welcome');
        });

        it('falls back to fresh state on invalid preset characters', () => {
            const bad: OnboardingState = {
                step: 'trust-level',
                preset: '../../etc/passwd',
                trustLevel: null,
                providers: [],
                budgetCapUsd: null,
                completedAt: null,
            };
            const m = createOnboardingMachine(bad);
            expect(m.getState().step).toBe('welcome');
            expect(m.getState().preset).toBeNull();
        });
    });

    // ── Step order sanity ───────────────────────────

    describe('step order', () => {
        it('STEP_ORDER is exported and in documented order', () => {
            expect(ONBOARDING_STEP_ORDER).toEqual([
                'welcome',
                'preset',
                'trust-level',
                'providers',
                'budget-cap',
                'ready',
            ]);
        });
    });
});
