/**
 * "Run locally / no hosting" mode (BPF-7) + token-aware auto-hosting.
 *
 * Some operators just want a working app on their own machine — no Vercel
 * account, no deploy token, no cloud preview. When hosting is off, the
 * development exit gate stops requiring a deploy-preview: a green build + tests
 * finishes the phase, and the scaffold's `SETUP.md` explains how to run locally.
 *
 * Decision precedence for `KAGEOPS_NO_HOSTING`:
 *   1. Explicit env value (`0`/`1`/`true`) — always wins (CI, headless, power users).
 *   2. Auto (open build) — driven by whether a Vercel deploy token exists:
 *        token present  → hosting ON  (deploy)  → NO_HOSTING=0
 *        token absent   → hosting OFF (local)   → NO_HOSTING=1
 *      Applied at boot AND whenever the token is saved/cleared in the UI, so a
 *      clean build never wedges waiting for a deploy the user hasn't set up, and
 *      pasting a token in the New Project modal enables deploy immediately — no
 *      global toggle to flip by hand.
 */

/** Was KAGEOPS_NO_HOSTING explicitly set at process start? If so, never auto-manage it. */
const explicitlySet = process.env['KAGEOPS_NO_HOSTING'] !== undefined;

export const HOSTING_DISABLED_MESSAGE =
    'Run-locally mode is on (no Vercel token) — skipping the cloud deploy preview. ' +
    'The app builds and runs locally; see SETUP.md in the project for how to start it. ' +
    'Add a Vercel token in the deployment settings to deploy instead.';

export function isHostingDisabled(): boolean {
    const v = process.env['KAGEOPS_NO_HOSTING'];
    return v === '1' || v === 'true';
}

/** True when the operator pinned KAGEOPS_NO_HOSTING explicitly (auto is off). */
export function isHostingExplicitlySet(): boolean {
    return explicitlySet;
}

/**
 * Auto-manage hosting from Vercel-token presence — a no-op when the operator
 * set KAGEOPS_NO_HOSTING explicitly. Called at boot and on token save/clear.
 */
export function applyAutoHosting(tokenPresent: boolean): void {
    if (explicitlySet) return;
    process.env['KAGEOPS_NO_HOSTING'] = tokenPresent ? '0' : '1';
}
