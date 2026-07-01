/**
 * Pillar 2.5 / PR-I (D-I) — per-client cost panel.
 *
 * Renders below the Cost Intelligence operational-spend view. Where that
 * panel answers "what does KageOps cost to run?", this answers "what do I
 * bill each client?" — Cloud Burst compute actuals + estimated Azure
 * hosting, rolled up per `projects.client_id`, with a CSV export.
 *
 * Hosting is a recurring MONTHLY estimate (not an invoice), surfaced in its
 * own column so the operator never conflates a one-off burst spend with an
 * ongoing hosting commitment.
 *
 * Tests target `renderClientCostPanel(root, deps)` with a fake `deps` so the
 * suite drives the DOM + export without an Electron preload.
 */

// ── View + envelope shapes ──────────────────────────────

export interface ClientCostRowView {
    readonly clientId: string | null;
    readonly burstCostUsd: number;
    readonly hostingMonthlyUsd: number;
    readonly deployTargetCount: number;
    readonly totalUsd: number;
}

export interface UnifiedCostRollupView {
    readonly clients: readonly ClientCostRowView[];
    readonly totalBurstUsd: number;
    readonly totalHostingMonthlyUsd: number;
}

type Envelope<T> =
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: string };

export interface ClientCostPanelDeps {
    readonly getClientRollup: () => Promise<Envelope<UnifiedCostRollupView>>;
    readonly exportClients: () => Promise<Envelope<{ csv: string; filename: string }>>;
    /** Trigger a file download (test seam). Defaults to a Blob + anchor click. */
    readonly download?: (filename: string, content: string) => void;
}

export interface ClientCostPanelHandle {
    readonly refresh: () => Promise<void>;
}

// ── Production deps from the preload bridge ─────────────

interface CostBridge {
    readonly getClientRollup: () => Promise<Envelope<UnifiedCostRollupView>>;
    readonly exportClients: () => Promise<Envelope<{ csv: string; filename: string }>>;
}

export function defaultClientCostPanelDeps(): ClientCostPanelDeps {
    const api = (window as unknown as { kageOps?: { cost?: CostBridge } }).kageOps;
    if (api?.cost === undefined) {
        throw new Error('client-cost panel: window.kageOps.cost preload bridge missing');
    }
    const cost = api.cost;
    return {
        getClientRollup: () => cost.getClientRollup(),
        exportClients: () => cost.exportClients(),
    };
}

// ── Renderer ───────────────────────────────────────────

export function renderClientCostPanel(
    root: HTMLElement,
    deps: ClientCostPanelDeps
): ClientCostPanelHandle {
    const downloadFn = deps.download ?? defaultDownload;
    root.classList.add('client-cost-panel');

    async function refresh(): Promise<void> {
        const res = await deps.getClientRollup();
        if (!res.success) {
            root.innerHTML = `<div class="empty-state">Per-client cost unavailable: ${escapeHtml(res.error)}</div>`;
            return;
        }
        root.innerHTML = buildHtml(res.data);
        wireExport();
    }

    function wireExport(): void {
        const btn = root.querySelector<HTMLButtonElement>('[data-cc-export]');
        if (btn === null) return;
        btn.addEventListener('click', () => {
            btn.disabled = true;
            const prev = btn.textContent;
            btn.textContent = 'Exporting…';
            void deps.exportClients().then((res) => {
                btn.disabled = false;
                btn.textContent = prev ?? 'Export CSV';
                if (res.success) {
                    downloadFn(res.data.filename, res.data.csv);
                } else {
                    const status = root.querySelector<HTMLElement>('[data-cc-status]');
                    if (status !== null) status.textContent = `Export failed: ${res.error}`;
                }
            });
        });
    }

    void refresh();
    return { refresh };
}

// ── HTML ────────────────────────────────────────────────

function buildHtml(rollup: UnifiedCostRollupView): string {
    const body = rollup.clients.length > 0
        ? buildTable(rollup)
        : '<div class="empty-state">No client cost yet. Tag a project with a client, run a burst, or deploy to start tracking.</div>';
    return `
        <div class="cc-head">
            <div class="ci-breakdown-title">PER-CLIENT COST</div>
            <button type="button" class="btn-sm" data-cc-export ${rollup.clients.length === 0 ? 'disabled' : ''}>Export CSV</button>
        </div>
        <p class="cc-note">Cloud Burst compute is an actual spend; hosting is an estimated monthly cost (cost model, not an invoice).</p>
        ${body}
        <span class="cc-status" data-cc-status aria-live="polite"></span>
    `;
}

function buildTable(rollup: UnifiedCostRollupView): string {
    const rows = rollup.clients.map((c) => `
        <tr>
            <td class="cc-client">${escapeHtml(c.clientId ?? 'Unassigned')}</td>
            <td class="cc-num">${formatCost(c.burstCostUsd)}</td>
            <td class="cc-num">${formatCost(c.hostingMonthlyUsd)}${c.hostingMonthlyUsd > 0 ? '<span class="cc-permo">/mo</span>' : ''}</td>
            <td class="cc-num">${c.deployTargetCount}</td>
            <td class="cc-num cc-total">${formatCost(c.totalUsd)}</td>
        </tr>
    `).join('');
    return `
        <table class="data-table cc-table">
            <thead>
                <tr>
                    <th>Client</th>
                    <th>Burst (AI)</th>
                    <th>Hosting</th>
                    <th>Targets</th>
                    <th>Total</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
                <tr class="cc-foot">
                    <td>All clients</td>
                    <td class="cc-num">${formatCost(rollup.totalBurstUsd)}</td>
                    <td class="cc-num">${formatCost(rollup.totalHostingMonthlyUsd)}<span class="cc-permo">/mo</span></td>
                    <td></td>
                    <td class="cc-num cc-total">${formatCost(rollup.totalBurstUsd + rollup.totalHostingMonthlyUsd)}</td>
                </tr>
            </tfoot>
        </table>
    `;
}

// ── Helpers ────────────────────────────────────────────

function defaultDownload(filename: string, content: string): void {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function formatCost(usd: number): string {
    if (usd < 0.001) return '$0.00';
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

function escapeHtml(raw: string): string {
    return raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
