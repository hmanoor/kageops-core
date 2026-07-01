/**
 * KageOps Task Output Panel (v0.9)
 *
 * Shows the list of tasks for a selected project.
 * Clicking a completed task loads its file output inline.
 */

import { icon } from '../../shared/icons';

interface TaskRow {
    id: string;
    title: string;
    task_type: string;
    assigned_agent: string;
    status: string;
    output_path: string | null;
    phase: string;
    priority: number;
}

interface TaskOutput {
    title: string;
    agent: string;
    path: string;
    content: string;
}

interface TaskComment {
    id: string;
    task_id: string;
    author_type: 'human' | 'agent';
    author_name: string;
    body: string;
    created_at: string;
}

interface TaskClaim {
    claimed_by_user_id: string | null;
    claimed_by_user_name: string | null;
    claimed_at: string | null;
}

export interface TaskOutputCallbacks {
    getProjectTasks(projectId: string): Promise<TaskRow[]>;
    getTaskOutput(taskId: string): Promise<TaskOutput | null>;
    getComments?(taskId: string): Promise<TaskComment[]>;
    addComment?(taskId: string, authorType: 'human' | 'agent', authorName: string, body: string): Promise<{ success: boolean; error?: string }>;
    getClaim?(taskId: string): Promise<TaskClaim>;
    claimTask?(taskId: string, userId: string, userName: string): Promise<{ success: boolean; error?: string }>;
    unclaimTask?(taskId: string, userId: string): Promise<{ success: boolean; error?: string }>;
    currentUserId?: string;
    currentUserName?: string;
}

// ── Status badge ──────────────────────────────────────

function statusBadge(status: string): string {
    const map: Record<string, string> = {
        pending:   '<span class="task-badge task-badge--pending">pending</span>',
        assigned:  '<span class="task-badge task-badge--assigned">assigned</span>',
        completed: '<span class="task-badge task-badge--done">done</span>',
        failed:    '<span class="task-badge task-badge--error">failed</span>',
        reviewing: '<span class="task-badge task-badge--assigned">reviewing</span>',
    };
    return map[status] ?? `<span class="task-badge">${status}</span>`;
}

function agentDot(agent: string): string {
    const colours: Record<string, string> = {
        scout: '#f59e0b', blueprint: '#3b82f6', forge: '#8b5cf6',
        vigil: '#22c55e', aegis: '#06b6d4', pixel: '#ec4899',
        cipher: '#f97316', herald: '#a78bfa',
    };
    const c = colours[agent] ?? '#888';
    return `<span class="agent-dot" style="background:${c}" title="${agent}"></span>`;
}

// ── Render ────────────────────────────────────────────

export function renderTaskOutputPanel(
    container: HTMLElement,
    projectId: string,
    projectName: string,
    callbacks: TaskOutputCallbacks
): void {
    container.innerHTML = `
        <div class="task-output-panel">
            <div class="task-output-header">
                <span class="task-output-title">${icon('clipboard', { size: 14 })} ${escHtml(projectName)}</span>
                <button class="task-output-close" id="task-output-close">${icon('x', { size: 14 })}</button>
            </div>
            <div class="task-list-wrap" id="task-list-wrap">
                <div class="empty-state">Loading tasks…</div>
            </div>
            <div class="task-content-wrap" id="task-content-wrap" style="display:none">
                <div class="task-content-nav">
                    <button class="task-back-btn" id="task-back-btn">← Back</button>
                    <span class="task-content-title" id="task-content-title"></span>
                    <div class="task-view-toggle" id="task-view-toggle" style="display:none">
                        <button class="task-toggle-btn active" data-view="code" title="View source code">Code</button>
                        <button class="task-toggle-btn" data-view="preview" title="View rendered preview">Preview</button>
                    </div>
                </div>
                <div class="task-claim-bar" id="task-claim-bar"></div>
                <pre class="task-content-body" id="task-content-body"></pre>
                <iframe class="task-preview-frame" id="task-preview-frame" sandbox="allow-scripts" style="display:none"></iframe>
                <div class="task-comments-section" id="task-comments-section"></div>
            </div>
        </div>`;

    const listWrap = container.querySelector('#task-list-wrap') as HTMLElement;
    const contentWrap = container.querySelector('#task-content-wrap') as HTMLElement;
    const contentTitle = container.querySelector('#task-content-title') as HTMLElement;
    const contentBody = container.querySelector('#task-content-body') as HTMLElement;
    const closeBtn = container.querySelector('#task-output-close') as HTMLButtonElement;
    const backBtn = container.querySelector('#task-back-btn') as HTMLButtonElement;
    const viewToggle = container.querySelector('#task-view-toggle') as HTMLElement;
    const previewFrame = container.querySelector('#task-preview-frame') as HTMLIFrameElement;
    const claimBar = container.querySelector('#task-claim-bar') as HTMLElement;
    const commentsSection = container.querySelector('#task-comments-section') as HTMLElement;

    let currentContent = '';
    let currentView: 'code' | 'preview' = 'code';
    let currentTaskId = '';

    // Wire up code/preview toggle
    viewToggle.querySelectorAll<HTMLButtonElement>('.task-toggle-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const view = (btn.dataset['view'] ?? 'code') as 'code' | 'preview';
            if (view === currentView) return;
            currentView = view;
            viewToggle.querySelectorAll('.task-toggle-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            if (view === 'code') {
                contentBody.style.display = '';
                previewFrame.style.display = 'none';
            } else {
                contentBody.style.display = 'none';
                previewFrame.style.display = '';
                previewFrame.srcdoc = currentContent;
            }
        });
    });

    closeBtn.addEventListener('click', () => {
        container.style.display = 'none';
    });

    backBtn.addEventListener('click', () => {
        contentWrap.style.display = 'none';
        listWrap.style.display = '';
        previewFrame.srcdoc = '';
        currentContent = '';
        viewToggle.style.display = 'none';
    });

    // Load tasks
    void callbacks.getProjectTasks(projectId).then((tasks) => {
        if (tasks.length === 0) {
            listWrap.innerHTML = '<div class="empty-state">No tasks yet.</div>';
            return;
        }

        listWrap.innerHTML = tasks.map((t) => `
            <div class="task-row ${t.status === 'completed' && t.output_path ? 'task-row--clickable' : ''}"
                 data-id="${escAttr(t.id)}"
                 data-has-output="${t.status === 'completed' && t.output_path ? '1' : '0'}">
                <div class="task-row-left">
                    ${agentDot(t.assigned_agent)}
                    <span class="task-row-title">${escHtml(t.title)}</span>
                </div>
                <div class="task-row-right">
                    <span class="task-type-label">${escHtml(t.task_type)}</span>
                    ${statusBadge(t.status)}
                </div>
            </div>`).join('');

        listWrap.querySelectorAll('.task-row--clickable').forEach((el) => {
            (el as HTMLElement).addEventListener('click', () => {
                const taskId = (el as HTMLElement).dataset['id'] ?? '';
                void loadOutput(taskId);
            });
        });
    });

    async function loadOutput(taskId: string): Promise<void> {
        currentTaskId = taskId;
        contentBody.textContent = 'Loading…';
        contentTitle.textContent = '';
        claimBar.innerHTML = '';
        commentsSection.innerHTML = '';
        listWrap.style.display = 'none';
        contentWrap.style.display = '';

        const output = await callbacks.getTaskOutput(taskId);
        if (output === null) {
            contentBody.textContent = 'Output file not found or not yet written.';
        } else {
            contentTitle.textContent = `${output.agent} — ${output.title}`;
            contentBody.textContent = output.content;
            currentContent = output.content;

            const isPreviewable = /\.(html?|svg)$/i.test(output.path) ||
                output.content.trimStart().startsWith('<!DOCTYPE') ||
                output.content.trimStart().startsWith('<html') ||
                output.content.trimStart().startsWith('<svg');
            viewToggle.style.display = isPreviewable ? '' : 'none';

            currentView = 'code';
            contentBody.style.display = '';
            previewFrame.style.display = 'none';
            viewToggle.querySelectorAll('.task-toggle-btn').forEach((b) => {
                b.classList.toggle('active', (b as HTMLElement).dataset['view'] === 'code');
            });
        }

        // Load claim bar and comments in parallel
        void Promise.all([
            loadClaimBar(taskId),
            loadComments(taskId),
        ]);
    }

    async function loadClaimBar(taskId: string): Promise<void> {
        if (callbacks.getClaim === undefined) return;
        const claim = await callbacks.getClaim(taskId);
        const userId = callbacks.currentUserId ?? '';
        const userName = callbacks.currentUserName ?? 'You';

        if (claim.claimed_by_user_id === null) {
            claimBar.innerHTML = `
                <div class="task-claim-bar-inner">
                    <span class="task-claim-status">Unclaimed</span>
                    <button class="btn-sm btn-primary" id="btn-claim-task"
                        title="Take ownership of this task">Claim task</button>
                </div>`;
            claimBar.querySelector('#btn-claim-task')?.addEventListener('click', () => {
                void callbacks.claimTask?.(taskId, userId, userName).then(() => loadClaimBar(taskId));
            });
        } else {
            const isMe = claim.claimed_by_user_id === userId;
            claimBar.innerHTML = `
                <div class="task-claim-bar-inner">
                    <span class="task-claim-status">
                        Claimed by <strong>${escHtml(claim.claimed_by_user_name ?? '')}</strong>
                    </span>
                    ${isMe ? `<button class="btn-sm" id="btn-unclaim-task" title="Release this task">Unclaim</button>` : ''}
                </div>`;
            if (isMe) {
                claimBar.querySelector('#btn-unclaim-task')?.addEventListener('click', () => {
                    void callbacks.unclaimTask?.(taskId, userId).then(() => loadClaimBar(taskId));
                });
            }
        }
    }

    async function loadComments(taskId: string): Promise<void> {
        if (callbacks.getComments === undefined) return;
        const comments = await callbacks.getComments(taskId);
        const userName = callbacks.currentUserName ?? 'You';

        const rows = comments.map(c => {
            const isAgent = c.author_type === 'agent';
            return `
            <div class="task-comment ${isAgent ? 'task-comment--agent' : 'task-comment--human'}">
                <div class="task-comment-header">
                    <span class="task-comment-author">${escHtml(c.author_name)}</span>
                    <span class="task-comment-time">${escHtml(timeAgo(c.created_at))}</span>
                </div>
                <div class="task-comment-body">${escHtml(c.body)}</div>
            </div>`;
        }).join('');

        commentsSection.innerHTML = `
            <div class="task-comments-header">Discussion</div>
            <div class="task-comments-list">${rows || '<div class="task-comments-empty">No comments yet.</div>'}</div>
            <div class="task-comment-form">
                <textarea id="comment-input" placeholder="Leave a note for the agent or your team…" rows="2"></textarea>
                <div class="task-comment-form-actions">
                    <button class="btn-sm btn-primary" id="btn-add-comment">Send</button>
                </div>
            </div>`;

        commentsSection.querySelector('#btn-add-comment')?.addEventListener('click', () => {
            const textarea = commentsSection.querySelector<HTMLTextAreaElement>('#comment-input');
            const body = textarea?.value.trim() ?? '';
            if (!body) return;
            void callbacks.addComment?.(taskId, 'human', userName, body).then(() => {
                if (textarea) textarea.value = '';
                void loadComments(taskId);
            });
        });
    }
}

// ── Helpers ───────────────────────────────────────────

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

// ── Helpers ───────────────────────────────────────────

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s: string): string {
    return s.replace(/"/g, '&quot;');
}
