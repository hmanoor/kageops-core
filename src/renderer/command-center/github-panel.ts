/**
 * KageOps GitHub Settings Panel
 *
 * Renders the v0.9 GitHub integration settings:
 * - Personal Access Token (stored in OS Keychain)
 * - Per-project owner/repo configuration
 *
 * Browser-safe — no direct Node.js or DB imports.
 */

import { icon } from '../../shared/icons';

// ── Helpers ───────────────────────────────────────────

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Render ────────────────────────────────────────────

export interface GitHubPanelDeps {
    getGitHubStatus(): Promise<{ hasToken: boolean }>;
    setGitHubToken(token: string): Promise<{ success: boolean; error?: string }>;
    setProjectGitHub(projectId: string, owner: string, repo: string): Promise<{ success: boolean; error?: string }>;
    getProjects(): Promise<Array<{ id: string; name: string }>>;
}

/**
 * Render the GitHub settings panel into `container`.
 * Wires up button click handlers using the provided API.
 */
export function renderGitHubPanel(container: HTMLElement, api: GitHubPanelDeps): void {
    container.innerHTML = `
        <div class="github-panel">
            <section class="github-token-section">
                <h3>Personal Access Token</h3>
                <p class="hint">Requires <code>repo</code> and <code>actions</code> scopes.
                   Token stored in OS Keychain — never in plaintext.</p>
                <div class="token-status" id="gh-token-status">Checking…</div>
                <div class="token-input-row">
                    <input type="password" id="gh-token-input" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" autocomplete="off" />
                    <button id="gh-token-save" class="btn btn-primary">Save</button>
                    <button id="gh-token-clear" class="btn btn-danger">Clear</button>
                </div>
                <div class="gh-feedback" id="gh-token-feedback"></div>
            </section>

            <section class="github-project-section">
                <h3>Per-Project Repository</h3>
                <p class="hint">Set the GitHub owner and repo for each project so PRs are auto-created on review.passed.</p>
                <div id="gh-projects-list">Loading projects…</div>
            </section>
        </div>`;

    // Wire token status check
    void loadTokenStatus(container, api);

    // Wire Save button
    const saveBtn = container.querySelector('#gh-token-save') as HTMLButtonElement;
    saveBtn.addEventListener('click', () => void saveToken(container, api));

    // Wire Clear button
    const clearBtn = container.querySelector('#gh-token-clear') as HTMLButtonElement;
    clearBtn.addEventListener('click', () => void clearToken(container, api));

    // Load projects
    void loadProjects(container, api);
}

// ── Token section ─────────────────────────────────────

async function loadTokenStatus(container: HTMLElement, api: GitHubPanelDeps): Promise<void> {
    const statusEl = container.querySelector('#gh-token-status');
    if (statusEl === null) return;

    try {
        const { hasToken } = await api.getGitHubStatus();
        statusEl.innerHTML = hasToken
            ? `<span class="badge badge-green">Token configured ${icon('check', { size: 12 })}</span>`
            : '<span class="badge badge-gray">No token</span>';
    } catch {
        statusEl.textContent = 'Unable to check token status';
    }
}

async function saveToken(container: HTMLElement, api: GitHubPanelDeps): Promise<void> {
    const input = container.querySelector('#gh-token-input') as HTMLInputElement | null;
    const feedback = container.querySelector('#gh-token-feedback') as HTMLElement | null;
    if (input === null || feedback === null) return;

    const token = input.value.trim();
    if (token === '') {
        feedback.textContent = 'Please enter a token.';
        return;
    }

    feedback.textContent = 'Saving…';
    const result = await api.setGitHubToken(token);
    if (result.success) {
        input.value = '';
        feedback.textContent = '';
        void loadTokenStatus(container, api);
    } else {
        feedback.textContent = `Error: ${escapeHtml(result.error ?? 'Unknown error')}`;
    }
}

async function clearToken(container: HTMLElement, api: GitHubPanelDeps): Promise<void> {
    const feedback = container.querySelector('#gh-token-feedback') as HTMLElement | null;
    if (feedback === null) return;

    const result = await api.setGitHubToken('');
    feedback.textContent = result.success ? 'Token cleared.' : `Error: ${result.error ?? ''}`;
    void loadTokenStatus(container, api);
}

// ── Projects section ──────────────────────────────────

async function loadProjects(container: HTMLElement, api: GitHubPanelDeps): Promise<void> {
    const listEl = container.querySelector('#gh-projects-list') as HTMLElement | null;
    if (listEl === null) return;

    let projects: Array<{ id: string; name: string }>;
    try {
        projects = await api.getProjects();
    } catch {
        listEl.textContent = 'Failed to load projects.';
        return;
    }

    if (projects.length === 0) {
        listEl.innerHTML = '<p class="hint">No projects yet.</p>';
        return;
    }

    const rows = projects.map((p) => `
        <div class="gh-project-row" data-project-id="${escapeHtml(p.id)}">
            <span class="project-name">${escapeHtml(p.name)}</span>
            <input type="text" class="gh-owner-input" placeholder="owner" />
            <span class="gh-slash">/</span>
            <input type="text" class="gh-repo-input" placeholder="repo" />
            <button class="btn btn-sm gh-save-project">Save</button>
            <span class="gh-project-feedback"></span>
        </div>`).join('');

    listEl.innerHTML = rows;

    // Wire save buttons
    listEl.querySelectorAll('.gh-save-project').forEach((btn) => {
        btn.addEventListener('click', () => {
            const row = btn.closest('.gh-project-row') as HTMLElement;
            const projectId = row.dataset['projectId'] ?? '';
            const owner = (row.querySelector('.gh-owner-input') as HTMLInputElement).value.trim();
            const repo = (row.querySelector('.gh-repo-input') as HTMLInputElement).value.trim();
            const feedback = row.querySelector('.gh-project-feedback') as HTMLElement;

            void api.setProjectGitHub(projectId, owner, repo).then((result) => {
                feedback.innerHTML = result.success
                    ? `Saved ${icon('check', { size: 12 })}`
                    : `Error: ${escapeHtml(result.error ?? '')}`;
            });
        });
    });
}
