/**
 * OSS-split seam — Sensei setup-copilot credential gate.
 *
 * When a development gate fails, the commercial build decides whether the cause
 * is a MISSING app credential (Stripe / Clerk / DB) rather than broken code, and
 * raises a `setup.required` event for the Command Center credential ledger so the
 * operator can paste the credential instead of Forge churning on an unfixable
 * task. That whole feature — the setup-copilot planner, the app-credential
 * service, and the encrypted `deployment_config` reader — is commercial.
 *
 * The open `kageops-core` build has no credential ledger: the gate is a no-op
 * (never raises), so normal Forge remediation always proceeds. The commercial
 * layer injects the real gate via `SenseiConfig.setupCopilotGate`.
 *
 * Pattern mirrors PlanGate (#350) / PostDeployHook (#351): interface in core,
 * open default, inject at the boundary.
 */
export interface SetupCopilotGate {
    /**
     * Inspect a project after a failed gate. Returns true if a `setup.required`
     * was raised (the caller then skips Forge remediation — there's nothing to
     * fix until the operator provides the credential). Fails safe: false means
     * "proceed with normal remediation".
     */
    maybeRaise(projectId: string): Promise<boolean>;
}

/** Open-build default: never raises — remediation proceeds unchanged. */
export const noopSetupCopilotGate: SetupCopilotGate = {
    maybeRaise: async () => false,
};
