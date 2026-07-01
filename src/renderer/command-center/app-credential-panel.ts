/**
 * MCC-8 / Slice 4 — app-credential ledger panel.
 *
 * Per-project sibling of setup-copilot-panel.ts (Azure platform setup). Renders
 * the credentials a project still needs — each with WHY-now, a deep link to the
 * exact dashboard page, and an inline paste field that validates on entry. A
 * rejected value shows its fix-oriented reason and is never stored; an accepted
 * value lands in the project's deployment_config (the store the deploy already
 * reads) and the credential drops off the ledger. Late-bound credentials
 * (`blocked-until-deploy`, e.g. the Stripe webhook secret) are shown as pending,
 * not actionable. Empty ledger → renders nothing (no nag once set up).
 *
 * Driven by injected `deps` so it tests under jsdom with a fake bridge.
 */

export type CredentialStatus =
    | 'not-needed' | 'needed-now' | 'provided' | 'validated' | 'blocked-until-deploy';

export interface CredentialProposalView {
    readonly playbookId: string;
    readonly title: string;
    readonly description: string;
    readonly reason: string;
    readonly status: CredentialStatus;
    readonly action: 'navigate' | 'execute';
    readonly mutates: boolean;
    readonly sourceUrl: string;
    readonly envKeys: readonly string[];
}

export interface AppLedgerData {
    readonly phase: string;
    readonly proposals: readonly CredentialProposalView[];
    readonly providedEnvKeys: readonly string[];
}

export interface CredentialCheckView {
    readonly valid: boolean;
    readonly reason?: string;
}

export interface ProvideCredentialData extends AppLedgerData {
    readonly check: CredentialCheckView;
}

type Envelope<T> =
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: string };

export interface AppCredentialPanelDeps {
    readonly projectId: string;
    readonly listAppProposals: (projectId: string) => Promise<Envelope<AppLedgerData>>;
    readonly provideCredential: (
        projectId: string,
        envKey: string,
        value: string,
    ) => Promise<Envelope<ProvideCredentialData>>;
    /**
     * L3 auto-provision (Slice 5): run an `execute` playbook — create the Stripe
     * Price / register the webhook (test-mode) — and return the refreshed ledger.
     */
    readonly provisionCredential?: (
        projectId: string,
        playbookId: string,
    ) => Promise<Envelope<ProvideCredentialData>>;
    /** Subscribe to Sensei's mid-run `setup.required` push. Returns unsubscribe. */
    readonly onSetupRequired?: (callback: (event: unknown) => void) => () => void;
    /** Open a deep link in the OS browser (Electron). Falls back to no-op. */
    readonly openExternal?: (url: string) => void;
}

export interface AppCredentialPanelHandle {
    readonly refresh: () => Promise<void>;
    readonly dispose: () => void;
}

// ── Production deps ─────────────────────────────────────

interface AppCredentialBridge {
    readonly listAppProposals: (projectId: string) => Promise<Envelope<AppLedgerData>>;
    readonly provideCredential: (
        projectId: string,
        envKey: string,
        value: string,
    ) => Promise<Envelope<ProvideCredentialData>>;
    readonly provisionCredential: (
        projectId: string,
        playbookId: string,
    ) => Promise<Envelope<ProvideCredentialData>>;
    readonly onSetupRequired: (callback: (event: unknown) => void) => () => void;
}

/**
 * Wire the panel to the real preload bridge for a given project. Throws if the
 * `window.kageOps.setup` bridge is missing (mount sites catch and skip).
 */
export function defaultAppCredentialPanelDeps(projectId: string): AppCredentialPanelDeps {
    const api = (
        window as unknown as {
            kageOps?: { setup?: Partial<AppCredentialBridge>; openExternal?: (url: string) => void };
        }
    ).kageOps;
    const setup = api?.setup;
    if (
        setup?.listAppProposals === undefined ||
        setup.provideCredential === undefined ||
        setup.onSetupRequired === undefined
    ) {
        throw new Error('app-credential panel: window.kageOps.setup bridge missing');
    }
    return {
        projectId,
        listAppProposals: (id) => setup.listAppProposals!(id),
        provideCredential: (id, envKey, value) => setup.provideCredential!(id, envKey, value),
        // Optional — older preloads may not expose it; the panel guards its absence.
        ...(setup.provisionCredential !== undefined
            ? { provisionCredential: (id: string, pb: string) => setup.provisionCredential!(id, pb) }
            : {}),
        onSetupRequired: (cb) => setup.onSetupRequired!(cb),
        openExternal: api?.openExternal,
    };
}

export function renderAppCredentialPanel(
    root: HTMLElement,
    deps: AppCredentialPanelDeps,
): AppCredentialPanelHandle {
    root.classList.add('app-credential-panel');

    async function refresh(): Promise<void> {
        const res = await deps.listAppProposals(deps.projectId);
        if (!res.success || res.data.proposals.length === 0) {
            // Discovery is additive — a failure or an empty ledger hides the panel.
            root.innerHTML = '';
            return;
        }
        root.innerHTML = buildHtml(res.data.proposals);
        wire(res.data.proposals);
    }

    function wire(proposals: readonly CredentialProposalView[]): void {
        root.querySelectorAll<HTMLAnchorElement>('[data-cred-link]').forEach((a) => {
            a.addEventListener('click', (ev) => {
                if (deps.openExternal !== undefined) {
                    ev.preventDefault();
                    deps.openExternal(a.dataset['credLink'] ?? '');
                }
            });
        });
        root.querySelectorAll<HTMLButtonElement>('[data-cred-provide]').forEach((btn) => {
            btn.addEventListener('click', () => void provide(btn, proposals));
        });
        root.querySelectorAll<HTMLButtonElement>('[data-cred-execute]').forEach((btn) => {
            btn.addEventListener('click', () => void execute(btn));
        });
    }

    /** L3: ask Sensei to provision the credential (create the Price / register webhook). */
    async function execute(btn: HTMLButtonElement): Promise<void> {
        const playbookId = btn.dataset['credExecute'] ?? '';
        if (deps.provisionCredential === undefined) {
            setStatus(playbookId, 'Auto-provisioning unavailable in this build.', false);
            return;
        }
        btn.disabled = true;
        setStatus(playbookId, 'Working…', true);
        const res = await deps.provisionCredential(deps.projectId, playbookId);
        btn.disabled = false;
        if (!res.success) {
            setStatus(playbookId, res.error, false);
            return;
        }
        if (res.data.check.valid) {
            // Provisioned + persisted — re-render so the item drops off the ledger.
            await refresh();
            return;
        }
        setStatus(playbookId, res.data.check.reason ?? 'Provisioning failed.', false);
    }

    async function provide(
        btn: HTMLButtonElement,
        proposals: readonly CredentialProposalView[],
    ): Promise<void> {
        const envKey = btn.dataset['credProvide'] ?? '';
        const input = root.querySelector<HTMLInputElement>(`[data-cred-input="${cssEscape(envKey)}"]`);
        const value = input?.value.trim() ?? '';
        if (value === '') {
            setStatus(envKey, 'Paste a value first.', false);
            return;
        }
        btn.disabled = true;
        setStatus(envKey, 'Validating…', true);
        const res = await deps.provideCredential(deps.projectId, envKey, value);
        btn.disabled = false;
        if (!res.success) {
            setStatus(envKey, res.error, false);
            return;
        }
        if (res.data.check.valid) {
            // Accepted + persisted — re-render so the credential drops off.
            await refresh();
            return;
        }
        setStatus(envKey, res.data.check.reason ?? 'That value did not validate.', false);
        void proposals; // proposals captured for parity with the Azure panel's wire()
    }

    function setStatus(envKey: string, message: string, pending: boolean): void {
        const el = root.querySelector<HTMLElement>(`[data-cred-status="${cssEscape(envKey)}"]`);
        if (el === null) return;
        el.textContent = message;
        el.classList.toggle('is-error', !pending && message !== '');
    }

    let unsubscribe: (() => void) | null = null;
    if (deps.onSetupRequired !== undefined) {
        unsubscribe = deps.onSetupRequired((event) => {
            if (matchesProject(event, deps.projectId)) void refresh();
        });
    }

    void refresh();
    return {
        refresh,
        dispose: (): void => {
            if (unsubscribe !== null) {
                unsubscribe();
                unsubscribe = null;
            }
        },
    };
}

/** True when a forwarded `setup.required` payload targets this project. */
function matchesProject(event: unknown, projectId: string): boolean {
    if (typeof event !== 'object' || event === null) return false;
    const pid = (event as Record<string, unknown>)['projectId'];
    // A null/absent projectId is treated as "broadcast" — refresh anyway.
    return pid === undefined || pid === null || pid === projectId;
}

// ── HTML ────────────────────────────────────────────────

function buildHtml(proposals: readonly CredentialProposalView[]): string {
    const items = proposals.map((p) => buildItem(p)).join('');
    return `
        <div class="app-credential">
            <div class="app-credential-head">
                <span class="app-credential-title">Credentials needed</span>
                <span class="app-credential-sub">Sensei needs a few credentials to finish this app</span>
            </div>
            <ul class="app-credential-list">${items}</ul>
        </div>
    `;
}

function buildItem(p: CredentialProposalView): string {
    const link = `<a class="app-credential-link" href="${escapeAttr(p.sourceUrl)}" data-cred-link="${escapeAttr(p.sourceUrl)}" target="_blank" rel="noreferrer">Where to get it ↗</a>`;
    const body =
        p.status === 'blocked-until-deploy'
            ? `<span class="app-credential-pending">Pending deploy</span>`
            : p.action === 'execute'
                ? buildExecute(p)
                : p.envKeys.map((k) => buildField(k)).join('');
    return `
        <li class="app-credential-item" data-cred-item="${escapeAttr(p.playbookId)}">
            <div class="app-credential-item-main">
                <span class="app-credential-item-title">${escapeHtml(p.title)}</span>
                <span class="app-credential-item-reason">${escapeHtml(p.reason)}</span>
                ${link}
            </div>
            <div class="app-credential-item-fields">${body}</div>
        </li>
    `;
}

/** One-click button for an `execute` (L3 auto-provision) proposal. */
function buildExecute(p: CredentialProposalView): string {
    return `
        <div class="app-credential-field app-credential-field-execute">
            <button class="btn-sm btn-primary" data-cred-execute="${escapeAttr(p.playbookId)}">${escapeHtml(executeLabel(p.playbookId))}</button>
            <span class="app-credential-status" data-cred-status="${escapeAttr(p.playbookId)}"></span>
        </div>
    `;
}

/** Action-phrased label per execute playbook (test-mode auto-provision). */
function executeLabel(playbookId: string): string {
    switch (playbookId) {
        case 'createStripePrice':
            return 'Create it for me (test mode)';
        case 'registerStripeWebhook':
            return 'Register it for me (test mode)';
        default:
            return 'Set it up for me';
    }
}

function buildField(envKey: string): string {
    return `
        <div class="app-credential-field">
            <label class="app-credential-label">${escapeHtml(envKey)}</label>
            <input class="app-credential-input" type="password" autocomplete="off" spellcheck="false"
                   data-cred-input="${escapeAttr(envKey)}" placeholder="Paste ${escapeAttr(envKey)}…" />
            <button class="btn-sm btn-primary" data-cred-provide="${escapeAttr(envKey)}">Validate &amp; save</button>
            <span class="app-credential-status" data-cred-status="${escapeAttr(envKey)}"></span>
        </div>
    `;
}

// ── Helpers ─────────────────────────────────────────────

function escapeHtml(raw: string): string {
    return raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(raw: string): string {
    return raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cssEscape(raw: string): string {
    return raw.replace(/["\\\]]/g, '\\$&');
}
