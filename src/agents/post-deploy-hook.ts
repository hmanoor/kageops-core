/**
 * PostDeployHook — kageops-core split seam (manifest §0 edge #2).
 *
 * Aegis runs a post-deploy step after a successful preview deploy. The only
 * COMMERCIAL part of that step is the opt-in Stripe webhook auto-registration
 * (MCC-8 / Slice 5), which pulls in `app-provision-service` + the encrypted
 * deployment-config repo. The open core depends ONLY on this interface +
 * {@link noopPostDeployHook}; the commercial layer injects the real hook
 * (`stripePostDeployHook`) at its construction sites (bootstrap / burst).
 *
 * At clean-seed the commercial implementation moves to `kageops-cloud`; the
 * open Aegis keeps the interface and the no-op default.
 */
export interface PostDeployContext {
    readonly projectId: string;
    readonly deployedUrl: string;
    readonly runtimeEnv: Record<string, string> | undefined;
}

export interface PostDeployHook {
    /**
     * Invoked after a successful preview deploy. Returns a human-readable
     * progress note to surface (or null when nothing happened). MUST NOT throw
     * — a hook failure must never fail the deploy.
     */
    onDeployed(ctx: PostDeployContext): Promise<string | null>;
}

/** OPEN default — does nothing. The open core ships no post-deploy provisioning. */
export const noopPostDeployHook: PostDeployHook = {
    onDeployed: async () => null,
};
