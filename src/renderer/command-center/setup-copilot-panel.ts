/**
 * Pillar 2.5 / PR-L (D-N) — Sensei setup copilot panel.
 *
 * Sits at the top of the Deployments tab as a discovery banner: Sensei reads
 * the operator's KageOps/Azure state and proposes the next bounded setup
 * step. Executable proposals run inline after confirm (importAgentImage —
 * mutating, reuses the PR-K bridge; verifyAzureConnectivity — read-only);
 * navigational proposals point at the relevant form. When nothing is
 * proposed the panel renders nothing (no nag once setup is complete).
 *
 * Tests drive `renderSetupCopilotPanel(root, deps)` with a fake `deps`.
 */

export type SetupPlaybookId =
    | 'registerAzureEnvironment' | 'createBurstPool' | 'importAgentImage'
    | 'verifyAzureConnectivity' | 'deployProject';

export interface SetupProposalView {
    readonly playbookId: SetupPlaybookId;
    readonly title: string;
    readonly description: string;
    readonly reason: string;
    readonly action: 'execute' | 'navigate';
    readonly mutates: boolean;
    readonly navigateTo?: 'azure-environments' | 'cloud-burst-settings' | 'deployments';
    readonly params?: { subscriptionId?: string; resourceGroup?: string; registryName?: string };
}

type Envelope<T> =
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: string };

export interface SetupCopilotPanelDeps {
    readonly listProposals: () => Promise<Envelope<readonly SetupProposalView[]>>;
    readonly importAgentImage: (args: { subscriptionId: string; resourceGroup: string; registryName: string }) => Promise<Envelope<{ targetImage: string }>>;
    readonly verifyConnectivity: (subscriptionId: string) => Promise<Envelope<{ ok: boolean; message: string }>>;
    readonly confirm?: (message: string) => boolean;
}

export interface SetupCopilotPanelHandle {
    readonly refresh: () => Promise<void>;
}

// ── Production deps ─────────────────────────────────────

interface SetupBridge {
    readonly listProposals: () => Promise<Envelope<readonly SetupProposalView[]>>;
    readonly verifyConnectivity: (subscriptionId: string) => Promise<Envelope<{ ok: boolean; message: string }>>;
}
interface AcrBridge {
    readonly importAgentImage: (args: { subscriptionId: string; resourceGroup: string; registryName: string }) => Promise<Envelope<{ targetImage: string }>>;
}

export function defaultSetupCopilotPanelDeps(): SetupCopilotPanelDeps {
    const api = (window as unknown as { kageOps?: { setup?: SetupBridge; acr?: AcrBridge } }).kageOps;
    if (api?.setup === undefined) {
        throw new Error('setup-copilot panel: window.kageOps.setup preload bridge missing');
    }
    if (api.acr === undefined) {
        throw new Error('setup-copilot panel: window.kageOps.acr preload bridge missing');
    }
    const setup = api.setup;
    const acr = api.acr;
    return {
        listProposals: () => setup.listProposals(),
        verifyConnectivity: (sub) => setup.verifyConnectivity(sub),
        importAgentImage: (args) => acr.importAgentImage(args),
    };
}

// ── Renderer ───────────────────────────────────────────

const NAVIGATE_HINT: Record<NonNullable<SetupProposalView['navigateTo']>, string> = {
    'azure-environments': 'Add one in the Azure Environments section below.',
    'cloud-burst-settings': 'Configure a pool in Settings → Cloud Burst.',
    'deployments': 'Register a deploy target in the Deploy Targets section below.',
};

export function renderSetupCopilotPanel(
    root: HTMLElement,
    deps: SetupCopilotPanelDeps
): SetupCopilotPanelHandle {
    const confirmFn = deps.confirm ?? ((m: string) => window.confirm(m));
    root.classList.add('setup-copilot-panel');

    async function refresh(): Promise<void> {
        const res = await deps.listProposals();
        if (!res.success) {
            // Discovery is additive — a failure just hides the banner.
            root.innerHTML = '';
            return;
        }
        if (res.data.length === 0) {
            root.innerHTML = '';
            return;
        }
        root.innerHTML = buildHtml(res.data);
        wire(res.data);
    }

    function wire(proposals: readonly SetupProposalView[]): void {
        root.querySelectorAll<HTMLButtonElement>('[data-setup-run]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset['setupRun'] as SetupPlaybookId;
                const p = proposals.find((x) => x.playbookId === id);
                if (p === undefined) return;
                if (p.playbookId === 'importAgentImage') void runImport(p, btn);
                else if (p.playbookId === 'verifyAzureConnectivity') void runVerify(p, btn);
            });
        });
    }

    async function runImport(p: SetupProposalView, btn: HTMLButtonElement): Promise<void> {
        const sub = p.params?.subscriptionId ?? '';
        const rg = p.params?.resourceGroup ?? '';
        const reg = p.params?.registryName ?? '';
        if (sub === '' || rg === '' || reg === '') { setStatus(p.playbookId, 'Missing Azure coordinates for this import.'); return; }
        if (!confirmFn(`Import the agent image into ACR "${reg}"? This copies the public image into your registry (server-side).`)) return;
        btn.disabled = true;
        setStatus(p.playbookId, 'Importing…');
        const res = await deps.importAgentImage({ subscriptionId: sub, resourceGroup: rg, registryName: reg });
        btn.disabled = false;
        setStatus(p.playbookId, res.success ? `Imported → ${res.data.targetImage}` : `Import failed: ${res.error}`);
    }

    async function runVerify(p: SetupProposalView, btn: HTMLButtonElement): Promise<void> {
        const sub = p.params?.subscriptionId ?? '';
        btn.disabled = true;
        setStatus(p.playbookId, 'Checking…');
        const res = await deps.verifyConnectivity(sub);
        btn.disabled = false;
        setStatus(p.playbookId, res.success ? res.data.message : `Check failed: ${res.error}`);
    }

    function setStatus(id: string, message: string): void {
        const el = root.querySelector<HTMLElement>(`[data-setup-status="${cssEscape(id)}"]`);
        if (el !== null) el.textContent = message;
    }

    void refresh();
    return { refresh };
}

// ── HTML ────────────────────────────────────────────────

function buildHtml(proposals: readonly SetupProposalView[]): string {
    const items = proposals.map((p) => buildItem(p)).join('');
    return `
        <div class="setup-copilot">
            <div class="setup-copilot-head">
                <span class="setup-copilot-title">Setup Copilot</span>
                <span class="setup-copilot-sub">Sensei noticed a few things to set up</span>
            </div>
            <ul class="setup-copilot-list">${items}</ul>
        </div>
    `;
}

function buildItem(p: SetupProposalView): string {
    const actionHtml = p.action === 'execute'
        ? `<button class="btn-sm btn-primary" data-setup-run="${escapeAttr(p.playbookId)}">${p.playbookId === 'importAgentImage' ? 'Import image' : 'Verify'}</button>`
        : `<span class="setup-copilot-hint">${escapeHtml(p.navigateTo !== undefined ? NAVIGATE_HINT[p.navigateTo] : '')}</span>`;
    return `
        <li class="setup-copilot-item" data-setup-item="${escapeAttr(p.playbookId)}">
            <div class="setup-copilot-item-main">
                <span class="setup-copilot-item-title">${escapeHtml(p.title)}</span>
                <span class="setup-copilot-item-reason">${escapeHtml(p.reason)}</span>
            </div>
            <div class="setup-copilot-item-action">
                ${actionHtml}
                <span class="setup-copilot-status" data-setup-status="${escapeAttr(p.playbookId)}"></span>
            </div>
        </li>
    `;
}

// ── Helpers ────────────────────────────────────────────

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
