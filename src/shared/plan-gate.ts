export type Plan = 'free' | 'team' | 'enterprise';

export type Feature =
    | 'unlimited_projects'
    | 'priority_support'
    | 'apo'
    | 'team_seats'
    | 'connectors'
    | 'sso'
    | 'azure_burst'
    | 'custom_agents';

/**
 * The seam between the OPEN core and the COMMERCIAL tier model (kageops-core
 * split, manifest §0 — the one static OPEN→COMMERCIAL edge).
 *
 * The open engine depends ONLY on this interface + {@link openPlanGate}. The
 * paid tier→feature table below is the COMMERCIAL implementation, injected by
 * the commercial layer (orchestrator-bootstrap) via `SenseiConfig.planGate`.
 * At clean-seed the commercial block moves to `kageops-cloud`; the open build
 * keeps the interface + open default and never references the table.
 */
export interface PlanGate {
    canUse(feature: Feature, plan: Plan): boolean;
}

/**
 * OPEN default — the open core grants every feature on every plan (no tiering).
 * Sensei uses this whenever a commercial `planGate` is not injected, which is
 * exactly the dev / headless / self-hosted-open posture.
 */
export const openPlanGate: PlanGate = {
    canUse: () => true,
};

// ── COMMERCIAL tier model (moves to kageops-cloud at clean-seed) ───────────

// 3-tier open-core model (2026-07-01): the Free tier IS the full open-source
// engine — unlimited projects, all agents, APO, cost controls. Paid tiers add
// only the commercial/hosted layer (collaboration seats, connectors) and, at
// Enterprise, SSO + Azure burst + priority support.
const PLAN_FEATURES: Readonly<Record<Feature, readonly Plan[]>> = {
    unlimited_projects: ['free', 'team', 'enterprise'],
    apo:                ['free', 'team', 'enterprise'],
    team_seats:         ['team', 'enterprise'],
    connectors:         ['team', 'enterprise'],
    custom_agents:      ['team', 'enterprise'],
    priority_support:   ['enterprise'],
    sso:                ['enterprise'],
    azure_burst:        ['enterprise'],
};

export function canUse(feature: Feature, plan: Plan): boolean {
    return (PLAN_FEATURES[feature] as readonly string[]).includes(plan);
}

/** The COMMERCIAL gate — real paid-tier enforcement. Injected by the cloud layer. */
export const tierPlanGate: PlanGate = {
    canUse,
};

export const PLAN_LABELS: Readonly<Record<Plan, string>> = {
    free:       'Free',
    team:       'Team',
    enterprise: 'Enterprise',
};

export const PLAN_PRICES_MONTHLY: Readonly<Record<Plan, number | null>> = {
    free:       0,
    team:       39,
    enterprise: null,
};
