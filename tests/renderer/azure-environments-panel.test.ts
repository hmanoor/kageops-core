/**
 * Pillar 2.5 / PR-C — azure-environments-panel renderer tests.
 *
 * DOM-driven tests against the panel's pure rendering + deps surface.
 * `renderAzureEnvironmentsPanel(root, deps)` is the public seam — every
 * IPC call is mockable, and `confirm` is injected so deletes are
 * deterministic without a browser dialog.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
    renderAzureEnvironmentsPanel,
    defaultAzureEnvironmentsPanelDeps,
    type AzureEnvironmentsPanelDeps,
    type AzureEnvironmentView,
} from '../../src/renderer/command-center/azure-environments-panel';

// ── Fixtures ───────────────────────────────────────────

function envView(overrides?: Partial<AzureEnvironmentView>): AzureEnvironmentView {
    return {
        id: 'env-1',
        label: 'Production AU',
        subscriptionId: '11111111-1111-1111-1111-111111111111',
        resourceGroup: 'kageops-prod',
        defaultRegion: 'australiaeast',
        tenantId: null,
        credentialRef: null,
        createdAt: '2026-06-05T00:00:00Z',
        updatedAt: '2026-06-05T00:00:00Z',
        ...overrides,
    };
}

interface CallState {
    list: number;
    create: Array<Record<string, unknown>>;
    update: Array<{ id: string; patch: Record<string, unknown> }>;
    delete: string[];
}

function buildDeps(opts?: {
    envs?: readonly AzureEnvironmentView[];
    createSuccess?: boolean;
    createError?: string;
    updateSuccess?: boolean;
    deleteSuccess?: boolean;
    deleteError?: string;
    confirmResult?: boolean;
    listFails?: boolean;
}): { deps: AzureEnvironmentsPanelDeps; state: CallState } {
    const state: CallState = { list: 0, create: [], update: [], delete: [] };
    let envs = [...(opts?.envs ?? [envView()])];
    const deps: AzureEnvironmentsPanelDeps = {
        listEnvironments: vi.fn(async () => {
            state.list += 1;
            if (opts?.listFails) return { success: false as const, error: 'boom' };
            return { success: true as const, data: envs };
        }),
        createEnvironment: vi.fn(async (input) => {
            state.create.push(input as unknown as Record<string, unknown>);
            if (opts?.createSuccess === false) {
                return { success: false as const, error: opts.createError ?? 'create failed' };
            }
            const created = envView({ id: `env-${state.create.length + 1}`, ...input });
            envs = [...envs, created];
            return { success: true as const, data: created };
        }),
        updateEnvironment: vi.fn(async (id, patch) => {
            state.update.push({ id, patch: patch as unknown as Record<string, unknown> });
            if (opts?.updateSuccess === false) return { success: false as const, error: 'update failed' };
            const next = envView({ id, ...patch });
            envs = envs.map((e) => (e.id === id ? next : e));
            return { success: true as const, data: next };
        }),
        deleteEnvironment: vi.fn(async (id) => {
            state.delete.push(id);
            if (opts?.deleteSuccess === false) return { success: false as const, error: opts.deleteError ?? 'delete failed' };
            envs = envs.filter((e) => e.id !== id);
            return { success: true as const };
        }),
        confirm: () => opts?.confirmResult ?? true,
    };
    return { deps, state };
}

beforeEach(() => {
    document.body.innerHTML = '';
});

function mount(): HTMLElement {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return root;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── Tests ──────────────────────────────────────────────

describe('renderAzureEnvironmentsPanel', () => {
    it('renders a row per environment', async () => {
        const root = mount();
        const { deps } = buildDeps({ envs: [envView(), envView({ id: 'env-2', label: 'Dev EU', defaultRegion: 'westeurope' })] });
        renderAzureEnvironmentsPanel(root, deps);
        await tick();
        const rows = root.querySelectorAll('[data-azenv-row]');
        expect(rows).toHaveLength(2);
        expect(root.textContent).toContain('Production AU');
        expect(root.textContent).toContain('Dev EU');
    });

    it('shows an empty state when there are no environments', async () => {
        const root = mount();
        const { deps } = buildDeps({ envs: [] });
        renderAzureEnvironmentsPanel(root, deps);
        await tick();
        expect(root.querySelector('.empty-state')?.textContent).toContain('No Azure environments');
    });

    it('shows a load error when listEnvironments fails', async () => {
        const root = mount();
        const { deps } = buildDeps({ listFails: true });
        renderAzureEnvironmentsPanel(root, deps);
        await tick();
        expect(root.textContent).toContain('Failed to load environments');
    });

    it('labels credential mode per row', async () => {
        const root = mount();
        const { deps } = buildDeps({
            envs: [envView(), envView({ id: 'env-2', label: 'SP', credentialRef: 'kv://sp' })],
        });
        renderAzureEnvironmentsPanel(root, deps);
        await tick();
        expect(root.textContent).toContain('DefaultAzureCredential');
        expect(root.textContent).toContain('service principal');
    });

    it('opens the create form and submits a valid environment', async () => {
        const root = mount();
        const { deps, state } = buildDeps({ envs: [] });
        renderAzureEnvironmentsPanel(root, deps);
        await tick();

        root.querySelector<HTMLButtonElement>('[data-azenv-add]')?.click();
        await tick();
        const form = root.querySelector<HTMLFormElement>('[data-azenv-create]');
        expect(form).not.toBeNull();
        setInput(form!, 'label', 'Production AU');
        setInput(form!, 'subscriptionId', 'sub-x');
        setInput(form!, 'resourceGroup', 'rg-x');
        setInput(form!, 'defaultRegion', 'australiaeast');
        form!.requestSubmit();
        await tick();
        await tick();

        expect(state.create).toHaveLength(1);
        expect(state.create[0]).toMatchObject({ label: 'Production AU', subscriptionId: 'sub-x' });
        // Form closed + new row rendered after reload.
        expect(root.querySelector('[data-azenv-create]')).toBeNull();
        expect(root.querySelectorAll('[data-azenv-row]')).toHaveLength(1);
    });

    it('blocks submit + shows an error when required fields are blank', async () => {
        const root = mount();
        const { deps, state } = buildDeps({ envs: [] });
        renderAzureEnvironmentsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-azenv-add]')?.click();
        await tick();
        const form = root.querySelector<HTMLFormElement>('[data-azenv-create]');
        form!.requestSubmit();
        await tick();
        expect(state.create).toHaveLength(0);
        expect(root.querySelector('[data-azenv-create-error]')?.textContent).toContain('required');
    });

    it('surfaces a create error from the handler (e.g. duplicate label)', async () => {
        const root = mount();
        const { deps } = buildDeps({ envs: [], createSuccess: false, createError: 'already exists' });
        renderAzureEnvironmentsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-azenv-add]')?.click();
        await tick();
        const form = root.querySelector<HTMLFormElement>('[data-azenv-create]');
        setInput(form!, 'label', 'Dup');
        setInput(form!, 'subscriptionId', 'sub');
        setInput(form!, 'resourceGroup', 'rg');
        setInput(form!, 'defaultRegion', 'eastus');
        form!.requestSubmit();
        await tick();
        await tick();
        expect(root.querySelector('[data-azenv-create-error]')?.textContent).toContain('already exists');
    });

    it('edits a row — label & subscription are immutable, patch carries the editable fields', async () => {
        const root = mount();
        const { deps, state } = buildDeps();
        renderAzureEnvironmentsPanel(root, deps);
        await tick();

        root.querySelector<HTMLButtonElement>('[data-azenv-edit]')?.click();
        await tick();
        const editForm = root.querySelector<HTMLFormElement>('[data-azenv-edit-form]');
        expect(editForm).not.toBeNull();
        // Subscription input is disabled (immutable).
        const subInput = editForm!.querySelector<HTMLInputElement>('input[disabled]');
        expect(subInput?.value).toBe('11111111-1111-1111-1111-111111111111');

        setInput(editForm!, 'resourceGroup', 'kageops-new');
        setInput(editForm!, 'defaultRegion', 'westus2');
        editForm!.requestSubmit();
        await tick();
        await tick();

        expect(state.update).toHaveLength(1);
        expect(state.update[0].id).toBe('env-1');
        expect(state.update[0].patch).toMatchObject({ resourceGroup: 'kageops-new', defaultRegion: 'westus2' });
    });

    it('deletes a row after confirm', async () => {
        const root = mount();
        const { deps, state } = buildDeps({ confirmResult: true });
        renderAzureEnvironmentsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-azenv-delete]')?.click();
        await tick();
        await tick();
        expect(state.delete).toEqual(['env-1']);
        expect(root.querySelectorAll('[data-azenv-row]')).toHaveLength(0);
    });

    it('does not delete when confirm is declined', async () => {
        const root = mount();
        const { deps, state } = buildDeps({ confirmResult: false });
        renderAzureEnvironmentsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-azenv-delete]')?.click();
        await tick();
        expect(state.delete).toHaveLength(0);
    });

    it('shows the row status when a delete is rejected (FK restrict)', async () => {
        const root = mount();
        const { deps } = buildDeps({ deleteSuccess: false, deleteError: 'A Cloud Burst pool still references this environment.' });
        renderAzureEnvironmentsPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-azenv-delete]')?.click();
        await tick();
        await tick();
        expect(root.querySelector('[data-azenv-status]')?.textContent).toContain('Cloud Burst pool');
        // Row is still present.
        expect(root.querySelectorAll('[data-azenv-row]')).toHaveLength(1);
    });
});

describe('defaultAzureEnvironmentsPanelDeps', () => {
    it('throws when the preload bridge is missing', () => {
        const w = window as unknown as { kageOps?: unknown };
        const prev = w.kageOps;
        w.kageOps = undefined;
        expect(() => defaultAzureEnvironmentsPanelDeps()).toThrow(/preload bridge missing/);
        w.kageOps = prev;
    });

    it('maps the bridge methods through', async () => {
        const list = vi.fn(async () => ({ success: true as const, data: [] }));
        const w = window as unknown as { kageOps?: unknown };
        const prev = w.kageOps;
        w.kageOps = { azureEnvironment: { list, get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() } };
        const deps = defaultAzureEnvironmentsPanelDeps();
        await deps.listEnvironments();
        expect(list).toHaveBeenCalledOnce();
        w.kageOps = prev;
    });
});

// ── Helpers ────────────────────────────────────────────

function setInput(form: HTMLFormElement, name: string, value: string): void {
    const input = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (input === null) throw new Error(`input ${name} not found`);
    input.value = value;
}
