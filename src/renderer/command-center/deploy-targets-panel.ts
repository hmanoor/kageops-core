/**
 * Pillar 2.5 / PR-G — Deploy Targets panel.
 *
 * The lower half of the Deployments tab (the Azure Environments registry
 * sits above it, per D-H). One row = one deploy target: "deploy this
 * project to this environment as this service type, named this app." The
 * Deploy button fires a one-click, manual deploy (D-F) and shows the run's
 * live status inline; a recent-runs list sits below.
 *
 * D-E auto-suggest: when the operator picks a project in the create form,
 * the service type is pre-selected from the project's type (server → App
 * Service, static → Static Web Apps) with a short reason — the operator
 * can still override before saving.
 *
 * Like the Environments panel, this view does NOT poll, so an open
 * create form is never wiped from under the operator — it re-renders only
 * on an explicit save / delete / deploy.
 *
 * Tests target `renderDeployTargetsPanel(root, deps)` directly with a fake
 * `deps`, so the suite drives the DOM without an Electron preload.
 */

// ── View + envelope shapes ──────────────────────────────

export type DeployServiceType = 'app-service' | 'static-web-app';

export interface DeployTargetView {
    readonly id: string;
    readonly environmentId: string;
    readonly projectId: string | null;
    readonly serviceType: DeployServiceType;
    readonly appName: string;
    readonly config: { readonly sku?: string; readonly runtime?: string; readonly appServicePlanName?: string };
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface DeployRunView {
    readonly id: string;
    readonly targetId: string;
    readonly projectId: string | null;
    readonly status: 'queued' | 'provisioning' | 'deploying' | 'live' | 'failed';
    readonly liveUrl: string | null;
    readonly errorMessage: string | null;
    readonly startedAt: string;
    readonly finishedAt: string | null;
}

export interface ProjectOption {
    readonly id: string;
    readonly name: string;
}

export interface EnvironmentOption {
    readonly id: string;
    readonly label: string;
}

export interface ServiceSuggestion {
    readonly serviceType: DeployServiceType;
    readonly reason: string;
}

export interface DeployRunResult {
    readonly runId: string;
    readonly status: 'live' | 'failed';
    readonly liveUrl: string | null;
    readonly resourceId: string | null;
}

type Envelope<T> =
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: string; readonly kind?: string };

type DeleteEnvelope =
    | { readonly success: true }
    | { readonly success: false; readonly error: string; readonly kind?: string };

export interface DeployTargetCreateInput {
    readonly environmentId: string;
    readonly serviceType: DeployServiceType;
    readonly appName: string;
    readonly projectId?: string | null;
    readonly config?: { sku?: string; runtime?: string; appServicePlanName?: string };
}

// ── Dep injection ──────────────────────────────────────

export interface DeployTargetsPanelDeps {
    readonly listTargets: () => Promise<Envelope<readonly DeployTargetView[]>>;
    readonly createTarget: (input: DeployTargetCreateInput) => Promise<Envelope<DeployTargetView>>;
    readonly deleteTarget: (id: string) => Promise<DeleteEnvelope>;
    readonly trigger: (args: { targetId: string; appZipUrl?: string }) => Promise<Envelope<DeployRunResult>>;
    readonly teardown: (targetId: string) => Promise<Envelope<{ targetId: string; appName: string }>>;
    readonly suggestServiceType: (projectId: string) => Promise<Envelope<ServiceSuggestion>>;
    readonly listRecentRuns: () => Promise<Envelope<readonly DeployRunView[]>>;
    readonly listRunsByTarget: (targetId: string) => Promise<Envelope<readonly DeployRunView[]>>;
    readonly listProjects: () => Promise<readonly ProjectOption[]>;
    readonly listEnvironments: () => Promise<readonly EnvironmentOption[]>;
    /** Confirm hook (test seam). Defaults to window.confirm. */
    readonly confirm?: (message: string) => boolean;
    /** Prompt for the SWA published zip URL (test seam). Defaults to window.prompt. */
    readonly promptZipUrl?: (message: string) => string | null;
}

export interface DeployTargetsPanelHandle {
    readonly refresh: () => Promise<void>;
    readonly destroy: () => void;
}

// ── Production deps from the preload bridge ─────────────

interface DeployBridge {
    readonly listTargets: () => Promise<Envelope<readonly DeployTargetView[]>>;
    readonly createTarget: (input: DeployTargetCreateInput) => Promise<Envelope<DeployTargetView>>;
    readonly deleteTarget: (id: string) => Promise<DeleteEnvelope>;
    readonly trigger: (args: { targetId: string; appZipUrl?: string }) => Promise<Envelope<DeployRunResult>>;
    readonly teardown: (targetId: string) => Promise<Envelope<{ targetId: string; appName: string }>>;
    readonly suggestServiceType: (projectId: string) => Promise<Envelope<ServiceSuggestion>>;
    readonly listRecentRuns: () => Promise<Envelope<readonly DeployRunView[]>>;
    readonly listRunsByTarget: (targetId: string) => Promise<Envelope<readonly DeployRunView[]>>;
}

interface AzureEnvBridgeLite {
    readonly list: () => Promise<Envelope<readonly { id: string; label: string }[]>>;
}

export function defaultDeployTargetsPanelDeps(): DeployTargetsPanelDeps {
    const api = (window as unknown as {
        kageOps?: {
            deploy?: DeployBridge;
            azureEnvironment?: AzureEnvBridgeLite;
            getProjects?: () => Promise<readonly { id: string; name: string }[]>;
        };
    }).kageOps;
    if (api?.deploy === undefined) {
        throw new Error('deploy-targets panel: window.kageOps.deploy preload bridge missing');
    }
    if (api.azureEnvironment === undefined) {
        throw new Error('deploy-targets panel: window.kageOps.azureEnvironment preload bridge missing');
    }
    const deploy = api.deploy;
    const azureEnvironment = api.azureEnvironment;
    const getProjects = api.getProjects;
    return {
        listTargets: () => deploy.listTargets(),
        createTarget: (input) => deploy.createTarget(input),
        deleteTarget: (id) => deploy.deleteTarget(id),
        trigger: (args) => deploy.trigger(args),
        teardown: (id) => deploy.teardown(id),
        suggestServiceType: (projectId) => deploy.suggestServiceType(projectId),
        listRecentRuns: () => deploy.listRecentRuns(),
        listRunsByTarget: (id) => deploy.listRunsByTarget(id),
        listProjects: async () => {
            if (getProjects === undefined) return [];
            const projects = await getProjects();
            return projects.map((p) => ({ id: p.id, name: p.name }));
        },
        listEnvironments: async () => {
            const res = await azureEnvironment.list();
            if (!res.success) return [];
            return res.data.map((e) => ({ id: e.id, label: e.label }));
        },
    };
}

// ── Renderer ───────────────────────────────────────────

export function renderDeployTargetsPanel(
    root: HTMLElement,
    deps: DeployTargetsPanelDeps
): DeployTargetsPanelHandle {
    const confirmFn = deps.confirm ?? ((m: string) => window.confirm(m));
    const promptFn = deps.promptZipUrl ?? ((m: string) => window.prompt(m));
    root.innerHTML = '';
    root.classList.add('deploy-targets-panel');

    let formOpen = false;
    let projects: readonly ProjectOption[] = [];
    let environments: readonly EnvironmentOption[] = [];
    // Per-target inline status (deploy outcome / delete error). Kept across
    // re-renders so the post-deploy refresh doesn't wipe the "Live: url"
    // feedback before the operator reads it.
    const rowStatus = new Map<string, string>();
    // Per-target expandable run history (PR-H). Only one target is expanded
    // at a time; its runs are fetched on demand when the row is toggled.
    let historyFor: string | null = null;
    let historyRuns: readonly DeployRunView[] = [];
    let historyError = '';

    async function refresh(): Promise<void> {
        const [targetsRes, runsRes] = await Promise.all([
            deps.listTargets(),
            deps.listRecentRuns(),
        ]);
        if (!targetsRes.success) {
            root.innerHTML = `<div class="empty-state">Failed to load deploy targets: ${escapeHtml(targetsRes.error)}</div>`;
            return;
        }
        const runs = runsRes.success ? runsRes.data : [];
        renderPanel(targetsRes.data, runs);
    }

    function renderPanel(targets: readonly DeployTargetView[], runs: readonly DeployRunView[]): void {
        // Drop status for targets that no longer exist.
        const liveIds = new Set(targets.map((t) => t.id));
        for (const id of [...rowStatus.keys()]) if (!liveIds.has(id)) rowStatus.delete(id);
        // Drop a stale expansion if its target vanished.
        if (historyFor !== null && !liveIds.has(historyFor)) historyFor = null;
        root.innerHTML = buildPanelHtml(targets, runs, formOpen, projects, environments, rowStatus, {
            targetId: historyFor, runs: historyRuns, error: historyError,
        });
        wireToolbar();
        if (formOpen) wireCreateForm();
        wireRowActions(targets);
    }

    function wireToolbar(): void {
        root.querySelector<HTMLButtonElement>('[data-deploy-add]')?.addEventListener('click', () => {
            void openForm();
        });
    }

    async function openForm(): Promise<void> {
        // Load the project + environment option lists once, lazily, when the
        // operator opens the form — avoids two extra IPC calls on every refresh.
        [projects, environments] = await Promise.all([
            deps.listProjects().catch(() => [] as readonly ProjectOption[]),
            deps.listEnvironments().catch(() => [] as readonly EnvironmentOption[]),
        ]);
        formOpen = true;
        void refresh();
    }

    function wireCreateForm(): void {
        const form = root.querySelector<HTMLFormElement>('[data-deploy-create]');
        root.querySelector<HTMLButtonElement>('[data-deploy-create-cancel]')?.addEventListener('click', () => {
            formOpen = false;
            void refresh();
        });
        if (form === null) return;

        // D-E: re-suggest service type whenever the project changes.
        const projectSel = form.querySelector<HTMLSelectElement>('[name="projectId"]');
        const serviceSel = form.querySelector<HTMLSelectElement>('[name="serviceType"]');
        const hint = form.querySelector<HTMLElement>('[data-deploy-suggest-hint]');
        projectSel?.addEventListener('change', () => {
            const projectId = projectSel.value;
            if (projectId === '' || serviceSel === null) return;
            void deps.suggestServiceType(projectId).then((res) => {
                if (res.success) {
                    serviceSel.value = res.data.serviceType;
                    if (hint !== null) hint.textContent = res.data.reason;
                    toggleAppServiceFields(form, res.data.serviceType);
                }
            });
        });
        serviceSel?.addEventListener('change', () => {
            toggleAppServiceFields(form, serviceSel.value as DeployServiceType);
        });

        form.addEventListener('submit', (ev) => {
            ev.preventDefault();
            const fd = new FormData(form);
            const serviceType = (str(fd, 'serviceType') as DeployServiceType) || 'app-service';
            const projectId = blankToNull(str(fd, 'projectId'));
            const input: DeployTargetCreateInput = {
                environmentId: str(fd, 'environmentId'),
                serviceType,
                appName: str(fd, 'appName'),
                projectId,
                config: buildConfig(fd, serviceType),
            };
            if (input.environmentId === '' || input.appName === '') {
                setFormError(form, 'Environment and App name are required.');
                return;
            }
            if (serviceType === 'app-service' && projectId === null) {
                setFormError(form, 'App Service deploys package a project — pick one.');
                return;
            }
            setFormError(form, '');
            const submit = form.querySelector<HTMLButtonElement>('[type="submit"]');
            if (submit !== null) { submit.disabled = true; submit.textContent = 'Saving…'; }
            void deps.createTarget(input).then((res) => {
                if (res.success) {
                    formOpen = false;
                    void refresh();
                } else {
                    if (submit !== null) { submit.disabled = false; submit.textContent = 'Save target'; }
                    setFormError(form, res.error);
                }
            });
        });
    }

    function wireRowActions(targets: readonly DeployTargetView[]): void {
        root.querySelectorAll<HTMLButtonElement>('[data-deploy-go]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset['deployGo'] ?? '';
                const target = targets.find((t) => t.id === id);
                if (target === undefined) return;
                void runDeploy(target, btn);
            });
        });
        root.querySelectorAll<HTMLButtonElement>('[data-deploy-teardown]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset['deployTeardown'] ?? '';
                const target = targets.find((t) => t.id === id);
                if (target === undefined) return;
                void runTeardown(target, btn);
            });
        });
        root.querySelectorAll<HTMLButtonElement>('[data-deploy-history]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset['deployHistory'] ?? '';
                void toggleHistory(id);
            });
        });
        root.querySelectorAll<HTMLButtonElement>('[data-deploy-delete]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset['deployDelete'] ?? '';
                const target = targets.find((t) => t.id === id);
                if (target === undefined) return;
                if (!confirmFn(`Delete deploy target "${target.appName}"? This removes the record only — tear the Azure resource down first so it isn't orphaned.`)) {
                    return;
                }
                btn.disabled = true;
                void deps.deleteTarget(id).then((res) => {
                    if (res.success) {
                        void refresh();
                    } else {
                        btn.disabled = false;
                        setRowStatus(id, res.error);
                    }
                });
            });
        });
    }

    async function runTeardown(target: DeployTargetView, btn: HTMLButtonElement): Promise<void> {
        if (!confirmFn(`Tear down "${target.appName}"? This deletes the live Azure resource (stops billing). The target record stays so you can redeploy.`)) {
            return;
        }
        btn.disabled = true;
        setRowStatus(target.id, 'Tearing down…');
        const res = await deps.teardown(target.id);
        btn.disabled = false;
        setRowStatus(target.id, res.success ? 'Torn down — Azure resource deleted.' : `Teardown failed: ${res.error}`);
    }

    async function toggleHistory(id: string): Promise<void> {
        if (historyFor === id) {
            historyFor = null;
            historyRuns = [];
            historyError = '';
            void refresh();
            return;
        }
        const res = await deps.listRunsByTarget(id);
        historyFor = id;
        if (res.success) {
            historyRuns = res.data;
            historyError = '';
        } else {
            historyRuns = [];
            historyError = res.error;
        }
        void refresh();
    }

    async function runDeploy(target: DeployTargetView, btn: HTMLButtonElement): Promise<void> {
        let appZipUrl: string | undefined;
        if (target.serviceType === 'static-web-app') {
            const url = promptFn('Static Web Apps deploy from a published zip URL.\nPaste the URL of the built site zip:');
            if (url === null || url.trim() === '') return;
            appZipUrl = url.trim();
        }
        btn.disabled = true;
        setRowStatus(target.id, 'Deploying…');
        const args = appZipUrl !== undefined ? { targetId: target.id, appZipUrl } : { targetId: target.id };
        const res = await deps.trigger(args);
        btn.disabled = false;
        if (!res.success) {
            setRowStatus(target.id, `Failed: ${res.error}`);
            return;
        }
        if (res.data.status === 'live') {
            setRowStatus(target.id, res.data.liveUrl !== null ? `Live: ${res.data.liveUrl}` : 'Live');
        } else {
            setRowStatus(target.id, 'Deploy failed — see history below.');
        }
        // Refresh the recent-runs list to reflect the new run.
        void refresh();
    }

    function setRowStatus(id: string, message: string): void {
        rowStatus.set(id, message);
        const el = root.querySelector<HTMLElement>(`[data-deploy-status="${cssEscape(id)}"]`);
        if (el !== null) el.textContent = message;
    }

    void refresh();

    return {
        refresh,
        destroy: () => { root.innerHTML = ''; },
    };
}

// ── HTML builders ──────────────────────────────────────

interface HistoryState {
    readonly targetId: string | null;
    readonly runs: readonly DeployRunView[];
    readonly error: string;
}

function buildPanelHtml(
    targets: readonly DeployTargetView[],
    runs: readonly DeployRunView[],
    formOpen: boolean,
    projects: readonly ProjectOption[],
    environments: readonly EnvironmentOption[],
    rowStatus: ReadonlyMap<string, string>,
    history: HistoryState
): string {
    const tableHtml = targets.length > 0
        ? buildTableHtml(targets, projects, environments, rowStatus, history)
        : '<div class="empty-state">No deploy targets yet. Add one to deploy a project to Azure.</div>';

    return `
        <div class="deploy-targets-body">
            <header class="deploy-targets-header">
                <div>
                    <h3>Deploy Targets</h3>
                    <p class="deploy-targets-sub">Deploy a finished project to an Azure environment. App Service packages the build; Static Web Apps deploys from a published zip URL.</p>
                </div>
                <button class="btn-sm btn-primary" data-deploy-add ${formOpen ? 'disabled' : ''}>+ New deploy target</button>
            </header>
            ${formOpen ? buildCreateFormHtml(projects, environments) : ''}
            <div class="deployment-table-wrapper">
                ${tableHtml}
            </div>
            ${buildRunsHtml(runs)}
        </div>
    `;
}

function buildCreateFormHtml(
    projects: readonly ProjectOption[],
    environments: readonly EnvironmentOption[]
): string {
    const projectOpts = ['<option value="">— none —</option>']
        .concat(projects.map((p) => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)}</option>`))
        .join('');
    const envOpts = ['<option value="">— select —</option>']
        .concat(environments.map((e) => `<option value="${escapeAttr(e.id)}">${escapeHtml(e.label)}</option>`))
        .join('');
    return `
        <form class="deployment-form-inner deploy-target-create" data-deploy-create>
            <h4 class="deployment-form-title">New deploy target</h4>
            <div class="deployment-form-grid">
                <div class="field-row">
                    <label for="deploy-project">Project</label>
                    <select id="deploy-project" name="projectId">${projectOpts}</select>
                </div>
                <div class="field-row">
                    <label for="deploy-env">Azure environment</label>
                    <select id="deploy-env" name="environmentId">${envOpts}</select>
                </div>
                <div class="field-row">
                    <label for="deploy-service">Service type</label>
                    <select id="deploy-service" name="serviceType">
                        <option value="app-service">App Service (server / Node / API)</option>
                        <option value="static-web-app">Static Web Apps (static site)</option>
                    </select>
                </div>
                <div class="field-row">
                    <label for="deploy-app">App name</label>
                    <input type="text" id="deploy-app" name="appName" placeholder="my-app" autocomplete="off">
                </div>
                <div class="field-row deploy-appservice-field">
                    <label for="deploy-sku">Plan SKU (optional)</label>
                    <input type="text" id="deploy-sku" name="sku" placeholder="B1" autocomplete="off">
                </div>
                <div class="field-row deploy-appservice-field">
                    <label for="deploy-runtime">Runtime (optional)</label>
                    <input type="text" id="deploy-runtime" name="runtime" placeholder="NODE|20-lts" autocomplete="off">
                </div>
            </div>
            <p class="deploy-suggest-hint" data-deploy-suggest-hint>Pick a project to auto-suggest a service type.</p>
            <div class="deployment-form-error hidden" data-deploy-create-error></div>
            <div class="deployment-form-actions">
                <button type="button" class="btn-secondary" data-deploy-create-cancel>Cancel</button>
                <button type="submit" class="btn-primary">Save target</button>
            </div>
        </form>
    `;
}

function buildTableHtml(
    targets: readonly DeployTargetView[],
    projects: readonly ProjectOption[],
    environments: readonly EnvironmentOption[],
    rowStatus: ReadonlyMap<string, string>,
    history: HistoryState
): string {
    const rows = targets.map((t) => {
        const main = buildRowHtml(t, projects, environments, rowStatus.get(t.id) ?? '', history.targetId === t.id);
        return history.targetId === t.id ? main + buildHistoryRowHtml(history) : main;
    }).join('');
    return `
        <table class="data-table deploy-targets-table">
            <thead>
                <tr>
                    <th>App</th>
                    <th>Service</th>
                    <th>Environment</th>
                    <th>Project</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function buildRowHtml(
    target: DeployTargetView,
    projects: readonly ProjectOption[],
    environments: readonly EnvironmentOption[],
    status: string,
    expanded: boolean
): string {
    const envLabel = environments.find((e) => e.id === target.environmentId)?.label ?? truncate(target.environmentId, 12);
    const projectLabel = target.projectId !== null
        ? (projects.find((p) => p.id === target.projectId)?.name ?? truncate(target.projectId, 12))
        : '—';
    const serviceLabel = target.serviceType === 'app-service' ? 'App Service' : 'Static Web Apps';
    return `
        <tr data-deploy-row="${escapeAttr(target.id)}">
            <td class="deploy-app-name">${escapeHtml(target.appName)}</td>
            <td><span class="deploy-service-badge deploy-service-badge--${escapeAttr(target.serviceType)}">${escapeHtml(serviceLabel)}</span></td>
            <td>${escapeHtml(envLabel)}</td>
            <td>${escapeHtml(projectLabel)}</td>
            <td class="deploy-row-actions">
                <button class="btn-sm btn-primary" data-deploy-go="${escapeAttr(target.id)}" title="Deploy now">Deploy</button>
                <button class="btn-sm" data-deploy-history="${escapeAttr(target.id)}" title="Deploy history" aria-expanded="${expanded ? 'true' : 'false'}">${expanded ? 'Hide' : 'History'}</button>
                <button class="btn-sm btn-warn" data-deploy-teardown="${escapeAttr(target.id)}" title="Tear down the live Azure resource">Teardown</button>
                <button class="btn-sm btn-danger" data-deploy-delete="${escapeAttr(target.id)}" title="Delete record">×</button>
                <span class="deploy-row-status" data-deploy-status="${escapeAttr(target.id)}">${escapeHtml(status)}</span>
            </td>
        </tr>
    `;
}

function buildHistoryRowHtml(history: HistoryState): string {
    let inner: string;
    if (history.error !== '') {
        inner = `<div class="deploy-history-error">Failed to load history: ${escapeHtml(history.error)}</div>`;
    } else if (history.runs.length === 0) {
        inner = '<div class="deploy-history-empty">No deploys yet for this target.</div>';
    } else {
        const items = history.runs.map((r) => {
            const detail = r.status === 'live' && r.liveUrl !== null
                ? `<a href="${escapeAttr(r.liveUrl)}" target="_blank" rel="noreferrer">${escapeHtml(r.liveUrl)}</a>`
                : r.status === 'failed' && r.errorMessage !== null
                    ? `<span class="deploy-run-error">${escapeHtml(r.errorMessage)}</span>`
                    : '';
            const finished = r.finishedAt !== null ? escapeHtml(formatTime(r.finishedAt)) : '—';
            return `
                <li class="deploy-run-item">
                    <span class="deploy-run-badge deploy-run-badge--${escapeAttr(r.status)}">${escapeHtml(r.status)}</span>
                    <span class="deploy-run-time">${escapeHtml(formatTime(r.startedAt))} → ${finished}</span>
                    <span class="deploy-run-detail">${detail}</span>
                </li>
            `;
        }).join('');
        inner = `<ul class="deploy-runs-list">${items}</ul>`;
    }
    return `
        <tr class="deploy-history-row">
            <td colspan="5">
                <div class="deploy-history">
                    <h5 class="deploy-history-title">Deploy history</h5>
                    ${inner}
                </div>
            </td>
        </tr>
    `;
}

function buildRunsHtml(runs: readonly DeployRunView[]): string {
    if (runs.length === 0) return '';
    const items = runs.slice(0, 8).map((r) => {
        const detail = r.status === 'live' && r.liveUrl !== null
            ? `<a href="${escapeAttr(r.liveUrl)}" target="_blank" rel="noreferrer">${escapeHtml(r.liveUrl)}</a>`
            : r.status === 'failed' && r.errorMessage !== null
                ? `<span class="deploy-run-error">${escapeHtml(r.errorMessage)}</span>`
                : '';
        return `
            <li class="deploy-run-item">
                <span class="deploy-run-badge deploy-run-badge--${escapeAttr(r.status)}">${escapeHtml(r.status)}</span>
                <span class="deploy-run-time">${escapeHtml(formatTime(r.startedAt))}</span>
                <span class="deploy-run-detail">${detail}</span>
            </li>
        `;
    }).join('');
    return `
        <div class="deploy-runs">
            <h4 class="deploy-runs-title">Recent deploys</h4>
            <ul class="deploy-runs-list">${items}</ul>
        </div>
    `;
}

// ── Helpers ────────────────────────────────────────────

function toggleAppServiceFields(form: HTMLElement, serviceType: DeployServiceType): void {
    const show = serviceType === 'app-service';
    form.querySelectorAll<HTMLElement>('.deploy-appservice-field').forEach((el) => {
        el.classList.toggle('hidden', !show);
    });
}

function buildConfig(fd: FormData, serviceType: DeployServiceType): { sku?: string; runtime?: string } {
    if (serviceType !== 'app-service') return {};
    const config: { sku?: string; runtime?: string } = {};
    const sku = str(fd, 'sku');
    const runtime = str(fd, 'runtime');
    if (sku !== '') config.sku = sku;
    if (runtime !== '') config.runtime = runtime;
    return config;
}

function str(fd: FormData, key: string): string {
    return String(fd.get(key) ?? '').trim();
}

function blankToNull(value: string): string | null {
    return value.length > 0 ? value : null;
}

function setFormError(form: HTMLElement, message: string): void {
    const el = form.querySelector<HTMLElement>('[data-deploy-create-error]');
    if (el === null) return;
    el.textContent = message;
    el.classList.toggle('hidden', message === '');
}

function formatTime(iso: string): string {
    // Keep it simple + deterministic for tests: trim to minutes.
    return iso.length >= 16 ? iso.slice(0, 16).replace('T', ' ') : iso;
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
