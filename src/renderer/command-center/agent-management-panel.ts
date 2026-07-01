/**
 * KageOps Command Center — Agent Management Panel (C2)
 *
 * Shows all agents with status dot, model summary, and an enable/disable toggle.
 * Plain TypeScript DOM — no React.
 */

import { getSigilHtml } from './sigils';

// ── Types ─────────────────────────────────────────────

export interface AgentConfig {
    readonly name: string;
    readonly role: string;
    readonly status: 'idle' | 'busy' | 'error';
    readonly model: string;
    readonly enabled: boolean;
}

export interface AgentManagementCallbacks {
    getAgentConfigs(): Promise<AgentConfig[]>;
    setAgentEnabled(agentName: string, enabled: boolean): Promise<{ success: boolean; error?: string }>;
    onAgentClick?(agentName: string): void;
}

// ── Public API ────────────────────────────────────────

export function renderAgentManagementPanel(
    container: HTMLElement,
    callbacks: AgentManagementCallbacks
): void {
    void loadAndRender(container, callbacks);
}

// ── Internal ──────────────────────────────────────────

async function loadAndRender(
    container: HTMLElement,
    callbacks: AgentManagementCallbacks
): Promise<void> {
    try {
        const configs = await callbacks.getAgentConfigs();
        render(container, configs, callbacks);
    } catch {
        container.innerHTML = '<div class="empty-state">Failed to load agents</div>';
    }
}

function render(
    container: HTMLElement,
    configs: readonly AgentConfig[],
    callbacks: AgentManagementCallbacks
): void {
    if (configs.length === 0) {
        container.innerHTML = '<div class="empty-state">No agents registered</div>';
        return;
    }

    container.innerHTML = configs.map((cfg) => buildRow(cfg)).join('');

    container.querySelectorAll<HTMLInputElement>('.agent-toggle-input').forEach((input) => {
        input.addEventListener('change', () => {
            const agentName = input.dataset['agent'] ?? '';
            if (agentName === '') return;
            const newEnabled = input.checked;
            void handleToggle(container, agentName, newEnabled, callbacks);
        });
    });

    // Click row (excluding the toggle) → open agent detail
    if (callbacks.onAgentClick !== undefined) {
        const cb = callbacks.onAgentClick;
        container.querySelectorAll<HTMLElement>('.agent-mgmt-row').forEach((row) => {
            row.addEventListener('click', (e) => {
                // Don't trigger if the click was on the toggle switch
                if ((e.target as Element).closest('.agent-toggle') !== null) return;
                const nameEl = row.querySelector('.agent-mgmt-name');
                const name = nameEl?.textContent?.trim() ?? '';
                if (name !== '') cb(name);
            });
        });
    }
}

async function handleToggle(
    container: HTMLElement,
    agentName: string,
    enabled: boolean,
    callbacks: AgentManagementCallbacks
): Promise<void> {
    const result = await callbacks.setAgentEnabled(agentName, enabled);
    if (!result.success) {
        // Revert the toggle visually on failure then re-render current state
        void loadAndRender(container, callbacks);
    }
}

function buildRow(cfg: AgentConfig): string {
    const dotClass = cfg.status === 'busy' ? 'busy' : cfg.status === 'error' ? 'error' : 'idle';
    const modelDisplay = cfg.model.length > 24 ? cfg.model.slice(0, 21) + '…' : cfg.model;
    const checkedAttr = cfg.enabled ? ' checked' : '';
    const inputId = `agent-toggle-${escHtml(cfg.name)}`;

    return `
        <div class="agent-mgmt-row">
            <span class="agent-mgmt-portrait sigil-host">${getSigilHtml(cfg.name.toLowerCase(), { label: cfg.name })}</span>
            <div class="status-dot ${escHtml(dotClass)}"></div>
            <div class="agent-mgmt-identity">
                <div class="agent-mgmt-name">${escHtml(cfg.name)}</div>
                <div class="agent-mgmt-role">${escHtml(cfg.role)}</div>
            </div>
            <div class="agent-mgmt-model" title="${escHtml(cfg.model)}">${escHtml(modelDisplay)}</div>
            <label class="agent-toggle" title="${cfg.enabled ? 'Enabled' : 'Disabled'}">
                <input
                    id="${inputId}"
                    type="checkbox"
                    class="agent-toggle-input"
                    data-agent="${escHtml(cfg.name)}"
                    ${checkedAttr}
                >
                <span class="agent-toggle-slider"></span>
            </label>
        </div>
    `;
}

function escHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
