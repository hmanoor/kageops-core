/**
 * KageOps Command Center — Cost Tracker Panel
 *
 * Displays per-agent, per-project, and total AI cost breakdowns.
 * Data sourced from agent_logs table aggregations.
 */

// ── Types ────────────────────────────────────────────

interface CostEntry {
    readonly agent: string;
    readonly totalCost: number;
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly requestCount: number;
}

interface CostSummary {
    readonly byAgent: readonly CostEntry[];
    readonly totalCost: number;
    readonly totalTokensIn: number;
    readonly totalTokensOut: number;
    readonly totalRequests: number;
}

// ── Color Palette ───────────────────────────────────

const AGENT_COLORS: Record<string, string> = {
    scout: '#22c55e',
    blueprint: '#94a3b8',
    pixel: '#ec4899',
    forge: '#f97316',
    cipher: '#06b6d4',
    aegis: '#1e3a5f',
    vigil: '#eab308',
    herald: '#ef4444',
};

function getAgentColor(agent: string): string {
    return AGENT_COLORS[agent] ?? '#6b7280';
}

// ── Render ───────────────────────────────────────────

/**
 * Render the cost tracker panel into the given container.
 */
export function renderCostPanel(container: HTMLElement, summary: CostSummary): void {
    if (summary.byAgent.length === 0) {
        container.innerHTML = '<div class="empty-state">No cost data available</div>';
        return;
    }

    const totalRow = renderTotalRow(summary);
    const agentRows = summary.byAgent.map(renderAgentRow).join('');
    const barChart = renderBarChart(summary);

    container.innerHTML = `
        <div class="cost-panel">
            <div class="cost-summary">
                ${totalRow}
            </div>
            <div class="cost-chart">
                ${barChart}
            </div>
            <table class="cost-table">
                <thead>
                    <tr>
                        <th>Agent</th>
                        <th class="num">Requests</th>
                        <th class="num">Tokens In</th>
                        <th class="num">Tokens Out</th>
                        <th class="num">Cost (USD)</th>
                    </tr>
                </thead>
                <tbody>${agentRows}</tbody>
            </table>
        </div>
    `;
}

// ── Component Renderers ─────────────────────────────

function renderTotalRow(summary: CostSummary): string {
    return `
        <div class="cost-stat">
            <span class="cost-label">Total Cost</span>
            <span class="cost-value">${formatCurrency(summary.totalCost)}</span>
        </div>
        <div class="cost-stat">
            <span class="cost-label">Total Requests</span>
            <span class="cost-value">${formatNumber(summary.totalRequests)}</span>
        </div>
        <div class="cost-stat">
            <span class="cost-label">Total Tokens</span>
            <span class="cost-value">${formatNumber(summary.totalTokensIn + summary.totalTokensOut)}</span>
        </div>
    `;
}

function renderAgentRow(entry: CostEntry): string {
    const color = getAgentColor(entry.agent);
    return `
        <tr>
            <td><span class="agent-dot" style="background:${color}"></span>${escapeHtml(entry.agent)}</td>
            <td class="num">${formatNumber(entry.requestCount)}</td>
            <td class="num">${formatNumber(entry.tokensIn)}</td>
            <td class="num">${formatNumber(entry.tokensOut)}</td>
            <td class="num">${formatCurrency(entry.totalCost)}</td>
        </tr>
    `;
}

function renderBarChart(summary: CostSummary): string {
    const maxCost = Math.max(...summary.byAgent.map((e) => e.totalCost), 0.001);

    const bars = summary.byAgent.map((entry) => {
        const widthPct = Math.max(1, (entry.totalCost / maxCost) * 100);
        const color = getAgentColor(entry.agent);
        return `
            <div class="bar-row">
                <span class="bar-label">${escapeHtml(entry.agent)}</span>
                <div class="bar-track">
                    <div class="bar-fill" style="width:${widthPct}%;background:${color}"></div>
                </div>
                <span class="bar-value">${formatCurrency(entry.totalCost)}</span>
            </div>
        `;
    }).join('');

    return `<div class="bar-chart">${bars}</div>`;
}

// ── Utilities ────────────────────────────────────────

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatCurrency(amount: number): string {
    return `$${amount.toFixed(4)}`;
}

function formatNumber(n: number): string {
    return n.toLocaleString('en-US');
}
