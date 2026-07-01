/**
 * KageOps Onboarding State Machine — pure logic governing the first-run
 * bootstrap journey: welcome → trust-level → providers → budget-cap → ready.
 * Every `advance(input)` returns a NEW `OnboardingState` (no mutation).
 * UI wiring lives elsewhere; this file has no Electron dependency.
 */

// ── Types ────────────────────────────────────────────

export type OnboardingStep =
    | 'welcome'
    | 'preset'
    | 'trust-level'
    | 'providers'
    | 'budget-cap'
    | 'ready';

export type TrustLevel = 'low' | 'medium' | 'high';

export type ProviderName = 'claude' | 'openrouter' | 'ollama' | 'openai' | 'gemini';

export interface ProviderConfig {
    readonly name: ProviderName;
    readonly apiKeyConfigured: boolean;
}

export interface OnboardingState {
    readonly step: OnboardingStep;
    /**
     * Selected preset name (matches a `~/.kageops/agent-config.<preset>.json`
     * file). NULL until the user picks one in the `preset` step. The wizard
     * step 1 sets this to the global default; per-project overrides happen
     * elsewhere via `projects.agent_config_preset`.
     */
    readonly preset: string | null;
    readonly trustLevel: TrustLevel | null;
    readonly providers: readonly ProviderConfig[];
    readonly budgetCapUsd: number | null;
    readonly completedAt: string | null;
}

export type OnboardingInput =
    | { readonly type: 'begin' }
    | { readonly type: 'select-preset'; readonly preset: string }
    | { readonly type: 'select-trust'; readonly trustLevel: TrustLevel }
    | { readonly type: 'set-providers'; readonly providers: readonly ProviderConfig[] }
    | { readonly type: 'set-budget'; readonly budgetCapUsd: number }
    | { readonly type: 'back' };

export interface OnboardingMachine {
    readonly getState: () => OnboardingState;
    readonly advance: (input: OnboardingInput) => OnboardingState;
    readonly reset: () => void;
    readonly isComplete: () => boolean;
}

// ── Constants ────────────────────────────────────────

const VALID_TRUST_LEVELS: readonly TrustLevel[] = ['low', 'medium', 'high'];
const VALID_PROVIDER_NAMES: readonly ProviderName[] = [
    'claude',
    'openrouter',
    'ollama',
    'openai',
    'gemini',
];

const MIN_BUDGET_USD_EXCLUSIVE = 0;
const MAX_BUDGET_USD_INCLUSIVE = 100;

/**
 * Ordered step list used for `back` navigation.
 * `ready` is terminal; `back` from `ready` lands on `budget-cap`.
 *
 * `preset` was added between `welcome` and `trust-level` per setup-wizard-plan.md
 * (Q1/Q5 resolutions, 2026-05-03) — it captures the global default agent_config
 * preset that all projects inherit unless they override via projects.agent_config_preset.
 *
 * Sensible bound on preset name length; matches typical `agent-config.<name>.json`
 * filename (no path components, no traversal).
 */
const STEP_ORDER: readonly OnboardingStep[] = [
    'welcome',
    'preset',
    'trust-level',
    'providers',
    'budget-cap',
    'ready',
];

const MAX_PRESET_NAME_LENGTH = 64;
const VALID_PRESET_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

// ── Factory ──────────────────────────────────────────

export function createInitialState(): OnboardingState {
    return {
        step: 'welcome',
        preset: null,
        trustLevel: null,
        providers: [],
        budgetCapUsd: null,
        completedAt: null,
    };
}

/**
 * Create a new onboarding state machine. Optionally seed it with a prior state
 * (e.g. when hydrating from disk). The seed is validated lightly — invalid seeds
 * fall back to a fresh initial state.
 */
export function createOnboardingMachine(seed?: OnboardingState): OnboardingMachine {
    let state: OnboardingState = seed !== undefined && isWellFormedState(seed)
        ? seed
        : createInitialState();

    return {
        getState: () => state,
        advance: (input) => {
            const next = advanceState(state, input);
            state = next;
            return next;
        },
        reset: () => {
            state = createInitialState();
        },
        isComplete: () => isCompleteState(state),
    };
}

// ── Pure Transitions ─────────────────────────────────

export function advanceState(
    state: OnboardingState,
    input: OnboardingInput
): OnboardingState {
    switch (input.type) {
        case 'begin':
            return handleBegin(state);
        case 'select-preset':
            return handleSelectPreset(state, input.preset);
        case 'select-trust':
            return handleSelectTrust(state, input.trustLevel);
        case 'set-providers':
            return handleSetProviders(state, input.providers);
        case 'set-budget':
            return handleSetBudget(state, input.budgetCapUsd);
        case 'back':
            return handleBack(state);
        default: {
            // Exhaustiveness guard
            const exhaustive: never = input;
            throw new Error(`Unknown onboarding input: ${JSON.stringify(exhaustive)}`);
        }
    }
}

function handleBegin(state: OnboardingState): OnboardingState {
    if (state.step !== 'welcome') {
        throw new Error(
            `Invalid transition: 'begin' is only valid from 'welcome', got '${state.step}'`
        );
    }
    return { ...state, step: 'preset' };
}

function handleSelectPreset(state: OnboardingState, preset: string): OnboardingState {
    if (state.step !== 'preset') {
        throw new Error(
            `Invalid transition: 'select-preset' is only valid from 'preset', got '${state.step}'`
        );
    }
    if (typeof preset !== 'string' || preset.length === 0) {
        throw new Error('Preset name must be a non-empty string.');
    }
    if (preset.length > MAX_PRESET_NAME_LENGTH) {
        throw new Error(
            `Preset name too long: ${preset.length} chars (max ${MAX_PRESET_NAME_LENGTH}).`
        );
    }
    if (!VALID_PRESET_NAME_PATTERN.test(preset)) {
        throw new Error(
            `Invalid preset name '${preset}': only alphanumeric, hyphen, and underscore allowed.`
        );
    }
    return { ...state, preset, step: 'trust-level' };
}

function handleSelectTrust(
    state: OnboardingState,
    trustLevel: TrustLevel
): OnboardingState {
    if (state.step !== 'trust-level') {
        throw new Error(
            `Invalid transition: 'select-trust' is only valid from 'trust-level', got '${state.step}'`
        );
    }
    if (!VALID_TRUST_LEVELS.includes(trustLevel)) {
        throw new Error(
            `Invalid trust level: '${String(trustLevel)}'. Must be one of ${VALID_TRUST_LEVELS.join(', ')}`
        );
    }
    return { ...state, trustLevel, step: 'providers' };
}

function handleSetProviders(
    state: OnboardingState,
    providers: readonly ProviderConfig[]
): OnboardingState {
    if (state.step !== 'providers') {
        throw new Error(
            `Invalid transition: 'set-providers' is only valid from 'providers', got '${state.step}'`
        );
    }
    validateProviders(providers);
    const hasConfigured = providers.some((p) => p.apiKeyConfigured);
    if (!hasConfigured) {
        throw new Error(
            'At least one provider must have apiKeyConfigured=true before advancing.'
        );
    }
    // Clone into a fresh readonly array of fresh objects (immutability safety)
    const frozen: readonly ProviderConfig[] = providers.map((p) => ({
        name: p.name,
        apiKeyConfigured: p.apiKeyConfigured,
    }));
    return { ...state, providers: frozen, step: 'budget-cap' };
}

function handleSetBudget(
    state: OnboardingState,
    budgetCapUsd: number
): OnboardingState {
    if (state.step !== 'budget-cap') {
        throw new Error(
            `Invalid transition: 'set-budget' is only valid from 'budget-cap', got '${state.step}'`
        );
    }
    if (!Number.isFinite(budgetCapUsd)) {
        throw new Error(`Invalid budget cap: must be a finite number, got ${String(budgetCapUsd)}`);
    }
    if (budgetCapUsd <= MIN_BUDGET_USD_EXCLUSIVE || budgetCapUsd > MAX_BUDGET_USD_INCLUSIVE) {
        throw new Error(
            `Invalid budget cap: ${budgetCapUsd}. Must satisfy ${MIN_BUDGET_USD_EXCLUSIVE} < cap <= ${MAX_BUDGET_USD_INCLUSIVE}.`
        );
    }
    const completedAt = new Date().toISOString();
    return { ...state, budgetCapUsd, step: 'ready', completedAt };
}

function handleBack(state: OnboardingState): OnboardingState {
    const currentIndex = STEP_ORDER.indexOf(state.step);
    if (currentIndex <= 0) {
        throw new Error(`Cannot go back from '${state.step}' — already at the first step.`);
    }
    const previousStep = STEP_ORDER[currentIndex - 1];
    // Preserve all entered data — only the step pointer moves backward.
    // When leaving `ready`, clear `completedAt` since the user is no longer done.
    if (state.step === 'ready') {
        return { ...state, step: previousStep, completedAt: null };
    }
    return { ...state, step: previousStep };
}

// ── Helpers ──────────────────────────────────────────

function validateProviders(providers: readonly ProviderConfig[]): void {
    if (!Array.isArray(providers)) {
        throw new Error('Providers must be an array.');
    }
    for (const p of providers) {
        if (p === null || typeof p !== 'object') {
            throw new Error('Each provider entry must be an object.');
        }
        if (!VALID_PROVIDER_NAMES.includes(p.name)) {
            throw new Error(
                `Invalid provider name: '${String(p.name)}'. Must be one of ${VALID_PROVIDER_NAMES.join(', ')}`
            );
        }
        if (typeof p.apiKeyConfigured !== 'boolean') {
            throw new Error(
                `Invalid apiKeyConfigured for provider '${p.name}': must be boolean.`
            );
        }
    }
}

function isCompleteState(state: OnboardingState): boolean {
    return (
        state.step === 'ready' &&
        state.preset !== null &&
        state.trustLevel !== null &&
        state.providers.length > 0 &&
        state.providers.some((p) => p.apiKeyConfigured) &&
        state.budgetCapUsd !== null &&
        state.budgetCapUsd > MIN_BUDGET_USD_EXCLUSIVE &&
        state.budgetCapUsd <= MAX_BUDGET_USD_INCLUSIVE &&
        state.completedAt !== null
    );
}

function isWellFormedState(state: OnboardingState): boolean {
    if (state === null || typeof state !== 'object') return false;
    if (!STEP_ORDER.includes(state.step)) return false;
    if (state.preset !== null && typeof state.preset !== 'string') return false;
    if (state.preset !== null && !VALID_PRESET_NAME_PATTERN.test(state.preset)) return false;
    if (state.trustLevel !== null && !VALID_TRUST_LEVELS.includes(state.trustLevel)) return false;
    if (!Array.isArray(state.providers)) return false;
    for (const p of state.providers) {
        if (!VALID_PROVIDER_NAMES.includes(p.name)) return false;
        if (typeof p.apiKeyConfigured !== 'boolean') return false;
    }
    if (state.budgetCapUsd !== null && !Number.isFinite(state.budgetCapUsd)) return false;
    if (state.completedAt !== null && typeof state.completedAt !== 'string') return false;
    return true;
}

// Re-export constants for consumers / tests that want them
export const ONBOARDING_STEP_ORDER = STEP_ORDER;
export const ONBOARDING_BUDGET_MIN_EXCLUSIVE = MIN_BUDGET_USD_EXCLUSIVE;
export const ONBOARDING_BUDGET_MAX_INCLUSIVE = MAX_BUDGET_USD_INCLUSIVE;
