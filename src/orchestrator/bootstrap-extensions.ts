/**
 * OSS-split seam — orchestrator bootstrap extensions.
 *
 * `orchestrator-bootstrap.ts` and `run-agent.ts` are injection-boundary files:
 * they wire the commercial tier gate, Stripe post-deploy hook, setup-copilot
 * gate, plan resolver, and encrypted deployment_config reader into the otherwise
 * open orchestration stack. This seam lets both files stay commercial-free and
 * IDENTICAL across the private and public repos — the public `kageops-core` ships
 * a stub `bootstrap-extensions.commercial.ts` that returns the no-op below.
 *
 * Pattern mirrors PlanGate (#350) / PostDeployHook (#351) / the main.ts
 * commercial-loader: interface in core, open default, inject at the boundary.
 */
import type { Plan, PlanGate } from '../shared/plan-gate';
import type { PostDeployHook } from '../agents/post-deploy-hook';
import type { SetupCopilotGate } from './setup-copilot-gate';
import type { EventBus } from './event-bus';

export interface BootstrapExtensions {
    /** Commercial tier gate (paid plans). Open build → `openPlanGate`. */
    readonly planGate?: PlanGate;
    /** Stripe webhook post-deploy hook for Aegis. Open build → Aegis's no-op. */
    readonly postDeployHook?: PostDeployHook;
    /** Build the setup-copilot credential gate bound to the event bus. */
    readonly createSetupCopilotGate?: (eventBus: EventBus) => SetupCopilotGate;
    /** Synchronous current-plan accessor (cached). Open build → always 'free'. */
    readonly getCurrentPlan?: () => Plan;
    /** Warm the plan cache in the background (commercial plan resolver). */
    readonly warmPlanCache?: () => Promise<void>;
    /** Install the encrypted deployment_config reader into the materialiser. */
    readonly installDeploymentConfigReader?: () => void;
}

/** Open-build default: no commercial bootstrap wiring. */
export const noopBootstrapExtensions: BootstrapExtensions = {};
