/**
 * KageOps Team Panel (Phase 3 Sprint 3)
 * Tabs: Members · Projects · Activity
 */

// ── Types ────────────────────────────────────────────────

export interface TeamMember {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly role: string;
    readonly status: string;
    readonly avatar_url: string | null;
    readonly clerk_user_id: string | null;
    readonly created_at: string;
}

export interface ProjectAssignment {
    readonly id: string;
    readonly project_id: string;
    readonly project_name: string;
    readonly project_status: string;
    readonly user_id: string;
    readonly user_name: string;
    readonly user_email: string;
    readonly role: string;
    readonly created_at: string;
}

export interface ActivityEntry {
    readonly id: string;
    readonly actor: string;
    readonly actor_type: 'agent' | 'human';
    readonly action: string;
    readonly project_id: string | null;
    readonly created_at: string;
}

export interface PresenceState {
    readonly [key: string]: ReadonlyArray<{ userId: string; userName: string; onlineAt: string }>;
}

export interface TeamPanelCallbacks {
    getTeamMembers(): Promise<TeamMember[]>;
    addTeamMember(name: string, email: string, role: string): Promise<{ success: boolean; error?: string }>;
    removeTeamMember(id: string): Promise<{ success: boolean; error?: string }>;
    inviteMember(email: string, role: string): Promise<{ success: boolean; error?: string; note?: string }>;
    updateMemberRole(memberId: string, role: string): Promise<{ success: boolean; error?: string }>;
    getProjectAssignments(): Promise<ProjectAssignment[]>;
    assignToProject(projectId: string, userId: string, userName: string, userEmail: string, role: string): Promise<{ success: boolean; error?: string }>;
    removeAssignment(assignmentId: string): Promise<{ success: boolean; error?: string }>;
    getActivityFeed(filter?: 'all' | 'humans' | 'agents'): Promise<ActivityEntry[]>;
    onPresenceUpdate(handler: (state: PresenceState) => void): void;
}

// ── Agent roster (permanent, non-removable) ────────────

const AGENTS: ReadonlyArray<{ name: string; role: string; color: string }> = [
    { name: 'Scout',     role: 'Strategist',     color: '#6366f1' },
    { name: 'Blueprint', role: 'Architect',       color: '#3b82f6' },
    { name: 'Forge',     role: 'Engineer',        color: '#4d9e6f' },
    { name: 'Vigil',     role: 'QA Guardian',     color: '#10b981' },
    { name: 'Aegis',     role: 'Platform Eng.',   color: '#8b5cf6' },
    { name: 'Pixel',     role: 'Designer',        color: '#ec4899' },
    { name: 'Cipher',    role: 'Data Specialist', color: '#06b6d4' },
    { name: 'Herald',    role: 'Marketer',        color: '#f97316' },
];

const AVATAR_COLORS = [
    '#6366f1', '#3b82f6', '#0ea5e9', '#10b981',
    '#f59e0b', '#f97316', '#ec4899', '#8b5cf6',
];

// ── Helpers ───────────────────────────────────────────────

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

function hashColor(name: string): string {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function presenceDot(userId: string | null, presenceState: PresenceState): string {
    if (userId === null) {
        return '<span class="tp-presence-dot tp-offline" title="Offline"></span>';
    }
    const isOnline = Object.values(presenceState).some(arr => arr.some(u => u.userId === userId));
    return `<span class="tp-presence-dot ${isOnline ? 'tp-online' : 'tp-offline'}" title="${isOnline ? 'Online' : 'Offline'}"></span>`;
}

function emptyState(icon: string, title: string, body: string): string {
    return `
        <div class="tp-empty">
            <div class="tp-empty-icon">${icon}</div>
            <div class="tp-empty-title">${esc(title)}</div>
            <div class="tp-empty-body">${esc(body)}</div>
        </div>`;
}

// ── Tab: Members ──────────────────────────────────────────

function renderMembersTab(members: readonly TeamMember[], presence: PresenceState): string {
    const rows = members.map(m => {
        const initial = esc(m.name.charAt(0).toUpperCase());
        const color = hashColor(m.name);
        const dot = presenceDot(m.clerk_user_id, presence);
        return `
        <div class="tp-member-row" data-id="${esc(m.id)}">
            <div class="tp-avatar" style="background:${color}" title="${esc(m.name)}">${initial}</div>
            <div class="tp-member-info">
                <span class="tp-member-name">${esc(m.name)}</span>
                <span class="tp-member-email">${esc(m.email)}</span>
            </div>
            <select class="tp-role-select btn-sm" data-id="${esc(m.id)}" title="Change this member's permission level">
                ${['lead','member','observer'].map(r =>
                    `<option value="${r}" ${m.role === r ? 'selected' : ''}>${r.charAt(0).toUpperCase() + r.slice(1)}</option>`
                ).join('')}
            </select>
            ${dot}
            <button class="tp-remove-btn" data-id="${esc(m.id)}" title="Remove from workspace">×</button>
        </div>`;
    }).join('');

    const listHtml = rows || emptyState('◌', 'No teammates yet', 'Invite a colleague by email to start collaborating.');

    const agentChips = AGENTS.map(a => `
        <div class="tp-agent-chip" title="${esc(a.role)}">
            <span class="tp-agent-dot" style="background:${a.color}"></span>
            <span>${esc(a.name)}</span>
        </div>`).join('');

    return `
        <div class="tp-panel">
            <div class="tp-section-header">
                <span class="tp-count">${members.length} member${members.length !== 1 ? 's' : ''}</span>
                <button class="btn-sm btn-primary" id="btn-invite" title="Send an email invite to join this workspace">
                    + Invite member
                </button>
            </div>

            <div id="invite-card" class="tp-invite-card tp-hidden">
                <div class="tp-invite-title">Invite a teammate</div>
                <div class="tp-invite-grid">
                    <input type="email" id="invite-email"
                        placeholder="colleague@company.com"
                        autocomplete="off"
                        title="They'll receive a sign-up link at this address" />
                    <select id="invite-role" title="Permission level inside this workspace">
                        <option value="member">Member</option>
                        <option value="lead">Lead</option>
                        <option value="observer">Observer — view only</option>
                    </select>
                </div>
                <div class="tp-invite-actions">
                    <button class="btn-sm" id="btn-invite-cancel">Cancel</button>
                    <button class="btn-sm btn-primary" id="btn-invite-send">Send invite</button>
                </div>
                <div class="tp-form-error tp-hidden" id="invite-error"></div>
            </div>

            <div id="members-list" class="tp-list">${listHtml}</div>

            <div class="tp-autonauts-section">
                <div class="tp-autonauts-label"
                     title="AI agents permanently assigned to your workspace — they run autonomously alongside your team and cannot be removed">
                    Autonauts <span class="tp-help-hint">(?)</span>
                </div>
                <div class="tp-agent-grid">${agentChips}</div>
            </div>
        </div>`;
}

// ── Tab: Projects ─────────────────────────────────────────

function renderAssignForm(): string {
    return `
        <div class="tp-invite-card" id="assign-card">
            <div class="tp-invite-title">Assign member to project</div>
            <div class="tp-assign-grid">
                <div class="tp-field">
                    <label class="tp-label">Project ID</label>
                    <input id="assign-project-id" type="text" placeholder="project-uuid"
                        title="The project's UUID — find it in the project detail panel" />
                </div>
                <div class="tp-field">
                    <label class="tp-label">Member</label>
                    <select id="assign-member-id" title="Team member to assign">
                        <option value="">Select member…</option>
                    </select>
                </div>
                <div class="tp-field">
                    <label class="tp-label">Role on project</label>
                    <select id="assign-role" title="Their role on this specific project">
                        <option value="reviewer">Reviewer</option>
                        <option value="owner">Owner</option>
                        <option value="observer">Observer</option>
                    </select>
                </div>
            </div>
            <div class="tp-invite-actions">
                <button class="btn-sm btn-primary" id="btn-assign">Assign</button>
            </div>
            <div class="tp-form-error tp-hidden" id="assign-error"></div>
        </div>`;
}

function renderProjectsTab(assignments: readonly ProjectAssignment[], members: readonly TeamMember[]): string {
    const assignForm = renderAssignForm();

    if (assignments.length === 0) {
        return `
            <div class="tp-panel">
                ${emptyState('◫', 'No project assignments yet', 'Assign a team member to a project using the form below.')}
                ${assignForm}
            </div>`;
    }

    const byProject = new Map<string, ProjectAssignment[]>();
    for (const a of assignments) {
        const arr = byProject.get(a.project_id) ?? [];
        arr.push(a);
        byProject.set(a.project_id, arr);
    }

    const projectCards = [...byProject.entries()].map(([, rows]) => {
        const first = rows[0];
        const statusClass = `tp-status-${esc(first.project_status.toLowerCase())}`;
        const memberRows = rows.map(r => `
            <div class="tp-assignment-row">
                <div class="tp-avatar tp-avatar-sm" style="background:${hashColor(r.user_name)}">${esc(r.user_name.charAt(0).toUpperCase())}</div>
                <span class="tp-member-name">${esc(r.user_name)}</span>
                <span class="tp-member-email">${esc(r.user_email)}</span>
                <span class="tp-role-badge">${esc(r.role)}</span>
                <button class="tp-remove-btn tp-remove-assignment" data-id="${esc(r.id)}" title="Remove from this project">×</button>
            </div>`).join('');

        return `
        <div class="tp-project-card">
            <div class="tp-project-header">
                <span class="tp-project-name">${esc(first.project_name)}</span>
                <span class="tp-status-badge ${statusClass}">${esc(first.project_status)}</span>
            </div>
            <div class="tp-project-members">${memberRows}</div>
        </div>`;
    }).join('');

    // Populate member options for hidden assign form
    const memberOptions = members.map(m =>
        `<option value="${esc(m.id)}" data-name="${esc(m.name)}" data-email="${esc(m.email)}">${esc(m.name)} &lt;${esc(m.email)}&gt;</option>`
    ).join('');

    return `
        <div class="tp-panel">
            ${projectCards}
            <details class="tp-assign-details">
                <summary class="tp-assign-summary">+ Assign member to project</summary>
                <div class="tp-assign-options">${memberOptions}</div>
                ${assignForm}
            </details>
        </div>`;
}

// ── Tab: Activity ─────────────────────────────────────────

function renderActivityTab(feed: readonly ActivityEntry[], activeFilter: 'all' | 'humans' | 'agents'): string {
    const filters = (['all', 'humans', 'agents'] as const).map(f =>
        `<button class="tp-filter-btn ${activeFilter === f ? 'active' : ''}" data-filter="${f}">${f.charAt(0).toUpperCase() + f.slice(1)}</button>`
    ).join('');

    const rows = feed.map(e => {
        const typeClass = e.actor_type === 'agent' ? 'tp-agent-row' : 'tp-human-row';
        return `
        <div class="tp-activity-row ${typeClass}">
            <span class="tp-activity-time" title="${esc(e.created_at)}">${esc(timeAgo(e.created_at))}</span>
            <span class="tp-activity-actor">${esc(e.actor)}</span>
            <span class="tp-activity-action">${esc(e.action)}</span>
        </div>`;
    }).join('');

    const content = rows || emptyState('◎', 'No activity yet', 'Actions by your team and agents will appear here.');

    return `
        <div class="tp-panel">
            <div class="tp-filter-bar">${filters}</div>
            <div id="activity-list" class="tp-activity-list">${content}</div>
        </div>`;
}

// ── Main export ───────────────────────────────────────────

export function renderTeamMembersPanel(
    container: HTMLElement,
    callbacks: TeamPanelCallbacks,
): void {
    let activeTab: 'members' | 'projects' | 'activity' = 'members';
    let members: TeamMember[] = [];
    let assignments: ProjectAssignment[] = [];
    let feed: ActivityEntry[] = [];
    let presence: PresenceState = {};
    let activityFilter: 'all' | 'humans' | 'agents' = 'all';

    function shell(): string {
        return `
            <div class="tp-tab-bar">
                <button class="tp-tab ${activeTab === 'members' ? 'active' : ''}" data-tab="members">Members</button>
                <button class="tp-tab ${activeTab === 'projects' ? 'active' : ''}" data-tab="projects">Projects</button>
                <button class="tp-tab ${activeTab === 'activity' ? 'active' : ''}" data-tab="activity">Activity</button>
            </div>
            <div class="tp-body" id="tp-body"></div>`;
    }

    function renderBody(): void {
        const body = container.querySelector<HTMLElement>('#tp-body');
        if (body === null) return;
        if (activeTab === 'members') {
            body.innerHTML = renderMembersTab(members, presence);
            wireMembers(body);
        } else if (activeTab === 'projects') {
            body.innerHTML = renderProjectsTab(assignments, members);
            wireProjects(body);
        } else {
            body.innerHTML = renderActivityTab(feed, activityFilter);
            wireActivity(body);
        }
    }

    function wireMembers(body: HTMLElement): void {
        body.querySelectorAll<HTMLSelectElement>('.tp-role-select').forEach(sel => {
            sel.addEventListener('change', () => {
                const id = sel.dataset['id'] ?? '';
                void callbacks.updateMemberRole(id, sel.value).then(loadMembers);
            });
        });

        body.querySelectorAll<HTMLButtonElement>('.tp-remove-btn:not(.tp-remove-assignment)').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset['id'] ?? '';
                void callbacks.removeTeamMember(id).then(loadMembers);
            });
        });

        body.querySelector('#btn-invite')?.addEventListener('click', () => {
            body.querySelector('#invite-card')?.classList.toggle('tp-hidden');
        });

        body.querySelector('#btn-invite-cancel')?.addEventListener('click', () => {
            body.querySelector('#invite-card')?.classList.add('tp-hidden');
        });

        body.querySelector('#btn-invite-send')?.addEventListener('click', () => {
            const emailEl = body.querySelector<HTMLInputElement>('#invite-email');
            const roleEl  = body.querySelector<HTMLSelectElement>('#invite-role');
            const errEl   = body.querySelector<HTMLElement>('#invite-error');
            if (emailEl === null || roleEl === null || errEl === null) return;

            const email = emailEl.value.trim();
            if (!email.includes('@')) {
                errEl.textContent = 'Enter a valid email address.';
                errEl.classList.remove('tp-hidden');
                return;
            }
            errEl.classList.add('tp-hidden');
            const sendBtn = body.querySelector<HTMLButtonElement>('#btn-invite-send');
            if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }

            void callbacks.inviteMember(email, roleEl.value).then(result => {
                if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send invite'; }
                if (!result.success) {
                    errEl.textContent = result.error ?? 'Invite failed.';
                    errEl.classList.remove('tp-hidden');
                    return;
                }
                // F-313b: even on success, surface the optional 'note' field
                // (e.g. "Added existing KageOps user — no email sent") and
                // refresh the members list so the new row appears immediately.
                const note = (result as { note?: string }).note;
                if (note !== undefined && note !== '') {
                    errEl.textContent = note;
                    errEl.classList.remove('tp-hidden', 'tp-error');
                    errEl.classList.add('tp-note');
                } else {
                    body.querySelector('#invite-card')?.classList.add('tp-hidden');
                }
                emailEl.value = '';
                void loadMembers();
            });
        });
    }

    function wireProjects(body: HTMLElement): void {
        body.querySelectorAll<HTMLButtonElement>('.tp-remove-assignment').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset['id'] ?? '';
                void callbacks.removeAssignment(id).then(loadAssignments);
            });
        });

        // Populate member select in assign form
        const memberSel = body.querySelector<HTMLSelectElement>('#assign-member-id');
        if (memberSel !== null && memberSel.options.length <= 1) {
            members.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.dataset['name'] = m.name;
                opt.dataset['email'] = m.email;
                opt.textContent = `${m.name} <${m.email}>`;
                memberSel.appendChild(opt);
            });
        }

        body.querySelector('#btn-assign')?.addEventListener('click', () => {
            const projectId = (body.querySelector<HTMLInputElement>('#assign-project-id'))?.value.trim() ?? '';
            const memberOpt = body.querySelector<HTMLSelectElement>('#assign-member-id');
            const role      = (body.querySelector<HTMLSelectElement>('#assign-role'))?.value ?? 'reviewer';
            const errEl     = body.querySelector<HTMLElement>('#assign-error');

            if (projectId === '' || memberOpt === null || memberOpt.value === '') {
                if (errEl) { errEl.textContent = 'Select a project ID and a member.'; errEl.classList.remove('tp-hidden'); }
                return;
            }
            if (errEl) errEl.classList.add('tp-hidden');

            const selectedOpt = memberOpt.options[memberOpt.selectedIndex];
            const userId    = memberOpt.value;
            const userName  = selectedOpt.dataset['name'] ?? '';
            const userEmail = selectedOpt.dataset['email'] ?? '';

            void callbacks.assignToProject(projectId, userId, userName, userEmail, role).then(result => {
                if (!result.success) {
                    if (errEl) { errEl.textContent = result.error ?? 'Assignment failed.'; errEl.classList.remove('tp-hidden'); }
                    return;
                }
                void loadAssignments();
            });
        });
    }

    function wireActivity(body: HTMLElement): void {
        body.querySelectorAll<HTMLButtonElement>('.tp-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                activityFilter = (btn.dataset['filter'] ?? 'all') as typeof activityFilter;
                void loadActivity();
            });
        });
    }

    async function loadMembers(): Promise<void> {
        members = await callbacks.getTeamMembers();
        if (activeTab === 'members') renderBody();
    }

    async function loadAssignments(): Promise<void> {
        assignments = await callbacks.getProjectAssignments();
        if (activeTab === 'projects') renderBody();
    }

    async function loadActivity(): Promise<void> {
        feed = await callbacks.getActivityFeed(activityFilter);
        if (activeTab === 'activity') renderBody();
    }

    // Initial render
    container.innerHTML = shell();

    container.querySelectorAll<HTMLButtonElement>('.tp-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTab = (btn.dataset['tab'] ?? 'members') as typeof activeTab;
            container.querySelectorAll('.tp-tab').forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            renderBody();
            if (activeTab === 'projects') void loadAssignments();
            if (activeTab === 'activity') void loadActivity();
        });
    });

    callbacks.onPresenceUpdate(state => {
        presence = state;
        if (activeTab === 'members') renderBody();
    });

    void loadMembers();
}
