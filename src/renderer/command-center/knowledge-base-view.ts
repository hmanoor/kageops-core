/**
 * KageOps Command Center — Knowledge Base View (KB)
 *
 * Searchable document and artifact browser for project docs, agent outputs,
 * architecture decisions, and code graph data.
 *
 * Data flows through the existing kageOps preload API — no new IPC channels needed.
 */

import { marked } from 'marked';
import { AGENT_PROFILES } from './agent-profiles';

// ── SVG icons ────────────────────────────────────────
const SVG_SEARCH = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M11 11L13.5 13.5"/></svg>`;
const SVG_DOC    = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2h7l3 3v9H3V2z"/><path d="M10 2v3h3"/><path d="M6 8h5M6 11h4"/></svg>`;
const SVG_OUTPUT = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 8l2 2 3-3.5"/></svg>`;
const SVG_EMPTY  = `<svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h13l9 9v21H9V5z"/><path d="M22 5v9h9"/><path d="M14 20h12M14 25h12M14 30h8"/></svg>`;

// ── Types ────────────────────────────────────────────

export interface KnowledgeBaseApi {
    getProjects(): Promise<readonly ProjectEntry[]>;
    getProjectTasks(projectId: string): Promise<readonly TaskEntry[]>;
    getTaskOutput(taskId: string): Promise<TaskOutputData | null>;
    getProjectDocuments(projectId: string): Promise<readonly DocumentEntry[]>;
    getProjectDocumentContent(
        projectId: string,
        documentId: string,
    ): Promise<{ success: boolean; content?: string; error?: string; mimeType?: string }>;
    getGraphStatuses(): Promise<readonly GraphStatusEntry[]>;
}

interface ProjectEntry {
    readonly id: string;
    readonly name: string;
    readonly phase: string;
    readonly status: string;
    readonly taskCounts: {
        readonly total: number;
        readonly completed: number;
    };
}

interface TaskEntry {
    readonly id: string;
    readonly title: string;
    readonly taskType: string;
    readonly assignedAgent: string | null;
    readonly status: string;
    readonly completedAt: string | null;
    readonly hasOutput: boolean;
}

interface TaskOutputData {
    readonly content: string;
}

interface DocumentEntry {
    readonly id: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly createdAt: string;
}

interface GraphStatusEntry {
    readonly repoPath: string;
    readonly status: string;
    readonly lastUpdated: string | null;
}

// ── Filter Types ────────────────────────────────────

type FilterMode = 'all' | 'documents' | 'outputs' | 'architecture';

interface SidebarItem {
    readonly type: 'document' | 'output';
    readonly id: string;
    readonly label: string;
    readonly agent: string | null;
    readonly timestamp: string | null;
    readonly projectId?: string;
}

// ── Public API ──────────────────────────────────────

export function initKnowledgeBaseView(container: HTMLElement, api: KnowledgeBaseApi): void {
    container.innerHTML = `
        <div class="view-header">
            <h2>Knowledge Base</h2>
            <p class="view-header-sub">Project documents, agent outputs, and architecture artifacts.</p>
        </div>
        <div class="kb-view">
            <div class="kb-toolbar">
                <div class="kb-search-wrap">
                    <span class="kb-search-icon" aria-hidden="true">${SVG_SEARCH}</span>
                    <input class="kb-search-input" id="kb-search" type="text"
                           placeholder="Search documents, outputs, architecture..." autocomplete="off" spellcheck="false"/>
                </div>
                <div class="kb-filters" id="kb-filters">
                    <button class="kb-filter-btn active" data-filter="all">All</button>
                    <button class="kb-filter-btn" data-filter="documents">Docs</button>
                    <button class="kb-filter-btn" data-filter="outputs">Outputs</button>
                    <button class="kb-filter-btn" data-filter="architecture">Architecture</button>
                </div>
            </div>
            <div class="kb-body">
                <div class="kb-sidebar" id="kb-sidebar">
                    <div class="empty-state">Loading projects...</div>
                </div>
                <div class="kb-resize-handle" id="kb-resize-handle"></div>
                <div class="kb-viewer" id="kb-viewer">
                    <div class="kb-viewer-empty">
                        <div class="kb-viewer-empty-icon">${SVG_EMPTY}</div>
                        <p>Select a document from the sidebar to view it</p>
                    </div>
                </div>
            </div>
        </div>`;

    const sidebar = container.querySelector('#kb-sidebar') as HTMLElement;
    const viewer = container.querySelector('#kb-viewer') as HTMLElement;
    const resizeHandle = container.querySelector('#kb-resize-handle') as HTMLElement;
    const searchInput = container.querySelector('#kb-search') as HTMLInputElement;
    const filtersEl = container.querySelector('#kb-filters') as HTMLElement;

    // Drag-to-resize sidebar
    let dragging = false;
    let startX = 0;
    let startWidth = 0;
    resizeHandle.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const delta = e.clientX - startX;
        const newWidth = Math.min(480, Math.max(160, startWidth + delta));
        sidebar.style.width = `${newWidth}px`;
    });
    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });

    let activeFilter: FilterMode = 'all';
    let searchTerm = '';
    let projects: readonly ProjectEntry[] = [];
    let projectItems = new Map<string, readonly SidebarItem[]>();
    let expandedProjects = new Set<string>();

    // Wire filter buttons
    filtersEl.querySelectorAll<HTMLButtonElement>('.kb-filter-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            activeFilter = (btn.dataset['filter'] ?? 'all') as FilterMode;
            filtersEl.querySelectorAll('.kb-filter-btn').forEach((b) => {
                b.classList.toggle('active', b === btn);
            });
            renderSidebar();
        });
    });

    // Wire search
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    searchInput.addEventListener('input', () => {
        if (searchTimer !== null) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            searchTerm = searchInput.value.trim().toLowerCase();
            renderSidebar();
        }, 200);
    });

    void loadProjects();

    // ── Data Loading ────────────────────────────────

    async function loadProjects(): Promise<void> {
        try {
            projects = await api.getProjects();
        } catch {
            projects = [];
        }
        renderSidebar();
    }

    async function loadProjectItems(projectId: string): Promise<void> {
        if (projectItems.has(projectId)) return;

        const [tasksResult, docsResult] = await Promise.allSettled([
            api.getProjectTasks(projectId),
            api.getProjectDocuments(projectId),
        ]);

        const tasks = tasksResult.status === 'fulfilled' ? [...tasksResult.value] : [];
        const docs = docsResult.status === 'fulfilled' ? [...docsResult.value] : [];

        const items: SidebarItem[] = [
            ...docs.map((d): SidebarItem => ({
                type: 'document',
                id: d.id,
                label: d.fileName,
                agent: null,
                timestamp: d.createdAt,
                projectId,
            })),
            ...tasks
                .filter((t) => t.hasOutput)
                .map((t): SidebarItem => ({
                    type: 'output',
                    id: t.id,
                    label: t.title,
                    agent: t.assignedAgent,
                    timestamp: t.completedAt,
                    projectId,
                })),
        ];

        projectItems = new Map([...projectItems, [projectId, items]]);
    }

    // ── Sidebar Rendering ───────────────────────────

    function renderSidebar(): void {
        if (projects.length === 0) {
            sidebar.innerHTML = '<div class="empty-state">No projects found</div>';
            return;
        }

        const filtered = projects.filter((p) => {
            if (searchTerm === '') return true;
            return p.name.toLowerCase().includes(searchTerm);
        });

        if (filtered.length === 0) {
            sidebar.innerHTML = '<div class="empty-state">No matches</div>';
            return;
        }

        sidebar.innerHTML = filtered.map((p) => {
            const isExpanded = expandedProjects.has(p.id);
            const badgeClass = getPhaseBadgeClass(p.phase);
            const items = projectItems.get(p.id) ?? [];
            const filteredItems = filterItems(items);
            const matchesItems = searchTerm !== ''
                ? filteredItems.some((item) => item.label.toLowerCase().includes(searchTerm))
                : true;

            // When searching, auto-expand projects that have matching items
            const showExpanded = isExpanded || (searchTerm !== '' && matchesItems);

            return `
                <div class="kb-project-node" data-project-id="${esc(p.id)}">
                    <div class="kb-project-header" data-project-id="${esc(p.id)}">
                        <span class="kb-expand-icon">${showExpanded ? '&#9660;' : '&#9654;'}</span>
                        <span class="kb-project-name" title="${esc(p.name)}">${esc(p.name)}</span>
                        <span class="kb-phase-badge ${badgeClass}">${esc(p.phase)}</span>
                        <span class="kb-task-count">${p.taskCounts.completed}/${p.taskCounts.total}</span>
                    </div>
                    ${showExpanded ? renderProjectItems(p.id, filteredItems) : ''}
                </div>`;
        }).join('');

        // Wire project header clicks
        sidebar.querySelectorAll<HTMLElement>('.kb-project-header').forEach((header) => {
            header.addEventListener('click', () => {
                const projectId = header.dataset['projectId'] ?? '';
                if (projectId === '') return;
                if (expandedProjects.has(projectId)) {
                    expandedProjects = new Set([...expandedProjects].filter((id) => id !== projectId));
                    renderSidebar();
                } else {
                    expandedProjects = new Set([...expandedProjects, projectId]);
                    void loadProjectItems(projectId).then(() => renderSidebar());
                }
            });
        });

        // Wire item clicks
        sidebar.querySelectorAll<HTMLElement>('.kb-item-row').forEach((row) => {
            row.addEventListener('click', () => {
                const itemId = row.dataset['itemId'] ?? '';
                const itemType = row.dataset['itemType'] ?? '';
                if (itemId === '') return;
                // Mark active
                sidebar.querySelectorAll('.kb-item-row').forEach((r) => r.classList.remove('kb-item--active'));
                row.classList.add('kb-item--active');
                if (itemType === 'output') {
                    void loadTaskOutput(itemId, row.dataset['itemLabel'] ?? '', row.dataset['itemAgent'] ?? null);
                } else {
                    const projectId = row.dataset['itemProject'] ?? '';
                    void loadDocumentContent(projectId, itemId, row.dataset['itemLabel'] ?? '');
                }
            });
        });
    }

    function renderProjectItems(projectId: string, items: readonly SidebarItem[]): string {
        if (items.length === 0) {
            const raw = projectItems.get(projectId);
            if (raw === undefined) {
                return '<div class="kb-items-loading">Loading...</div>';
            }
            return '<div class="kb-items-empty">No items match current filter</div>';
        }

        const docs = items.filter((i) => i.type === 'document');
        const outputs = items.filter((i) => i.type === 'output');

        let html = '<div class="kb-items-list">';

        if (docs.length > 0 && activeFilter !== 'outputs') {
            html += '<div class="kb-items-group-label">Documents</div>';
            html += docs.map((d) => renderItemRow(d)).join('');
        }

        if (outputs.length > 0 && activeFilter !== 'documents') {
            html += '<div class="kb-items-group-label">Task Outputs</div>';
            html += outputs.map((o) => renderItemRow(o)).join('');
        }

        html += '</div>';
        return html;
    }

    function renderItemRow(item: SidebarItem): string {
        const agentColor = item.agent !== null
            ? (AGENT_PROFILES[item.agent.toLowerCase()]?.color ?? 'var(--text-muted)')
            : 'var(--text-muted)';
        const icon = item.type === 'document' ? SVG_DOC : SVG_OUTPUT;
        const label = searchTerm !== '' ? highlightMatch(esc(item.label), searchTerm) : esc(item.label);

        return `
            <div class="kb-item-row" data-item-id="${esc(item.id)}"
                 data-item-type="${item.type}"
                 data-item-label="${esc(item.label)}"
                 data-item-project="${esc(item.projectId ?? '')}"
                 data-item-agent="${item.agent !== null ? esc(item.agent) : ''}">
                <span class="kb-item-icon">${icon}</span>
                <span class="kb-item-label">${label}</span>
                ${item.agent !== null ? `<span class="kb-item-agent" style="color:${agentColor}">${esc(item.agent)}</span>` : ''}
            </div>`;
    }

    function filterItems(items: readonly SidebarItem[]): readonly SidebarItem[] {
        let filtered = items;

        if (activeFilter === 'documents') {
            filtered = items.filter((i) => i.type === 'document');
        } else if (activeFilter === 'outputs') {
            filtered = items.filter((i) => i.type === 'output');
        } else if (activeFilter === 'architecture') {
            filtered = items.filter((i) =>
                i.label.toLowerCase().includes('architect') ||
                i.label.toLowerCase().includes('design') ||
                i.label.toLowerCase().includes('schema') ||
                i.label.toLowerCase().includes('blueprint') ||
                (i.agent !== null && i.agent.toLowerCase() === 'blueprint')
            );
        }

        if (searchTerm !== '') {
            filtered = filtered.filter((i) => i.label.toLowerCase().includes(searchTerm));
        }

        return filtered;
    }

    // ── Viewer Rendering ────────────────────────────

    async function loadTaskOutput(taskId: string, title: string, agent: string | null): Promise<void> {
        viewer.innerHTML = '<div class="kb-viewer-loading">Loading content...</div>';

        try {
            const output = await api.getTaskOutput(taskId);
            if (output === null) {
                viewer.innerHTML = '<div class="kb-viewer-empty"><p>Output not available.</p></div>';
                return;
            }
            renderViewer(title, output.content, agent);
        } catch {
            viewer.innerHTML = '<div class="kb-viewer-empty"><p>Failed to load output.</p></div>';
        }
    }

    async function loadDocumentContent(projectId: string, documentId: string, title: string): Promise<void> {
        if (projectId === '' || documentId === '') {
            showDocumentPlaceholder(title);
            return;
        }
        viewer.innerHTML = '<div class="kb-viewer-loading">Loading content...</div>';
        try {
            const res = await api.getProjectDocumentContent(projectId, documentId);
            if (res.success && typeof res.content === 'string') {
                renderViewer(title, res.content, null);
                return;
            }
            if (!res.success && res.error === 'binary') {
                showDocumentPlaceholder(title);
                return;
            }
            viewer.innerHTML = `<div class="kb-viewer-empty"><p>${esc(res.error ?? 'Failed to load document.')}</p></div>`;
        } catch {
            viewer.innerHTML = '<div class="kb-viewer-empty"><p>Failed to load document.</p></div>';
        }
    }

    function renderViewer(title: string, content: string, agent: string | null): void {
        const agentColor = agent !== null
            ? (AGENT_PROFILES[agent.toLowerCase()]?.color ?? 'var(--accent)')
            : 'var(--accent)';
        const agentProfile = agent !== null ? AGENT_PROFILES[agent.toLowerCase()] : undefined;
        const typeBadge = agent !== null ? 'Task Output' : 'Document';

        viewer.innerHTML = `
            <div class="kb-viewer-content">
                <div class="kb-viewer-header">
                    <div class="kb-viewer-title-row">
                        <h3 class="kb-viewer-title">${esc(title)}</h3>
                        <span class="kb-viewer-type-badge">${esc(typeBadge)}</span>
                    </div>
                    ${agent !== null ? `
                    <div class="kb-viewer-agent" style="color:${agentColor}">
                        ${agentProfile !== undefined ? esc(agentProfile.title) + ' — ' : ''}${esc(agent)}
                    </div>` : ''}
                    <div class="kb-viewer-toggle" id="kb-viewer-toggle">
                        <button class="kb-toggle-btn active" data-view="preview">Preview</button>
                        <button class="kb-toggle-btn" data-view="code">Raw</button>
                    </div>
                </div>
                <div class="kb-viewer-body kb-viewer-body--preview" id="kb-preview"></div>
                <pre class="kb-viewer-body kb-viewer-body--raw" id="kb-raw" style="display:none"></pre>
            </div>`;

        const previewEl = viewer.querySelector('#kb-preview') as HTMLElement;
        const rawEl = viewer.querySelector('#kb-raw') as HTMLElement;
        const toggleEl = viewer.querySelector('#kb-viewer-toggle') as HTMLElement;

        // Render markdown
        const rendered = marked.parse(content, { async: false, gfm: true, breaks: true }) as string;
        previewEl.innerHTML = rendered;
        rawEl.textContent = content;

        // Wire toggle
        toggleEl.querySelectorAll<HTMLButtonElement>('.kb-toggle-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const view = btn.dataset['view'] ?? 'preview';
                toggleEl.querySelectorAll('.kb-toggle-btn').forEach((b) => {
                    b.classList.toggle('active', b === btn);
                });
                if (view === 'code') {
                    previewEl.style.display = 'none';
                    rawEl.style.display = '';
                } else {
                    previewEl.style.display = '';
                    rawEl.style.display = 'none';
                }
            });
        });
    }

    function showDocumentPlaceholder(fileName: string): void {
        viewer.innerHTML = `
            <div class="kb-viewer-content">
                <div class="kb-viewer-header">
                    <div class="kb-viewer-title-row">
                        <h3 class="kb-viewer-title">${esc(fileName)}</h3>
                        <span class="kb-viewer-type-badge">Document</span>
                    </div>
                </div>
                <div class="kb-viewer-body kb-viewer-body--preview">
                    <p class="kb-doc-placeholder">Document preview is available after opening.
                    Binary and non-text documents are stored as attachments.</p>
                </div>
            </div>`;
    }
}

// ── Helpers ─────────────────────────────────────────

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightMatch(escaped: string, term: string): string {
    if (term === '') return escaped;
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedTerm})`, 'gi');
    return escaped.replace(regex, '<mark class="kb-highlight">$1</mark>');
}

function getPhaseBadgeClass(phase: string): string {
    const p = phase.toLowerCase();
    if (p.includes('development') || p.includes('launch')) return 'badge-green';
    if (p.includes('poc') || p.includes('business') || p.includes('viability')) return 'badge-yellow';
    if (p.includes('discovery') || p.includes('design') || p.includes('planning')) return 'badge-blue';
    if (p.includes('fail') || p.includes('error')) return 'badge-red';
    return 'badge-gray';
}
