/**
 * Pillar 2.5 / PR-G — deploy-targets-panel renderer tests.
 *
 * DOM-driven against the panel's pure `renderDeployTargetsPanel(root, deps)`
 * seam — every IPC call is mockable; `confirm` + `promptZipUrl` are injected
 * so deletes and SWA deploys are deterministic without browser dialogs.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
    renderDeployTargetsPanel,
    type DeployTargetsPanelDeps,
    type DeployTargetView,
    type DeployRunView,
} from '../../src/renderer/command-center/deploy-targets-panel';

// ── Fixtures ───────────────────────────────────────────

function targetView(overrides?: Partial<DeployTargetView>): DeployTargetView {
    return {
        id: 'tgt-1',
        environmentId: 'env-1',
        projectId: 'proj-1',
        serviceType: 'app-service',
        appName: 'myapp',
        config: { sku: 'B1' },
        createdAt: '2026-06-07T00:00:00Z',
        updatedAt: '2026-06-07T00:00:00Z',
        ...overrides,
    };
}

function runView(overrides?: Partial<DeployRunView>): DeployRunView {
    return {
        id: 'run-1',
        targetId: 'tgt-1',
        projectId: 'proj-1',
        status: 'live',
        liveUrl: 'https://myapp.azurewebsites.net',
        errorMessage: null,
        startedAt: '2026-06-07T01:02:03Z',
        finishedAt: '2026-06-07T01:05:00Z',
        ...overrides,
    };
}

interface State {
    create: Array<Record<string, unknown>>;
    trigger: Array<{ targetId: string; appZipUrl?: string }>;
    delete: string[];
    teardown: string[];
}

function buildDeps(opts?: {
    targets?: readonly DeployTargetView[];
    runs?: readonly DeployRunView[];
    listFails?: boolean;
    createSuccess?: boolean;
    createError?: string;
    triggerSuccess?: boolean;
    triggerStatus?: 'live' | 'failed';
    teardownSuccess?: boolean;
    historyRuns?: readonly DeployRunView[];
    historyFails?: boolean;
    confirmResult?: boolean;
    promptResult?: string | null;
    suggest?: { serviceType: 'app-service' | 'static-web-app'; reason: string };
}): { deps: DeployTargetsPanelDeps; state: State } {
    const state: State = { create: [], trigger: [], delete: [], teardown: [] };
    let targets = [...(opts?.targets ?? [targetView()])];
    const deps: DeployTargetsPanelDeps = {
        listTargets: vi.fn(async () => {
            if (opts?.listFails) return { success: false as const, error: 'boom' };
            return { success: true as const, data: targets };
        }),
        createTarget: vi.fn(async (input) => {
            state.create.push(input as unknown as Record<string, unknown>);
            if (opts?.createSuccess === false) return { success: false as const, error: opts.createError ?? 'create failed' };
            const created = targetView({ id: `tgt-${state.create.length + 1}`, appName: input.appName, serviceType: input.serviceType });
            targets = [...targets, created];
            return { success: true as const, data: created };
        }),
        deleteTarget: vi.fn(async (id) => {
            state.delete.push(id);
            targets = targets.filter((t) => t.id !== id);
            return { success: true as const };
        }),
        trigger: vi.fn(async (args) => {
            state.trigger.push(args);
            if (opts?.triggerSuccess === false) return { success: false as const, error: 'deploy failed' };
            return {
                success: true as const,
                data: { runId: 'run-x', status: opts?.triggerStatus ?? 'live', liveUrl: 'https://x.net', resourceId: '/sites/x' },
            };
        }),
        teardown: vi.fn(async (id) => {
            state.teardown.push(id);
            if (opts?.teardownSuccess === false) return { success: false as const, error: 'teardown failed' };
            return { success: true as const, data: { targetId: id, appName: 'myapp' } };
        }),
        suggestServiceType: vi.fn(async () => ({
            success: true as const,
            data: opts?.suggest ?? { serviceType: 'static-web-app' as const, reason: 'looks static' },
        })),
        listRecentRuns: vi.fn(async () => ({ success: true as const, data: opts?.runs ?? [] })),
        listRunsByTarget: vi.fn(async () => {
            if (opts?.historyFails) return { success: false as const, error: 'history boom' };
            return { success: true as const, data: opts?.historyRuns ?? [] };
        }),
        listProjects: vi.fn(async () => [{ id: 'proj-1', name: 'GreenThumb' }]),
        listEnvironments: vi.fn(async () => [{ id: 'env-1', label: 'Production AU' }]),
        confirm: vi.fn(() => opts?.confirmResult ?? true),
        promptZipUrl: vi.fn(() => (opts?.promptResult === undefined ? 'https://blob/a.zip' : opts.promptResult)),
    };
    return { deps, state };
}

function mount(): HTMLElement {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return root;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    document.body.innerHTML = '';
});

// ── Tests ──────────────────────────────────────────────

describe('renderDeployTargetsPanel', () => {
    it('renders a row per target', async () => {
        const root = mount();
        const { deps } = buildDeps({ targets: [targetView(), targetView({ id: 'tgt-2', appName: 'site', serviceType: 'static-web-app' })] });
        renderDeployTargetsPanel(root, deps);
        await tick();
        expect(root.querySelectorAll('[data-deploy-row]')).toHaveLength(2);
        expect(root.textContent).toContain('myapp');
        expect(root.textContent).toContain('site');
    });

    it('shows an empty state when there are no targets', async () => {
        const root = mount();
        const { deps } = buildDeps({ targets: [] });
        renderDeployTargetsPanel(root, deps);
        await tick();
        expect(root.querySelector('.empty-state')?.textContent).toContain('No deploy targets');
    });

    it('shows a load error when listTargets fails', async () => {
        const root = mount();
        const { deps } = buildDeps({ listFails: true });
        renderDeployTargetsPanel(root, deps);
        await tick();
        expect(root.textContent).toContain('Failed to load deploy targets');
    });

    it('resolves env + project labels in the row', async () => {
        const root = mount();
        const { deps } = buildDeps();
        renderDeployTargetsPanel(root, deps);
        await tick();
        // Labels populate after the form is opened (option lists load lazily),
        // but the table always renders the id-fallback otherwise. Open form to load.
        root.querySelector<HTMLButtonElement>('[data-deploy-add]')?.click();
        await tick();
        await tick();
        expect(root.textContent).toContain('Production AU');
        expect(root.textContent).toContain('GreenThumb');
    });

    it('opens the create form and auto-suggests a service type on project change', async () => {
        const root = mount();
        const { deps } = buildDeps({ suggest: { serviceType: 'static-web-app', reason: 'looks static' } });
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-add]')?.click();
        await tick();
        await tick();
        const projectSel = root.querySelector<HTMLSelectElement>('[name="projectId"]');
        const serviceSel = root.querySelector<HTMLSelectElement>('[name="serviceType"]');
        expect(projectSel).not.toBeNull();
        projectSel!.value = 'proj-1';
        projectSel!.dispatchEvent(new Event('change'));
        await tick();
        expect(deps.suggestServiceType).toHaveBeenCalledWith('proj-1');
        expect(serviceSel!.value).toBe('static-web-app');
        expect(root.textContent).toContain('looks static');
    });

    it('creates an app-service target with a project', async () => {
        const root = mount();
        const { deps, state } = buildDeps({ targets: [] });
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-add]')?.click();
        await tick();
        await tick();
        const form = root.querySelector<HTMLFormElement>('[data-deploy-create]')!;
        (form.querySelector('[name="projectId"]') as HTMLSelectElement).value = 'proj-1';
        (form.querySelector('[name="environmentId"]') as HTMLSelectElement).value = 'env-1';
        (form.querySelector('[name="serviceType"]') as HTMLSelectElement).value = 'app-service';
        (form.querySelector('[name="appName"]') as HTMLInputElement).value = 'newapp';
        form.requestSubmit();
        await tick();
        await tick();
        expect(state.create).toHaveLength(1);
        expect(state.create[0]).toMatchObject({ appName: 'newapp', serviceType: 'app-service', projectId: 'proj-1', environmentId: 'env-1' });
    });

    it('blocks an app-service create with no project', async () => {
        const root = mount();
        const { deps, state } = buildDeps({ targets: [] });
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-add]')?.click();
        await tick();
        await tick();
        const form = root.querySelector<HTMLFormElement>('[data-deploy-create]')!;
        (form.querySelector('[name="environmentId"]') as HTMLSelectElement).value = 'env-1';
        (form.querySelector('[name="appName"]') as HTMLInputElement).value = 'newapp';
        form.requestSubmit();
        await tick();
        expect(state.create).toHaveLength(0);
        expect(root.querySelector('[data-deploy-create-error]')?.textContent).toMatch(/pick one/i);
    });

    it('deploys an app-service target without prompting', async () => {
        const root = mount();
        const { deps, state } = buildDeps();
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-go]')?.click();
        await tick();
        await tick();
        expect(state.trigger).toEqual([{ targetId: 'tgt-1' }]);
        expect(deps.promptZipUrl).not.toHaveBeenCalled();
        expect(root.querySelector('[data-deploy-status]')?.textContent).toContain('Live');
    });

    it('prompts for a zip URL when deploying a static web app', async () => {
        const root = mount();
        const { deps, state } = buildDeps({ targets: [targetView({ serviceType: 'static-web-app', config: {} })], promptResult: 'https://blob/site.zip' });
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-go]')?.click();
        await tick();
        await tick();
        expect(deps.promptZipUrl).toHaveBeenCalled();
        expect(state.trigger).toEqual([{ targetId: 'tgt-1', appZipUrl: 'https://blob/site.zip' }]);
    });

    it('cancels a static web app deploy when the prompt is dismissed', async () => {
        const root = mount();
        const { deps, state } = buildDeps({ targets: [targetView({ serviceType: 'static-web-app', config: {} })], promptResult: null });
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-go]')?.click();
        await tick();
        expect(state.trigger).toHaveLength(0);
    });

    it('deletes a target after confirm', async () => {
        const root = mount();
        const { deps, state } = buildDeps({ confirmResult: true });
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-delete]')?.click();
        await tick();
        await tick();
        expect(state.delete).toEqual(['tgt-1']);
    });

    it('does not delete when confirm is declined', async () => {
        const root = mount();
        const { deps, state } = buildDeps({ confirmResult: false });
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-delete]')?.click();
        await tick();
        expect(state.delete).toHaveLength(0);
    });

    it('renders a recent-runs list with the live URL', async () => {
        const root = mount();
        const { deps } = buildDeps({ runs: [runView()] });
        renderDeployTargetsPanel(root, deps);
        await tick();
        expect(root.querySelector('.deploy-runs')).not.toBeNull();
        expect(root.textContent).toContain('https://myapp.azurewebsites.net');
    });

    // ── PR-H: teardown + history ──

    it('tears down after confirm and reports success', async () => {
        const root = mount();
        const { deps, state } = buildDeps({ confirmResult: true });
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-teardown]')?.click();
        await tick();
        await tick();
        expect(state.teardown).toEqual(['tgt-1']);
        expect(root.querySelector('[data-deploy-status]')?.textContent).toMatch(/torn down/i);
    });

    it('does not tear down when confirm is declined', async () => {
        const root = mount();
        const { deps, state } = buildDeps({ confirmResult: false });
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-teardown]')?.click();
        await tick();
        expect(state.teardown).toHaveLength(0);
    });

    it('surfaces a teardown failure in the row status', async () => {
        const root = mount();
        const { deps } = buildDeps({ confirmResult: true, teardownSuccess: false });
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-teardown]')?.click();
        await tick();
        await tick();
        expect(root.querySelector('[data-deploy-status]')?.textContent).toMatch(/teardown failed/i);
    });

    it('expands per-target history on toggle and collapses again', async () => {
        const root = mount();
        const { deps } = buildDeps({ historyRuns: [runView({ id: 'run-h', status: 'failed', liveUrl: null, errorMessage: 'kudu 409' })] });
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-history]')?.click();
        await tick();
        await tick();
        expect(deps.listRunsByTarget).toHaveBeenCalledWith('tgt-1');
        expect(root.querySelector('.deploy-history-row')).not.toBeNull();
        expect(root.textContent).toContain('kudu 409');
        // Toggle again → collapses.
        root.querySelector<HTMLButtonElement>('[data-deploy-history]')?.click();
        await tick();
        await tick();
        expect(root.querySelector('.deploy-history-row')).toBeNull();
    });

    it('shows an empty history message when a target has no runs', async () => {
        const root = mount();
        const { deps } = buildDeps({ historyRuns: [] });
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-history]')?.click();
        await tick();
        await tick();
        expect(root.querySelector('.deploy-history-empty')).not.toBeNull();
    });

    it('shows a history load error', async () => {
        const root = mount();
        const { deps } = buildDeps({ historyFails: true });
        renderDeployTargetsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-deploy-history]')?.click();
        await tick();
        await tick();
        expect(root.querySelector('.deploy-history-error')?.textContent).toContain('history boom');
    });
});
