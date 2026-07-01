/**
 * KageOps Command Center — APO Rollback Panel (B-478)
 *
 * Lists `.apo-backup-<ts>.json` snapshots left by APO winner-application and
 * lets an operator restore any one of them. Restoring also snapshots the
 * pre-rollback preset, so the action stays reversible.
 */

// ── Types ────────────────────────────────────────────

export interface ApoBackupEntry {
    readonly backupPath: string;
    readonly presetPath: string;
    readonly timestamp: number;
    readonly createdAt: string;
    readonly size: number;
    readonly agentsWithOverrides: readonly string[];
}

export interface ApoRollbackPanelCallbacks {
    listApoBackups(): Promise<{
        success: boolean;
        error?: string;
        entries: readonly ApoBackupEntry[];
    }>;
    restoreApoBackup(backupPath: string): Promise<{
        success: boolean;
        error?: string;
    }>;
}

// ── Public API ───────────────────────────────────────

export function renderApoRollbackPanel(
    container: HTMLElement,
    callbacks: ApoRollbackPanelCallbacks
): void {
    container.innerHTML = '<div class="empty-state">Loading APO backups…</div>';
    void loadAndRender(container, callbacks);
}

// ── Load & Render ────────────────────────────────────

async function loadAndRender(
    container: HTMLElement,
    callbacks: ApoRollbackPanelCallbacks
): Promise<void> {
    let payload: {
        success: boolean;
        error?: string;
        entries: readonly ApoBackupEntry[];
    };
    try {
        payload = await callbacks.listApoBackups();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        container.innerHTML = `<div class="empty-state">Failed to load backups: ${escapeHtml(msg)}</div>`;
        return;
    }

    if (!payload.success) {
        container.innerHTML = `<div class="empty-state">Failed to load backups: ${escapeHtml(payload.error ?? 'unknown error')}</div>`;
        return;
    }

    container.innerHTML = buildPanelHtml(payload.entries);
    wireInteractions(container, payload.entries, callbacks);
}

// ── HTML Builders (exported for tests) ───────────────

export function buildApoRollbackHtml(entries: readonly ApoBackupEntry[]): string {
    return buildPanelHtml(entries);
}

function buildPanelHtml(entries: readonly ApoBackupEntry[]): string {
    const content =
        entries.length > 0
            ? buildTableHtml(entries)
            : '<div class="empty-state">No APO backups yet. Accept an optimization to create one.</div>';

    return `
        <div class="apo-rollback-panel">
            <div class="apo-rollback-toolbar">
                <div class="apo-rollback-heading">APO Rollback</div>
                <button class="btn-sm btn-refresh-apo-backups" title="Refresh list">Refresh</button>
            </div>
            <div class="apo-rollback-status hidden" id="apo-rollback-status"></div>
            <div class="apo-rollback-table-wrapper">
                ${content}
            </div>
        </div>
    `;
}

function buildTableHtml(entries: readonly ApoBackupEntry[]): string {
    const rows = entries.map((e) => buildTableRow(e)).join('');
    return `
        <table class="data-table apo-rollback-table">
            <thead>
                <tr>
                    <th>Created</th>
                    <th>Agents</th>
                    <th>Size</th>
                    <th>Backup File</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
    `;
}

function buildTableRow(entry: ApoBackupEntry): string {
    const agents =
        entry.agentsWithOverrides.length > 0
            ? entry.agentsWithOverrides
                  .map((a) => `<span class="agent-badge agent-badge--${escapeAttr(a)}">${escapeHtml(a)}</span>`)
                  .join(' ')
            : '<span class="agent-badge agent-badge--none">none</span>';

    const basename = extractBasename(entry.backupPath);

    return `
        <tr class="apo-backup-row" data-backup-path="${escapeAttr(entry.backupPath)}">
            <td class="apo-backup-created" title="${escapeAttr(entry.createdAt)}">${escapeHtml(formatRelative(entry.timestamp))}</td>
            <td class="apo-backup-agents">${agents}</td>
            <td class="apo-backup-size">${formatSize(entry.size)}</td>
            <td class="apo-backup-path" title="${escapeAttr(entry.backupPath)}">${escapeHtml(basename)}</td>
            <td class="apo-backup-actions">
                <button class="btn-sm btn-primary btn-restore-apo-backup" data-backup-path="${escapeAttr(entry.backupPath)}">Restore</button>
            </td>
        </tr>
    `;
}

// ── Interactions ─────────────────────────────────────

function wireInteractions(
    container: HTMLElement,
    _entries: readonly ApoBackupEntry[],
    callbacks: ApoRollbackPanelCallbacks
): void {
    const refreshBtn = container.querySelector<HTMLButtonElement>('.btn-refresh-apo-backups');
    refreshBtn?.addEventListener('click', () => {
        void loadAndRender(container, callbacks);
    });

    container
        .querySelectorAll<HTMLButtonElement>('.btn-restore-apo-backup')
        .forEach((btn) => {
            btn.addEventListener('click', () => {
                const backupPath = btn.dataset['backupPath'];
                if (backupPath === undefined || backupPath === '') return;
                if (
                    window.confirm(
                        'Restore this APO backup? The current preset will be snapshotted first so this is reversible.'
                    )
                ) {
                    void handleRestore(container, backupPath, btn, callbacks);
                }
            });
        });
}

async function handleRestore(
    container: HTMLElement,
    backupPath: string,
    btn: HTMLButtonElement,
    callbacks: ApoRollbackPanelCallbacks
): Promise<void> {
    const originalLabel = btn.textContent ?? 'Restore';
    btn.disabled = true;
    btn.textContent = 'Restoring…';
    clearStatus(container);
    try {
        const result = await callbacks.restoreApoBackup(backupPath);
        if (result.success) {
            showStatus(
                container,
                'Backup restored. A snapshot of the previous preset was saved as a new apo-rollback-backup.',
                'success'
            );
            await loadAndRender(container, callbacks);
        } else {
            showStatus(container, result.error ?? 'Restore failed', 'error');
            btn.disabled = false;
            btn.textContent = originalLabel;
        }
    } catch (err) {
        showStatus(container, err instanceof Error ? err.message : String(err), 'error');
        btn.disabled = false;
        btn.textContent = originalLabel;
    }
}

// ── Helpers ──────────────────────────────────────────

function showStatus(
    container: HTMLElement,
    message: string,
    kind: 'success' | 'error'
): void {
    const el = container.querySelector<HTMLElement>('#apo-rollback-status');
    if (el === null) return;
    el.textContent = message;
    el.className = `apo-rollback-status apo-rollback-status--${kind}`;
}

function clearStatus(container: HTMLElement): void {
    const el = container.querySelector<HTMLElement>('#apo-rollback-status');
    if (el === null) return;
    el.textContent = '';
    el.className = 'apo-rollback-status hidden';
}

export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatRelative(timestamp: number, now: number = Date.now()): string {
    const diffMs = now - timestamp;
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)}d ago`;
    return new Date(timestamp).toISOString().slice(0, 10);
}

export function extractBasename(p: string): string {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx >= 0 ? p.slice(idx + 1) : p;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(text: string): string {
    return escapeHtml(text);
}
