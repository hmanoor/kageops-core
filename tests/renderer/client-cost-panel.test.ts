/**
 * Pillar 2.5 / PR-I — client-cost-panel renderer tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
    renderClientCostPanel,
    type ClientCostPanelDeps,
    type UnifiedCostRollupView,
} from '../../src/renderer/command-center/client-cost-panel';

const ROLLUP: UnifiedCostRollupView = {
    clients: [
        { clientId: 'acme', burstCostUsd: 1.5, hostingMonthlyUsd: 13, deployTargetCount: 2, totalUsd: 14.5 },
        { clientId: null, burstCostUsd: 0.4, hostingMonthlyUsd: 0, deployTargetCount: 0, totalUsd: 0.4 },
    ],
    totalBurstUsd: 1.9,
    totalHostingMonthlyUsd: 13,
};

interface State { downloads: Array<{ filename: string; content: string }> }

function buildDeps(opts?: {
    rollup?: UnifiedCostRollupView;
    rollupFails?: boolean;
    exportFails?: boolean;
}): { deps: ClientCostPanelDeps; state: State } {
    const state: State = { downloads: [] };
    const deps: ClientCostPanelDeps = {
        getClientRollup: vi.fn(async () =>
            opts?.rollupFails
                ? { success: false as const, error: 'rollup boom' }
                : { success: true as const, data: opts?.rollup ?? ROLLUP }
        ),
        exportClients: vi.fn(async () =>
            opts?.exportFails
                ? { success: false as const, error: 'export boom' }
                : { success: true as const, data: { csv: 'Client,...\nacme,...', filename: 'kageops-client-costs.csv' } }
        ),
        download: vi.fn((filename, content) => { state.downloads.push({ filename, content }); }),
    };
    return { deps, state };
}

function mount(): HTMLElement {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return root;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { document.body.innerHTML = ''; });

describe('renderClientCostPanel', () => {
    it('renders a row per client plus a totals footer', async () => {
        const root = mount();
        const { deps } = buildDeps();
        renderClientCostPanel(root, deps);
        await tick();
        expect(root.querySelectorAll('.cc-table tbody tr')).toHaveLength(2);
        expect(root.textContent).toContain('acme');
        expect(root.textContent).toContain('Unassigned');
        expect(root.querySelector('.cc-foot')).not.toBeNull();
    });

    it('shows an empty state with a disabled export when there is no cost', async () => {
        const root = mount();
        const { deps } = buildDeps({ rollup: { clients: [], totalBurstUsd: 0, totalHostingMonthlyUsd: 0 } });
        renderClientCostPanel(root, deps);
        await tick();
        expect(root.querySelector('.empty-state')).not.toBeNull();
        expect(root.querySelector<HTMLButtonElement>('[data-cc-export]')?.disabled).toBe(true);
    });

    it('exports CSV via the download seam', async () => {
        const root = mount();
        const { deps, state } = buildDeps();
        renderClientCostPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-cc-export]')?.click();
        await tick();
        await tick();
        expect(deps.exportClients).toHaveBeenCalledOnce();
        expect(state.downloads).toHaveLength(1);
        expect(state.downloads[0].filename).toBe('kageops-client-costs.csv');
    });

    it('surfaces an export failure in the status line', async () => {
        const root = mount();
        const { deps, state } = buildDeps({ exportFails: true });
        renderClientCostPanel(root, deps);
        await tick();
        root.querySelector<HTMLButtonElement>('[data-cc-export]')?.click();
        await tick();
        await tick();
        expect(state.downloads).toHaveLength(0);
        expect(root.querySelector('[data-cc-status]')?.textContent).toContain('export boom');
    });

    it('shows a load error when the rollup fails', async () => {
        const root = mount();
        const { deps } = buildDeps({ rollupFails: true });
        renderClientCostPanel(root, deps);
        await tick();
        expect(root.textContent).toContain('Per-client cost unavailable');
        expect(root.textContent).toContain('rollup boom');
    });
});
