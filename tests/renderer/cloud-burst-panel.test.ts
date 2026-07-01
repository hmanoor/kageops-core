/**
 * Pillar 2.4 / PR-F.next + PR-G.next — cloud-burst-panel renderer tests.
 *
 * DOM-driven tests against the panel's pure rendering + deps surface.
 * `renderCloudBurstPanel(root, deps)` is the public seam — every IPC
 * call is mockable, including the polling interval.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
    renderCloudBurstPanel,
    defaultCloudBurstPanelDeps,
    type CloudBurstPanelDeps,
    type BurstPoolView,
    type BurstTaskView,
} from '../../src/renderer/command-center/cloud-burst-panel';

// ── Fixtures ───────────────────────────────────────────

function pool(overrides?: Partial<BurstPoolView>): BurstPoolView {
    return {
        id: 'pool-1',
        name: 'default',
        subscriptionId: '11111111-1111-1111-1111-111111111111',
        resourceGroup: 'kageops-prod',
        containerRegistry: 'kageopsacr.azurecr.io',
        defaultRegion: 'australiaeast',
        budgetCapUsd: 5,
        enabled: true,
        createdAt: '2026-06-02T00:00:00Z',
        updatedAt: '2026-06-02T00:00:00Z',
        ...overrides,
    };
}

function burst(overrides?: Partial<BurstTaskView>): BurstTaskView {
    return {
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        taskId: 'task-1',
        projectId: 'proj-1',
        poolId: 'pool-1',
        agentRole: 'forge',
        containerId: '/subscriptions/x/containerGroups/kageops-burst-a1b2c3d4',
        region: 'australiaeast',
        status: 'running',
        costUsd: 0.05,
        requestedAt: '2026-06-02T00:00:00Z',
        startedAt: '2026-06-02T00:01:00Z',
        completedAt: null,
        lastHeartbeatAt: '2026-06-02T00:02:00Z',
        errorMessage: null,
        ...overrides,
    };
}

interface CallState {
    listPools: number;
    listActive: number;
    createPool: Array<Record<string, unknown>>;
    updatePool: Array<{ id: string; patch: Record<string, unknown> }>;
    deletePool: string[];
    stop: string[];
    stopAll: number;
    dispatch: Array<Record<string, unknown>>;
}

function buildDeps(opts?: {
    pools?: readonly BurstPoolView[];
    bursts?: readonly BurstTaskView[];
    createSuccess?: boolean;
    updateSuccess?: boolean;
    deleteSuccess?: boolean;
    stopSuccess?: boolean;
    stopAllResult?: { stopped: number; failed: number; errors: readonly string[] };
    withDispatch?: boolean;
    dispatchError?: { error: string; errorKind?: string };
    recentBursts?: readonly BurstTaskView[];
}): { deps: CloudBurstPanelDeps; state: CallState } {
    const state: CallState = {
        listPools: 0,
        listActive: 0,
        createPool: [],
        updatePool: [],
        deletePool: [],
        stop: [],
        stopAll: 0,
        dispatch: [],
    };

    const deps: CloudBurstPanelDeps = {
        listPools: vi.fn(async () => {
            state.listPools += 1;
            return { success: true as const, data: opts?.pools ?? [] };
        }),
        createPool: vi.fn(async (input) => {
            state.createPool.push(input as Record<string, unknown>);
            if (opts?.createSuccess === false) {
                return { success: false as const, error: 'create failed' };
            }
            return { success: true as const, data: pool({ name: input.name }) };
        }),
        updatePool: vi.fn(async (id, patch) => {
            state.updatePool.push({ id, patch: patch as Record<string, unknown> });
            if (opts?.updateSuccess === false) {
                return { success: false as const, error: 'update failed' };
            }
            return { success: true as const, data: pool({ id, ...(patch as Partial<BurstPoolView>) }) };
        }),
        deletePool: vi.fn(async (id) => {
            state.deletePool.push(id);
            return opts?.deleteSuccess === false
                ? { success: false as const, error: 'delete failed' }
                : { success: true as const };
        }),
        listActiveBursts: vi.fn(async () => {
            state.listActive += 1;
            return { success: true as const, bursts: opts?.bursts ?? [] };
        }),
        stopBurst: vi.fn(async (burstId) => {
            state.stop.push(burstId);
            return opts?.stopSuccess === false
                ? { success: false as const, error: 'stop failed' }
                : { success: true as const };
        }),
        stopAllBursts: vi.fn(async () => {
            state.stopAll += 1;
            return {
                success: true as const,
                stopped: opts?.stopAllResult?.stopped ?? 0,
                failed: opts?.stopAllResult?.failed ?? 0,
                errors: opts?.stopAllResult?.errors ?? [],
            };
        }),
        pollIntervalMs: 0,
        setInterval: vi.fn(() => 'fake-handle'),
        clearInterval: vi.fn(),
        ...(opts?.recentBursts !== undefined
            ? { listRecentBursts: vi.fn(async () => ({ success: true as const, bursts: opts.recentBursts ?? [] })) }
            : {}),
        ...(opts?.withDispatch === true
            ? {
                dispatchBurst: vi.fn(async (input: Record<string, unknown>) => {
                    state.dispatch.push(input);
                    if (opts.dispatchError !== undefined) {
                        return { success: false as const, error: opts.dispatchError.error, ...(opts.dispatchError.errorKind !== undefined ? { errorKind: opts.dispatchError.errorKind } : {}) };
                    }
                    return {
                        success: true as const,
                        burstId: 'burst-new',
                        containerId: '/subscriptions/x/containerGroups/agent-burstne',
                        containerGroupName: 'agent-burstne',
                        poolId: String(input['poolId'] ?? ''),
                        poolName: 'default',
                    };
                }),
            }
            : {}),
    };
    return { deps, state };
}

function makeRoot(): HTMLElement {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    return root;
}

async function flushPromises(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
    }
}

// ── Setup ───────────────────────────────────────────────

beforeEach(() => {
    // jsdom doesn't ship a window.confirm by default; stub for the
    // deletes + stop-all confirmation paths.
    Object.defineProperty(window, 'confirm', {
        configurable: true,
        value: vi.fn(() => true),
    });
});

// ── Rendering ───────────────────────────────────────────

describe('renderCloudBurstPanel — initial render', () => {
    it('shows the create form when no pool is configured', async () => {
        const root = makeRoot();
        const { deps } = buildDeps();
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        expect(root.querySelector('[data-cb-pool-create]')).not.toBeNull();
        expect(root.querySelector('[data-cb-pool-update]')).toBeNull();
    });

    it('shows the edit card when a pool exists', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({ pools: [pool()] });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        expect(root.querySelector('[data-cb-pool-update]')).not.toBeNull();
        expect(root.querySelector('[data-cb-pool-create]')).toBeNull();
        const subtitle = root.querySelector('.cb-pool-card__sub')?.textContent ?? '';
        expect(subtitle).toContain('kageops-prod');
    });

    it('renders the empty active table when no bursts are running', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({ pools: [pool()] });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        const activeBody = root.querySelector('[data-cb-active-body]');
        expect(activeBody?.textContent).toContain('No active bursts');
        const stopAllBtn = root.querySelector<HTMLButtonElement>('[data-cb-stop-all]');
        expect(stopAllBtn?.disabled).toBe(true);
    });

    it('renders one row per active burst with a stop button', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({ pools: [pool()], bursts: [burst(), burst({ id: 'a1b2c3d4-1111-2222-3333-444455556666', agentRole: 'vigil' })] });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        const rows = root.querySelectorAll('[data-cb-burst-row]');
        expect(rows.length).toBe(2);
        const stopButtons = root.querySelectorAll('[data-cb-stop-id]');
        expect(stopButtons.length).toBe(2);
    });

    it('separates terminal bursts into the history section', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({
            pools: [pool()],
            bursts: [
                burst(),
                burst({ id: 'b2c3d4e5-7890-abcd-ef12-345678900000', status: 'completed', completedAt: '2026-06-02T00:05:00Z' }),
                burst({ id: 'c3d4e5f6-7890-abcd-ef12-345678900000', status: 'failed', errorMessage: 'OOM kill', completedAt: '2026-06-02T00:06:00Z' }),
            ],
        });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        const activeRows = root.querySelectorAll('[data-cb-burst-row]');
        expect(activeRows.length).toBe(1);
        const history = root.querySelector('.cb-section--history')?.textContent ?? '';
        expect(history).toContain('completed');
        expect(history).toContain('failed');
        expect(history).toContain('OOM kill');
    });

    it('shows summary chip with active count + total cost', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({
            pools: [pool()],
            bursts: [burst({ costUsd: 0.04 }), burst({ id: 'b2c3d4e5-aaaa-bbbb-cccc-dddddddddddd', costUsd: 0.06 })],
        });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        const count = root.querySelector('[data-cb-active-count]')?.textContent;
        const cost = root.querySelector('[data-cb-total-cost]')?.textContent;
        expect(count).toBe('2');
        expect(cost).toBe('0.10');
    });
});

// ── Pool actions ───────────────────────────────────────

describe('renderCloudBurstPanel — pool form actions', () => {
    it('submits create form to deps.createPool', async () => {
        const root = makeRoot();
        const { deps, state } = buildDeps();
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        const form = root.querySelector<HTMLFormElement>('[data-cb-pool-create]');
        expect(form).not.toBeNull();
        if (form === null) return;
        (form.elements.namedItem('name') as HTMLInputElement).value = 'production';
        (form.elements.namedItem('subscriptionId') as HTMLInputElement).value = 'sub-1';
        (form.elements.namedItem('resourceGroup') as HTMLInputElement).value = 'rg-1';
        (form.elements.namedItem('containerRegistry') as HTMLInputElement).value = 'acr.azurecr.io';
        (form.elements.namedItem('defaultRegion') as HTMLInputElement).value = 'eastus';
        (form.elements.namedItem('budgetCapUsd') as HTMLInputElement).value = '10';

        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await flushPromises();

        expect(state.createPool.length).toBe(1);
        expect(state.createPool[0]).toMatchObject({
            name: 'production',
            subscriptionId: 'sub-1',
            resourceGroup: 'rg-1',
            containerRegistry: 'acr.azurecr.io',
            defaultRegion: 'eastus',
            budgetCapUsd: 10,
        });
    });

    it('shows error status when create fails', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({ createSuccess: false });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        const form = root.querySelector<HTMLFormElement>('[data-cb-pool-create]');
        if (form === null) throw new Error('form not found');
        (form.elements.namedItem('name') as HTMLInputElement).value = 'x';
        (form.elements.namedItem('subscriptionId') as HTMLInputElement).value = 'x';
        (form.elements.namedItem('resourceGroup') as HTMLInputElement).value = 'x';
        (form.elements.namedItem('containerRegistry') as HTMLInputElement).value = 'x';
        (form.elements.namedItem('defaultRegion') as HTMLInputElement).value = 'x';
        (form.elements.namedItem('budgetCapUsd') as HTMLInputElement).value = '1';
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await flushPromises();

        const status = root.querySelector('[data-cb-pool-status]')?.textContent ?? '';
        expect(status).toContain('Create failed');
    });

    it('updates an existing pool via the patch form', async () => {
        const root = makeRoot();
        const { deps, state } = buildDeps({ pools: [pool()] });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        const form = root.querySelector<HTMLFormElement>('[data-cb-pool-update]');
        if (form === null) throw new Error('update form missing');
        (form.elements.namedItem('budgetCapUsd') as HTMLInputElement).value = '25';
        (form.elements.namedItem('defaultRegion') as HTMLInputElement).value = 'eu-west';
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await flushPromises();

        expect(state.updatePool.length).toBe(1);
        const patch = state.updatePool[0].patch as Record<string, unknown>;
        expect(patch.budgetCapUsd).toBe(25);
        expect(patch.defaultRegion).toBe('eu-west');
    });

    it('toggles enabled via checkbox', async () => {
        const root = makeRoot();
        const { deps, state } = buildDeps({ pools: [pool({ enabled: true })] });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        const toggle = root.querySelector<HTMLInputElement>('[data-cb-toggle-enabled]');
        if (toggle === null) throw new Error('toggle missing');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        await flushPromises();

        const lastPatch = state.updatePool[state.updatePool.length - 1]?.patch as Record<string, unknown> | undefined;
        expect(lastPatch?.enabled).toBe(false);
    });

    it('deletes a pool when confirmed', async () => {
        const root = makeRoot();
        const { deps, state } = buildDeps({ pools: [pool()] });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        const deleteBtn = root.querySelector<HTMLButtonElement>('[data-cb-pool-delete]');
        if (deleteBtn === null) throw new Error('delete button missing');
        deleteBtn.click();
        await flushPromises();

        expect(state.deletePool).toEqual(['pool-1']);
    });

    it('does NOT delete when confirm is dismissed', async () => {
        Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => false) });
        const root = makeRoot();
        const { deps, state } = buildDeps({ pools: [pool()] });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        root.querySelector<HTMLButtonElement>('[data-cb-pool-delete]')?.click();
        await flushPromises();

        expect(state.deletePool.length).toBe(0);
    });
});

// ── Burst actions ──────────────────────────────────────

describe('renderCloudBurstPanel — burst actions', () => {
    it('clicking Stop on a row invokes deps.stopBurst with the row id', async () => {
        const root = makeRoot();
        const { deps, state } = buildDeps({ pools: [pool()], bursts: [burst()] });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        const stopBtn = root.querySelector<HTMLButtonElement>('[data-cb-stop-id]');
        if (stopBtn === null) throw new Error('stop button missing');
        stopBtn.click();
        await flushPromises();

        expect(state.stop).toEqual([burst().id]);
    });

    it('Stop all routes to deps.stopAllBursts when confirmed', async () => {
        const root = makeRoot();
        const { deps, state } = buildDeps({
            pools: [pool()],
            bursts: [burst()],
            stopAllResult: { stopped: 1, failed: 0, errors: [] },
        });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        const stopAllBtn = root.querySelector<HTMLButtonElement>('[data-cb-stop-all]');
        if (stopAllBtn === null) throw new Error('stop-all button missing');
        stopAllBtn.click();
        await flushPromises();

        expect(state.stopAll).toBe(1);
    });

    it('Stop all surfaces partial-failure error message', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({
            pools: [pool()],
            bursts: [burst()],
            stopAllResult: { stopped: 1, failed: 1, errors: ['burst-2: Azure 500'] },
        });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        root.querySelector<HTMLButtonElement>('[data-cb-stop-all]')?.click();
        await flushPromises();

        const status = root.querySelector('[data-cb-active-status]')?.textContent ?? '';
        expect(status).toContain('Azure 500');
    });
});

// ── Lifecycle ──────────────────────────────────────────

describe('renderCloudBurstPanel — lifecycle', () => {
    it('handle.destroy clears the polling interval + DOM', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({ pools: [pool()] });
        deps.pollIntervalMs = 5000;
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();
        handle.destroy();
        expect(root.innerHTML).toBe('');
        expect((deps.setInterval as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
        expect((deps.clearInterval as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });

    it('repeated refresh calls re-render without leaking DOM', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({ pools: [pool()] });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();
        await handle.refresh();
        await handle.refresh();

        // Three refreshes, but only ONE create form (the single pool render).
        expect(root.querySelectorAll('[data-cb-pool-update]').length).toBe(1);
    });
});

// ── Error envelopes ────────────────────────────────────

describe('renderCloudBurstPanel — error envelopes', () => {
    it('shows the error message when listPools fails', async () => {
        const root = makeRoot();
        const { deps } = buildDeps();
        deps.listPools = vi.fn(async () => ({ success: false as const, error: 'DB down', kind: 'unknown' }));
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        const poolBody = root.querySelector('[data-cb-pool-body]')?.textContent ?? '';
        expect(poolBody).toContain('DB down');
    });

    it('shows the error message when listActiveBursts fails', async () => {
        const root = makeRoot();
        const { deps } = buildDeps();
        deps.listActiveBursts = vi.fn(async () => ({ success: false as const, error: 'bus offline' }));
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        const activeBody = root.querySelector('[data-cb-active-body]')?.textContent ?? '';
        expect(activeBody).toContain('bus offline');
    });
});

// ── Security ───────────────────────────────────────────

describe('renderCloudBurstPanel — escaping', () => {
    it('escapes HTML in pool fields (prevents XSS via subscription id)', async () => {
        const root = makeRoot();
        const malicious = '<img src=x onerror="alert(1)">';
        const { deps } = buildDeps({
            pools: [pool({ subscriptionId: malicious })],
        });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        // The malicious string should appear as text, never as a parsed img tag.
        expect(root.querySelector('img')).toBeNull();
        const subtitle = root.querySelector('.cb-pool-card__sub')?.textContent ?? '';
        expect(subtitle).toContain('<img');
    });

    it('escapes HTML in burst error messages', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({
            pools: [pool()],
            bursts: [burst({ status: 'failed', errorMessage: '<script>alert(1)</script>', completedAt: '2026-06-02T00:05:00Z' })],
        });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();

        expect(root.querySelector('script')).toBeNull();
        const history = root.querySelector('.cb-section--history')?.textContent ?? '';
        expect(history).toContain('<script>');
    });
});

// ── Preload bridge wiring (regression: the panel must read the SAME
// global the command-center preload exposes — `window.kageOps`, NOT
// `window.kageops`. A casing mismatch shipped the panel as a blank
// "preload bridge missing" screen in packaged builds because the 21
// DOM tests above inject fake deps and never touch the real lookup.) ──
describe('defaultCloudBurstPanelDeps — preload bridge lookup', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function fakeBridge() {
        return {
            cloudBurst: {
                listActive: vi.fn(),
                listForProject: vi.fn(),
                stop: vi.fn(),
                stopAll: vi.fn(),
                dispatch: vi.fn(),
            },
            burstPool: {
                list: vi.fn(),
                get: vi.fn(),
                create: vi.fn(),
                update: vi.fn(),
                delete: vi.fn(),
            },
        };
    }

    it('resolves deps from window.kageOps (capital O — matches the preload global)', () => {
        const bridge = fakeBridge();
        vi.stubGlobal('kageOps', bridge);

        const deps = defaultCloudBurstPanelDeps();
        deps.listPools();
        deps.listActiveBursts();
        deps.stopAllBursts();

        expect(bridge.burstPool.list).toHaveBeenCalledTimes(1);
        expect(bridge.cloudBurst.listActive).toHaveBeenCalledTimes(1);
        expect(bridge.cloudBurst.stopAll).toHaveBeenCalledTimes(1);
    });

    it('throws a clear error when the bridge is absent', () => {
        vi.stubGlobal('kageOps', undefined);
        expect(() => defaultCloudBurstPanelDeps()).toThrow(/window\.kageOps preload bridge missing/);
    });

    it('does NOT read the wrong-cased window.kageops global', () => {
        // Only the lowercase global is present — the real bug. Must throw,
        // proving the panel reads the correct capital-O global.
        vi.stubGlobal('kageops', fakeBridge());
        vi.stubGlobal('kageOps', undefined);
        expect(() => defaultCloudBurstPanelDeps()).toThrow(/preload bridge missing/);
    });
});

// ── Dispatch section (PR-E.2b UI trigger) ───────────────

describe('renderCloudBurstPanel — dispatch section', () => {
    function fillAndSubmit(root: HTMLElement, vals: Partial<Record<string, string>>): void {
        const form = root.querySelector<HTMLFormElement>('[data-cb-dispatch-form]');
        if (form === null) throw new Error('dispatch form missing');
        for (const [name, value] of Object.entries(vals)) {
            const input = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
            if (input !== null) input.value = value ?? '';
        }
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }

    it('is omitted when deps.dispatchBurst is not provided', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({ pools: [pool()] }); // no withDispatch
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();
        await flushPromises();
        expect(root.querySelector('[data-cb-dispatch-form]')).toBeNull();
    });

    it('renders the dispatch form when dispatchBurst is provided', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({ pools: [pool()], withDispatch: true });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();
        await flushPromises();
        expect(root.querySelector('[data-cb-dispatch-form]')).not.toBeNull();
        const img = root.querySelector<HTMLInputElement>('[data-cb-dispatch-form] [name="image"]');
        // Image field shows the default as a placeholder (no org baked into value);
        // an empty submit falls back to it.
        expect(img?.placeholder).toContain('kageops-agent');
    });

    it('dispatches with the form values + the active pool id', async () => {
        const root = makeRoot();
        const { deps, state } = buildDeps({ pools: [pool({ id: 'pool-9' })], withDispatch: true });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();
        await flushPromises();

        fillAndSubmit(root, {
            projectId: 'proj-42',
            taskId: 'task-42',
            agentRole: 'vigil',
            estimatedCostUsd: '0.10',
        });
        await flushPromises();

        expect(state.dispatch).toHaveLength(1);
        expect(state.dispatch[0]).toMatchObject({
            projectId: 'proj-42',
            taskId: 'task-42',
            agentRole: 'vigil',
            poolId: 'pool-9',
            estimatedCostUsd: 0.10,
        });
        expect(String(state.dispatch[0]?.['image'])).toContain('kageops-agent');
    });

    it('blocks submit + reports when required fields are blank', async () => {
        const root = makeRoot();
        const { deps, state } = buildDeps({ pools: [pool()], withDispatch: true });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();
        await flushPromises();

        fillAndSubmit(root, { projectId: '', taskId: '' });
        await flushPromises();

        expect(state.dispatch).toHaveLength(0);
        const status = root.querySelector('[data-cb-dispatch-status]');
        expect(status?.textContent ?? '').toMatch(/required/i);
    });

    it('disables dispatch when no pool is configured', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({ pools: [], withDispatch: true });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();
        await flushPromises();
        const submit = root.querySelector<HTMLButtonElement>('[data-cb-dispatch-submit]');
        expect(submit?.disabled).toBe(true);
    });

    it('disables dispatch when the pool is disabled', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({ pools: [pool({ enabled: false })], withDispatch: true });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();
        await flushPromises();
        const submit = root.querySelector<HTMLButtonElement>('[data-cb-dispatch-submit]');
        expect(submit?.disabled).toBe(true);
    });

    it('surfaces a dispatch failure (with errorKind) in the status line', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({
            pools: [pool()],
            withDispatch: true,
            dispatchError: { error: 'no repo linked', errorKind: 'repo-not-configured' },
        });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();
        await flushPromises();

        fillAndSubmit(root, { projectId: 'p', taskId: 't' });
        await flushPromises();

        const status = root.querySelector('[data-cb-dispatch-status]');
        expect(status?.textContent ?? '').toMatch(/no repo linked.*repo-not-configured/);
    });
});

// ── Recent history sourced from listRecentBursts (PR-E.2c) ──

describe('renderCloudBurstPanel — recent history', () => {
    it('renders terminal bursts from listRecentBursts (not from the active query)', async () => {
        const done = burst({ id: 'b-done-01', status: 'completed', costUsd: 0.0006 });
        const root = makeRoot();
        const { deps } = buildDeps({ bursts: [], recentBursts: [done] });
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();
        await flushPromises();

        const historyBody = root.querySelector('[data-cb-history-body]');
        expect(historyBody?.textContent ?? '').toContain('completed');
        // Active section stays empty (the completed burst is terminal).
        const activeBody = root.querySelector('[data-cb-active-body]');
        expect(activeBody?.textContent ?? '').toContain('No active bursts');
    });

    it('history stays empty when listRecentBursts is not wired (legacy/back-compat)', async () => {
        const root = makeRoot();
        const { deps } = buildDeps({ bursts: [] }); // no recentBursts → dep omitted
        const handle = renderCloudBurstPanel(root, deps);
        await handle.refresh();
        await flushPromises();
        const historyBody = root.querySelector('[data-cb-history-body]');
        expect(historyBody?.textContent ?? '').toContain('No history yet');
    });
});
