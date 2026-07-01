/**
 * TierLimitError — F-314
 *
 * Thrown by orchestrator gates when the active plan doesn't permit an
 * action (e.g. Free plan trying to start a 2nd active project, or any
 * sub-Team plan trying to enable the Slack connector).
 *
 * The IPC layer catches this specifically (instanceof check) and returns
 * a structured `{ success: false, code: 'tier-limit', plan, feature, message }`
 * response so the UI can render an "Upgrade to <Tier>" CTA instead of a
 * generic toast.
 *
 * Always includes:
 *   - `plan`         — the user's current plan when the gate fired
 *   - `feature`      — the feature key from src/shared/plan-gate.ts
 *   - `requiredPlan` — the minimum plan that grants the feature
 *   - `message`      — human-readable, ready to show in a dialog
 */

import type { Plan, Feature } from './plan-gate';

export class TierLimitError extends Error {
    public readonly code = 'tier-limit' as const;
    public readonly plan: Plan;
    public readonly feature: Feature;
    public readonly requiredPlan: Plan;

    constructor(plan: Plan, feature: Feature, requiredPlan: Plan, message: string) {
        super(message);
        this.name = 'TierLimitError';
        this.plan = plan;
        this.feature = feature;
        this.requiredPlan = requiredPlan;
        // Maintain proper prototype chain for instanceof checks across module boundaries
        Object.setPrototypeOf(this, TierLimitError.prototype);
    }

    /** Type-safe shape for IPC handlers: `if (TierLimitError.is(err))`. */
    static is(err: unknown): err is TierLimitError {
        return (
            err instanceof Error &&
            (err as TierLimitError).code === 'tier-limit' &&
            typeof (err as TierLimitError).feature === 'string' &&
            typeof (err as TierLimitError).requiredPlan === 'string'
        );
    }
}
