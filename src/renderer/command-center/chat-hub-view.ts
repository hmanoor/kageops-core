/**
 * KageOps Command Center — Chat Hub View (CH)
 *
 * Unified agent chat interface. Users can browse all agents in a left sidebar,
 * select one, and exchange messages in a per-agent conversation thread.
 *
 * Data flows through the existing kageOps preload API — no new IPC channels needed.
 */

import { AGENT_PROFILES } from './agent-profiles';
import { getSigilHtml } from './sigils';

// ── Types ────────────────────────────────────────────

export interface ChatHubApi {
    readonly getAgents: () => Promise<readonly AgentEntry[]>;
    readonly sendToSensei: (message: string) => Promise<string>;
    readonly getAgentDetail: (agentName: string) => Promise<AgentDetailInfo | null>;
}

interface AgentEntry {
    readonly name: string;
    readonly role: string;
    readonly status: 'idle' | 'busy' | 'error';
    readonly currentTaskTitle: string | null;
}

interface AgentDetailInfo {
    readonly name: string;
    readonly role: string;
    readonly status: string;
    readonly stats: {
        readonly totalCompleted: number;
        readonly totalFailed: number;
        readonly avgQualityScore: number | null;
    };
}

interface ChatMessage {
    readonly from: 'user' | 'agent';
    readonly text: string;
    readonly timestamp: string;
}

// ── Constants ────────────────────────────────────────

const AGENT_ORDER: readonly string[] = [
    'sensei', 'scout', 'blueprint', 'pixel', 'forge', 'cipher', 'aegis', 'vigil', 'herald',
];

// ── State ────────────────────────────────────────────

let conversations: Map<string, readonly ChatMessage[]> = new Map();
let selectedAgent: string | null = null;
let isSending = false;

// ── Public API ───────────────────────────────────────

export function initChatHubView(container: HTMLElement, api: ChatHubApi): void {
    // Reset state for clean init
    conversations = new Map();
    selectedAgent = null;
    isSending = false;

    container.innerHTML = `
        <div class="ch-view">
            <aside class="ch-sidebar" id="ch-sidebar">
                <div class="ch-sidebar-header">Agents</div>
                <div class="ch-agent-list" id="ch-agent-list">
                    <div class="empty-state">Loading agents\u2026</div>
                </div>
            </aside>
            <main class="ch-main" id="ch-main">
                <div class="ch-empty-main">
                    <div class="ch-empty-icon">\uD83D\uDCAC</div>
                    <div class="ch-empty-title">Select an agent to start chatting</div>
                    <div class="ch-empty-subtitle">Pick an agent from the sidebar to begin a conversation</div>
                </div>
            </main>
        </div>`;

    void loadAgentList(container, api);
}

// ── Data Loading ─────────────────────────────────────

async function loadAgentList(container: HTMLElement, api: ChatHubApi): Promise<void> {
    try {
        const agents = await api.getAgents();
        renderAgentList(container, [...agents], api);
    } catch {
        const list = container.querySelector('#ch-agent-list');
        if (list !== null) {
            list.innerHTML = '<div class="empty-state">Failed to load agents</div>';
        }
    }
}

// ── Agent Sidebar ────────────────────────────────────

function renderAgentList(
    container: HTMLElement,
    agents: readonly AgentEntry[],
    api: ChatHubApi
): void {
    const listEl = container.querySelector('#ch-agent-list');
    if (listEl === null) return;

    const sorted = [...agents].sort((a, b) => {
        const ai = AGENT_ORDER.indexOf(a.name.toLowerCase());
        const bi = AGENT_ORDER.indexOf(b.name.toLowerCase());
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    if (sorted.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No agents registered</div>';
        return;
    }

    listEl.innerHTML = sorted.map((agent) => {
        const key = agent.name.toLowerCase();
        const profile = AGENT_PROFILES[key];
        const color = profile?.color ?? 'oklch(0.66 0.12 150)';
        const msgs = conversations.get(key) ?? [];
        const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        const preview = lastMsg !== null ? truncate(lastMsg.text, 40) : (profile?.title ?? agent.role);
        const isSelected = key === selectedAgent;

        return `
        <div class="ch-agent-item${isSelected ? ' ch-agent-item--selected' : ''}"
             data-agent="${esc(key)}" style="--agent-color: ${color}">
            <div class="ch-agent-portrait-wrap">
                <span class="ch-agent-portrait sigil-host">${getSigilHtml(key, { label: agent.name })}</span>
                <span class="ch-agent-status ch-agent-status--${agent.status}"></span>
            </div>
            <div class="ch-agent-meta">
                <span class="ch-agent-name">${esc(agent.name)}</span>
                <span class="ch-agent-preview">${esc(preview)}</span>
            </div>
            ${msgs.length > 0 ? `<span class="ch-agent-badge">${msgs.length}</span>` : ''}
        </div>`;
    }).join('');

    // Wire click handlers
    listEl.querySelectorAll<HTMLElement>('.ch-agent-item').forEach((item) => {
        item.addEventListener('click', () => {
            const name = item.dataset['agent'] ?? '';
            if (name !== '') {
                selectedAgent = name;
                renderAgentList(container, agents, api);
                renderChatPanel(container, name, agents, api);
            }
        });
    });
}

// ── Chat Panel ───────────────────────────────────────

function renderChatPanel(
    container: HTMLElement,
    agentName: string,
    agents: readonly AgentEntry[],
    api: ChatHubApi
): void {
    const mainEl = container.querySelector('#ch-main');
    if (mainEl === null) return;

    const agent = agents.find((a) => a.name.toLowerCase() === agentName);
    const profile = AGENT_PROFILES[agentName];
    const color = profile?.color ?? 'oklch(0.66 0.12 150)';
    const statusLabel = agent?.status ?? 'idle';

    mainEl.innerHTML = `
        <div class="ch-chat-header" style="--agent-color: ${color}">
            <div class="ch-chat-header-left">
                <span class="ch-chat-header-portrait sigil-host">${getSigilHtml(agentName, { label: agentName })}</span>
                <div class="ch-chat-header-info">
                    <span class="ch-chat-header-name">${esc(agentName)}</span>
                    ${profile ? `<span class="ch-chat-header-title">${esc(profile.title)}</span>` : ''}
                </div>
            </div>
            <span class="ch-chat-header-status ch-chat-header-status--${statusLabel}">
                ${esc(statusLabel)}
            </span>
        </div>
        <div class="ch-messages" id="ch-messages"></div>
        <div class="ch-input-row">
            <input type="text" class="ch-input" id="ch-input"
                   placeholder="Message ${esc(agentName)}\u2026"
                   autocomplete="off">
            <button class="ch-send-btn" id="ch-send-btn">Send</button>
        </div>`;

    renderMessages(container, agentName);
    wireInput(container, agentName, agents, api);
}

function renderMessages(container: HTMLElement, agentName: string): void {
    const messagesEl = container.querySelector('#ch-messages');
    if (messagesEl === null) return;

    const msgs = conversations.get(agentName) ?? [];

    if (msgs.length === 0) {
        const profile = AGENT_PROFILES[agentName];
        messagesEl.innerHTML = `
            <div class="ch-messages-empty">
                ${profile
                    ? `<p>${esc(profile.description)}</p>`
                    : `<p>Start a conversation with ${esc(agentName)}.</p>`}
            </div>`;
        return;
    }

    messagesEl.innerHTML = msgs.map((msg) => {
        const isAgent = msg.from === 'agent';
        const color = AGENT_PROFILES[agentName]?.color ?? 'oklch(0.66 0.12 150)';
        const time = formatTime(msg.timestamp);

        if (isAgent) {
            return `
            <div class="ch-msg ch-msg--agent">
                <div class="ch-msg-avatar-wrap">
                    <span class="ch-msg-avatar sigil-host">${getSigilHtml(agentName, { label: agentName })}</span>
                </div>
                <div class="ch-msg-body">
                    <div class="ch-msg-meta">
                        <span class="ch-msg-name" style="color:${color}">${esc(agentName)}</span>
                        <span class="ch-msg-time">${esc(time)}</span>
                    </div>
                    <div class="ch-msg-text">${renderMarkdownLite(msg.text)}</div>
                </div>
            </div>`;
        }

        return `
        <div class="ch-msg ch-msg--user">
            <div class="ch-msg-body">
                <div class="ch-msg-meta">
                    <span class="ch-msg-name">You</span>
                    <span class="ch-msg-time">${esc(time)}</span>
                </div>
                <div class="ch-msg-text">${esc(msg.text)}</div>
            </div>
        </div>`;
    }).join('');

    messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Input Wiring ─────────────────────────────────────

function wireInput(
    container: HTMLElement,
    agentName: string,
    agents: readonly AgentEntry[],
    api: ChatHubApi
): void {
    const input = container.querySelector('#ch-input') as HTMLInputElement | null;
    const sendBtn = container.querySelector('#ch-send-btn') as HTMLButtonElement | null;
    if (input === null || sendBtn === null) return;

    const doSend = (): void => {
        if (isSending) return;
        const text = input.value.trim();
        if (text === '') return;

        input.value = '';
        addMessage(agentName, { from: 'user', text, timestamp: new Date().toISOString() });
        renderMessages(container, agentName);
        renderAgentList(container, agents, api);

        isSending = true;
        sendBtn.disabled = true;
        sendBtn.textContent = '\u2026';

        // Route through Sensei with agent name prefix
        const routedMessage = `@${agentName}: ${text}`;
        void api.sendToSensei(routedMessage).then((response) => {
            addMessage(agentName, { from: 'agent', text: response, timestamp: new Date().toISOString() });
            renderMessages(container, agentName);
            renderAgentList(container, agents, api);
        }).catch(() => {
            addMessage(agentName, {
                from: 'agent',
                text: 'The path is unclear. I could not reach my own thoughts.',
                timestamp: new Date().toISOString(),
            });
            renderMessages(container, agentName);
        }).finally(() => {
            isSending = false;
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send';
        });
    };

    sendBtn.addEventListener('click', doSend);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSend();
    });

    input.focus();
}

// ── Conversation Helpers ─────────────────────────────

function addMessage(agentName: string, message: ChatMessage): void {
    const existing = conversations.get(agentName) ?? [];
    conversations = new Map(conversations);
    conversations.set(agentName, [...existing, message]);
}

// ── Rendering Helpers ────────────────────────────────

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(text: string, max: number): string {
    return text.length > max ? text.slice(0, max - 1) + '\u2026' : text;
}

function formatTime(isoString: string): string {
    try {
        const d = new Date(isoString);
        return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '--:--';
    }
}

/** Simple markdown-lite: bold, inline code, line breaks */
function renderMarkdownLite(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
}
