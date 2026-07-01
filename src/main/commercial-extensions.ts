/**
 * OSS-split seam (cut-order step 3a) — commercial boot/desktop extensions.
 *
 * `main.ts` is SHARED/boundary: it ships in the open `kageops-core` repo but must
 * not statically reference commercial-only modules — auth (Clerk device-flow),
 * plan/billing windows, team collaboration, and outbound connectors — which live
 * in the private `kageops-cloud` layer. This file declares the seam: an interface
 * of the commercial capabilities `main` wires at boot, plus a no-op default.
 *
 * The commercial layer populates it via `commercial-loader.ts`; the open build
 * ships a stub loader returning {} (the no-op), so `main.ts` compiles and runs
 * with cloud/auth/billing/team/connector features simply absent.
 *
 * Pattern mirrors the PlanGate (#350) and PostDeployHook (#351) seams:
 * interface in core, open default, inject at the boundary.
 */
import type { ConnectorEvent, RequiredPlanTier } from '../connectors/types';
import type { EventBus } from '../orchestrator/event-bus';

/**
 * Context the commercial cloud-handler batch needs from `main` — just an
 * accessor for the orchestrator's event bus (used by the deploy + burst
 * reconciler paths). The module-level orchestrator handle isn't in scope inside
 * the extracted commercial module, so `main` injects it here.
 */
export interface CloudHandlerContext {
    readonly getEventBus: () => EventBus | null;
    /**
     * Hand `main` the burst idle-reaper stop handle so it can stop the reaper on
     * app shutdown. Called with `null` to clear. (`main` owns the lifecycle; the
     * reaper itself is commercial.)
     */
    readonly setBurstIdleReaperStop: (stop: (() => void) | null) => void;
}

/**
 * Structural mirror of auth-window's `AuthSession` (commercial) so the open
 * boundary can type the auth callback without importing the commercial module.
 * Kept identical in shape — the commercial value is assignable to this.
 */
export interface AuthSessionLike {
    readonly userId: string;
    readonly email: string;
    readonly firstName: string | null;
    readonly lastName: string | null;
    readonly plan: string;
    readonly planSelected: boolean;
}

/**
 * Structural mirror of team-ipc's `TeamIpcDeps` (commercial). The optional deps
 * let team actions fan out to connectors / desktop notifications when the
 * orchestrator is up.
 */
export interface TeamIpcDeps {
    readonly publishEvent?: (channel: string, payload: Record<string, unknown>) => void;
    readonly notify?: {
        readonly taskCommented?: (opts: {
            projectName: string;
            taskTitle: string;
            authorName: string;
            excerpt: string;
            taskId: string;
        }) => void;
        readonly memberJoined?: (opts: {
            projectName: string;
            memberName: string;
            invitedBy: string;
        }) => void;
    };
}

/**
 * Commercial capabilities `main.ts` wires at boot. Every field is optional: in
 * the open build the loader returns `{}`, so `main` falls back to its skip-auth
 * path and simply never registers the cloud/auth/team/connector handlers.
 */
export interface CommercialExtensions {
    // ── Auth (Clerk device-flow) ──
    readonly registerAuthProtocol?: () => void;
    readonly registerAuthIpc?: () => void;
    readonly tryRestoreSession?: (onComplete: (session: AuthSessionLike) => void) => Promise<boolean>;
    readonly showAuthWindow?: (onComplete: (session: AuthSessionLike) => void) => void;
    /** Sign out and re-show the auth window (tray "Sign Out"). */
    readonly signOut?: () => void;

    // ── Plan / billing ──
    readonly registerPlanIpc?: () => void;
    readonly showPlanWindow?: (session: AuthSessionLike, onSelected: (plan: string) => void) => void;
    /** Re-open the plan window from the Command Center (resolves the current session first). */
    readonly reopenPlanWindow?: () => Promise<{ ok: boolean; error?: string }>;

    // ── Team collaboration ──
    readonly registerTeamIpc?: (deps?: TeamIpcDeps) => void;

    // ── Outbound connectors (Slack / Discord / Teams) ──
    readonly registerConnectorIpc?: () => void;
    readonly broadcastConnectorEvent?: (event: ConnectorEvent, activePlan?: RequiredPlanTier) => Promise<void>;

    // ── Cloud / Deploy IPC handler batch (Cloud Burst, Azure Env, Deploy, ACR,
    //    setup-copilot, app-credential) — registered once at Command Center IPC setup. ──
    readonly registerCloudHandlers?: (ctx: CloudHandlerContext) => void;

    // ── Deployment-config IPC handlers (encrypted app-deploy credential store +
    //    provider secret tests) — registered once at Command Center IPC setup. ──
    readonly registerDeployConfigHandlers?: () => void;
}

/** Open-build default: no commercial capabilities wired. */
export const noopCommercialExtensions: CommercialExtensions = {};
