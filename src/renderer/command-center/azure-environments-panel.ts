/**
 * Pillar 2.5 / PR-C — Azure Environments registry panel.
 *
 * Backs the Deployments tab. Absorbs (and replaces) the orphaned
 * deployment-target form: one row = one operator Azure environment
 * (subscription / resource group / region [+ optional tenant +
 * credential ref]) entered ONCE. Cloud Burst pools and (future) deploy
 * targets reference an environment instead of re-typing coordinates —
 * the D-A unification.
 *
 * Per D-H this is the top half of the Deployments tab; the Deploy
 * history list lands below it in PR-H.
 *
 * Unlike the Cloud Burst panel this view does NOT poll, so an open
 * create/edit form is never wiped out from under the operator — the
 * panel only re-renders on an explicit save / delete.
 *
 * Tests target `renderAzureEnvironmentsPanel(root, deps)` directly with
 * a fake `deps` so the suite drives the DOM without an Electron preload.
 */

// ── IPC envelope shapes (mirror of preload + handler exports) ──

export interface AzureEnvironmentView {
    readonly id: string;
    readonly label: string;
    readonly subscriptionId: string;
    readonly resourceGroup: string;
    readonly defaultRegion: string;
    readonly tenantId: string | null;
    readonly credentialRef: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

type Envelope<T> =
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: string; readonly kind?: string };

type DeleteEnvelope =
    | { readonly success: true }
    | { readonly success: false; readonly error: string; readonly kind?: string };

export interface AzureEnvCreateInput {
    readonly label: string;
    readonly subscriptionId: string;
    readonly resourceGroup: string;
    readonly defaultRegion: string;
    readonly tenantId?: string | null;
    readonly credentialRef?: string | null;
}

export interface AzureEnvUpdatePatch {
    readonly resourceGroup?: string;
    readonly defaultRegion?: string;
    readonly tenantId?: string | null;
    readonly credentialRef?: string | null;
}

// ── Dep injection ──────────────────────────────────────

export interface AzureEnvironmentsPanelDeps {
    readonly listEnvironments: () => Promise<Envelope<readonly AzureEnvironmentView[]>>;
    readonly createEnvironment: (input: AzureEnvCreateInput) => Promise<Envelope<AzureEnvironmentView>>;
    readonly updateEnvironment: (id: string, patch: AzureEnvUpdatePatch) => Promise<Envelope<AzureEnvironmentView>>;
    readonly deleteEnvironment: (id: string) => Promise<DeleteEnvelope>;
    /** Confirm hook (test seam). Defaults to window.confirm. */
    readonly confirm?: (message: string) => boolean;
}

export interface AzureEnvironmentsPanelHandle {
    readonly refresh: () => Promise<void>;
    readonly destroy: () => void;
}

/** Common Azure regions surfaced as a datalist; free text is still allowed. */
const KNOWN_REGIONS: readonly string[] = [
    'australiaeast',
    'australiasoutheast',
    'eastus',
    'eastus2',
    'westus',
    'westus2',
    'westeurope',
    'northeurope',
    'southeastasia',
    'eastasia',
];

// ── Production deps from the preload bridge ─────────────

interface AzureEnvBridge {
    readonly list: () => Promise<Envelope<readonly AzureEnvironmentView[]>>;
    readonly get: (id: string) => Promise<Envelope<AzureEnvironmentView | null>>;
    readonly create: (input: AzureEnvCreateInput) => Promise<Envelope<AzureEnvironmentView>>;
    readonly update: (id: string, patch: AzureEnvUpdatePatch) => Promise<Envelope<AzureEnvironmentView>>;
    readonly delete: (id: string) => Promise<DeleteEnvelope>;
}

export function defaultAzureEnvironmentsPanelDeps(): AzureEnvironmentsPanelDeps {
    const api = (window as unknown as { kageOps?: { azureEnvironment?: AzureEnvBridge } }).kageOps;
    if (api?.azureEnvironment === undefined) {
        throw new Error('azure-environments panel: window.kageOps.azureEnvironment preload bridge missing');
    }
    const bridge = api.azureEnvironment;
    return {
        listEnvironments: () => bridge.list(),
        createEnvironment: (input) => bridge.create(input),
        updateEnvironment: (id, patch) => bridge.update(id, patch),
        deleteEnvironment: (id) => bridge.delete(id),
    };
}

// ── Renderer ───────────────────────────────────────────

export function renderAzureEnvironmentsPanel(
    root: HTMLElement,
    deps: AzureEnvironmentsPanelDeps
): AzureEnvironmentsPanelHandle {
    const confirmFn = deps.confirm ?? ((m: string) => window.confirm(m));
    root.innerHTML = '';
    root.classList.add('azure-env-panel');

    // Tracks which row is mid-edit so a refresh re-opens the same editor.
    let editingId: string | null = null;
    let formOpen = false;

    async function refresh(): Promise<void> {
        const res = await deps.listEnvironments();
        if (!res.success) {
            root.innerHTML = `<div class="empty-state">Failed to load environments: ${escapeHtml(res.error)}</div>`;
            return;
        }
        renderPanel(res.data);
    }

    function renderPanel(envs: readonly AzureEnvironmentView[]): void {
        root.innerHTML = buildPanelHtml(envs, formOpen);
        wireToolbar();
        if (formOpen) wireCreateForm();
        wireRowActions(envs);
        if (editingId !== null) {
            const env = envs.find((e) => e.id === editingId) ?? null;
            if (env !== null) openEditor(env);
            else editingId = null;
        }
    }

    function wireToolbar(): void {
        const addBtn = root.querySelector<HTMLButtonElement>('[data-azenv-add]');
        addBtn?.addEventListener('click', () => {
            formOpen = true;
            editingId = null;
            renderCurrent();
        });
    }

    function renderCurrent(): void {
        void refresh();
    }

    function wireCreateForm(): void {
        const form = root.querySelector<HTMLFormElement>('[data-azenv-create]');
        const cancel = root.querySelector<HTMLButtonElement>('[data-azenv-create-cancel]');
        cancel?.addEventListener('click', () => {
            formOpen = false;
            renderCurrent();
        });
        if (form === null) return;
        form.addEventListener('submit', (ev) => {
            ev.preventDefault();
            const fd = new FormData(form);
            const input: AzureEnvCreateInput = {
                label: str(fd, 'label'),
                subscriptionId: str(fd, 'subscriptionId'),
                resourceGroup: str(fd, 'resourceGroup'),
                defaultRegion: str(fd, 'defaultRegion'),
                tenantId: blankToNull(str(fd, 'tenantId')),
                credentialRef: blankToNull(str(fd, 'credentialRef')),
            };
            if (input.label === '' || input.subscriptionId === '' || input.resourceGroup === '' || input.defaultRegion === '') {
                setFormError(form, 'Label, Subscription ID, Resource Group and Region are required.');
                return;
            }
            setFormError(form, '');
            const submit = form.querySelector<HTMLButtonElement>('[type="submit"]');
            if (submit !== null) { submit.disabled = true; submit.textContent = 'Saving…'; }
            void deps.createEnvironment(input).then((res) => {
                if (res.success) {
                    formOpen = false;
                    renderCurrent();
                } else {
                    if (submit !== null) { submit.disabled = false; submit.textContent = 'Save environment'; }
                    setFormError(form, res.error);
                }
            });
        });
    }

    function wireRowActions(envs: readonly AzureEnvironmentView[]): void {
        root.querySelectorAll<HTMLButtonElement>('[data-azenv-edit]').forEach((btn) => {
            btn.addEventListener('click', () => {
                editingId = btn.dataset['azenvEdit'] ?? null;
                formOpen = false;
                renderCurrent();
            });
        });
        root.querySelectorAll<HTMLButtonElement>('[data-azenv-delete]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset['azenvDelete'] ?? '';
                const env = envs.find((e) => e.id === id);
                if (env === undefined) return;
                if (!confirmFn(`Delete environment "${env.label}"? Cloud Burst pools that reference it must be repointed first.`)) {
                    return;
                }
                btn.disabled = true;
                void deps.deleteEnvironment(id).then((res) => {
                    if (res.success) {
                        if (editingId === id) editingId = null;
                        renderCurrent();
                    } else {
                        btn.disabled = false;
                        setRowStatus(id, res.error);
                    }
                });
            });
        });
    }

    function openEditor(env: AzureEnvironmentView): void {
        const row = root.querySelector<HTMLElement>(`[data-azenv-row="${cssEscape(env.id)}"]`);
        if (row === null) return;
        const editRow = document.createElement('tr');
        editRow.className = 'azure-env-edit-row';
        editRow.innerHTML = `
            <td colspan="6">
                <form class="deployment-form-inner" data-azenv-edit-form>
                    <p class="azure-env-edit-title">Edit <strong>${escapeHtml(env.label)}</strong>
                        <span class="azure-env-immutable">label &amp; subscription are immutable — delete &amp; recreate to change them</span>
                    </p>
                    <div class="deployment-form-grid">
                        <div class="field-row">
                            <label>Subscription ID</label>
                            <input type="text" value="${escapeAttr(env.subscriptionId)}" disabled>
                        </div>
                        <div class="field-row">
                            <label for="azenv-edit-rg">Resource Group</label>
                            <input type="text" id="azenv-edit-rg" name="resourceGroup" value="${escapeAttr(env.resourceGroup)}" autocomplete="off">
                        </div>
                        <div class="field-row">
                            <label for="azenv-edit-region">Region</label>
                            <input type="text" id="azenv-edit-region" name="defaultRegion" list="azenv-regions" value="${escapeAttr(env.defaultRegion)}" autocomplete="off">
                        </div>
                        <div class="field-row">
                            <label for="azenv-edit-tenant">Tenant ID (optional)</label>
                            <input type="text" id="azenv-edit-tenant" name="tenantId" value="${escapeAttr(env.tenantId ?? '')}" autocomplete="off">
                        </div>
                        <div class="field-row">
                            <label for="azenv-edit-cred">Credential ref (optional)</label>
                            <input type="text" id="azenv-edit-cred" name="credentialRef" value="${escapeAttr(env.credentialRef ?? '')}" autocomplete="off" placeholder="service-principal pointer">
                        </div>
                    </div>
                    <div class="deployment-form-error hidden" data-azenv-edit-error></div>
                    <div class="deployment-form-actions">
                        <button type="button" class="btn-secondary" data-azenv-edit-cancel>Cancel</button>
                        <button type="submit" class="btn-primary">Save changes</button>
                    </div>
                </form>
            </td>
        `;
        row.insertAdjacentElement('afterend', editRow);

        const form = editRow.querySelector<HTMLFormElement>('[data-azenv-edit-form]');
        editRow.querySelector<HTMLButtonElement>('[data-azenv-edit-cancel]')?.addEventListener('click', () => {
            editingId = null;
            renderCurrent();
        });
        if (form === null) return;
        form.addEventListener('submit', (ev) => {
            ev.preventDefault();
            const fd = new FormData(form);
            const patch: AzureEnvUpdatePatch = {
                resourceGroup: str(fd, 'resourceGroup'),
                defaultRegion: str(fd, 'defaultRegion'),
                tenantId: blankToNull(str(fd, 'tenantId')),
                credentialRef: blankToNull(str(fd, 'credentialRef')),
            };
            if (patch.resourceGroup === '' || patch.defaultRegion === '') {
                setEditError(editRow, 'Resource Group and Region are required.');
                return;
            }
            setEditError(editRow, '');
            const submit = form.querySelector<HTMLButtonElement>('[type="submit"]');
            if (submit !== null) { submit.disabled = true; submit.textContent = 'Saving…'; }
            void deps.updateEnvironment(env.id, patch).then((res) => {
                if (res.success) {
                    editingId = null;
                    renderCurrent();
                } else {
                    if (submit !== null) { submit.disabled = false; submit.textContent = 'Save changes'; }
                    setEditError(editRow, res.error);
                }
            });
        });
    }

    function setRowStatus(id: string, message: string): void {
        const el = root.querySelector<HTMLElement>(`[data-azenv-status="${cssEscape(id)}"]`);
        if (el !== null) el.textContent = message;
    }

    void refresh();

    return {
        refresh,
        destroy: () => { root.innerHTML = ''; },
    };
}

// ── HTML builders ──────────────────────────────────────

function buildPanelHtml(envs: readonly AzureEnvironmentView[], formOpen: boolean): string {
    const tableHtml = envs.length > 0
        ? buildTableHtml(envs)
        : '<div class="empty-state">No Azure environments yet. Add one — Cloud Burst and Deployments will share it.</div>';

    return `
        <div class="deployments-panel azure-env-body">
            <header class="azure-env-header">
                <div>
                    <h3>Azure Environments</h3>
                    <p class="azure-env-sub">Enter your Azure coordinates once. <strong>Cloud Burst</strong> uses them for ephemeral build-time compute; <strong>Deployments</strong> for persistent hosting.</p>
                </div>
                <button class="btn-sm btn-primary" data-azenv-add ${formOpen ? 'disabled' : ''}>+ Add Environment</button>
            </header>
            ${formOpen ? buildCreateFormHtml() : ''}
            <div class="deployment-table-wrapper">
                ${tableHtml}
            </div>
            <datalist id="azenv-regions">
                ${KNOWN_REGIONS.map((r) => `<option value="${escapeAttr(r)}"></option>`).join('')}
            </datalist>
        </div>
    `;
}

function buildCreateFormHtml(): string {
    return `
        <form class="deployment-form-inner azure-env-create" data-azenv-create>
            <h4 class="deployment-form-title">New Azure environment</h4>
            <div class="deployment-form-grid">
                <div class="field-row">
                    <label for="azenv-label">Label</label>
                    <input type="text" id="azenv-label" name="label" placeholder="e.g. Production AU" autocomplete="off">
                </div>
                <div class="field-row">
                    <label for="azenv-sub">Subscription ID</label>
                    <input type="text" id="azenv-sub" name="subscriptionId" placeholder="00000000-0000-0000-0000-000000000000" autocomplete="off">
                </div>
                <div class="field-row">
                    <label for="azenv-rg">Resource Group</label>
                    <input type="text" id="azenv-rg" name="resourceGroup" placeholder="kageops-prod" autocomplete="off">
                </div>
                <div class="field-row">
                    <label for="azenv-region">Region</label>
                    <input type="text" id="azenv-region" name="defaultRegion" list="azenv-regions" placeholder="australiaeast" autocomplete="off">
                </div>
                <div class="field-row">
                    <label for="azenv-tenant">Tenant ID (optional)</label>
                    <input type="text" id="azenv-tenant" name="tenantId" placeholder="auto-resolved if blank" autocomplete="off">
                </div>
                <div class="field-row">
                    <label for="azenv-cred">Credential ref (optional)</label>
                    <input type="text" id="azenv-cred" name="credentialRef" placeholder="defaults to DefaultAzureCredential" autocomplete="off">
                </div>
            </div>
            <div class="deployment-form-error hidden" data-azenv-create-error></div>
            <div class="deployment-form-actions">
                <button type="button" class="btn-secondary" data-azenv-create-cancel>Cancel</button>
                <button type="submit" class="btn-primary">Save environment</button>
            </div>
        </form>
    `;
}

function buildTableHtml(envs: readonly AzureEnvironmentView[]): string {
    const rows = envs.map((e) => buildRowHtml(e)).join('');
    return `
        <table class="data-table azure-env-table">
            <thead>
                <tr>
                    <th>Label</th>
                    <th>Subscription</th>
                    <th>Resource Group</th>
                    <th>Region</th>
                    <th>Credential</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
    `;
}

function buildRowHtml(env: AzureEnvironmentView): string {
    const credLabel = env.credentialRef !== null && env.credentialRef.length > 0
        ? `<span class="azure-env-cred azure-env-cred--sp" title="${escapeAttr(env.credentialRef)}">service principal</span>`
        : '<span class="azure-env-cred azure-env-cred--default">DefaultAzureCredential</span>';
    return `
        <tr data-azenv-row="${escapeAttr(env.id)}">
            <td class="azure-env-name">${escapeHtml(env.label)}</td>
            <td class="azure-env-mono">${escapeHtml(truncate(env.subscriptionId, 14))}</td>
            <td class="azure-env-mono">${escapeHtml(env.resourceGroup)}</td>
            <td>${escapeHtml(env.defaultRegion)}</td>
            <td>${credLabel}</td>
            <td class="azure-env-actions">
                <button class="btn-sm" data-azenv-edit="${escapeAttr(env.id)}" title="Edit">Edit</button>
                <button class="btn-sm btn-danger" data-azenv-delete="${escapeAttr(env.id)}" title="Delete">×</button>
                <span class="azure-env-row-status" data-azenv-status="${escapeAttr(env.id)}"></span>
            </td>
        </tr>
    `;
}

// ── Helpers ────────────────────────────────────────────

function str(fd: FormData, key: string): string {
    return String(fd.get(key) ?? '').trim();
}

function blankToNull(value: string): string | null {
    return value.length > 0 ? value : null;
}

function setFormError(form: HTMLElement, message: string): void {
    const el = form.querySelector<HTMLElement>('[data-azenv-create-error]');
    if (el === null) return;
    el.textContent = message;
    el.classList.toggle('hidden', message === '');
}

function setEditError(row: HTMLElement, message: string): void {
    const el = row.querySelector<HTMLElement>('[data-azenv-edit-error]');
    if (el === null) return;
    el.textContent = message;
    el.classList.toggle('hidden', message === '');
}

function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

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

/** Minimal CSS.escape fallback for attribute selectors (jsdom-safe). */
function cssEscape(raw: string): string {
    return raw.replace(/["\\\]]/g, '\\$&');
}
