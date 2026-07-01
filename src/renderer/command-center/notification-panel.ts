/**
 * KageOps Command Center — Notification Center Panel
 *
 * Linear-style two-column inbox (Track D reskin):
 *   · Left 280px item list, newest on top.
 *   · Right pane shows the selected notification's detail.
 *   · Keyboard: arrow up/down moves selection; Enter activates
 *     the selected item (same as click).
 *   · Public API unchanged — only the rendered markup/CSS
 *     classes change, so no IPC or consumer surface is touched.
 *
 * Built with direct DOM APIs (not innerHTML-string assembly) so
 * click/keyboard wiring always has real element handles.
 */

import { icon, type IconName } from '../../shared/icons';

// ── Types ────────────────────────────────────────────

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface NotificationEntry {
    readonly id: string;
    readonly type: NotificationType;
    readonly title: string;
    readonly message: string;
    readonly agent: string | null;
    readonly projectId: string | null;
    /** Display name of the related project — falls back to truncated id. */
    readonly projectName?: string | null;
    /** Original event channel (`task.completed`, `approval.required`, …) so
     *  the detail pane can show approve/reject only on actionable items. */
    readonly eventType?: string | null;
    readonly timestamp: string;
    readonly read: boolean;
}

// ── Type config ─────────────────────────────────────

interface TypeBadge {
    readonly iconName: IconName;
    readonly cssVar: string;
    readonly label: string;
}

const TYPE_CONFIG: Record<NotificationType, TypeBadge> = {
    info:    { iconName: 'info',            cssVar: 'var(--accent)',  label: 'Info' },
    success: { iconName: 'check-circle',    cssVar: 'var(--success)', label: 'Success' },
    warning: { iconName: 'alert-triangle',  cssVar: 'var(--warning)', label: 'Warning' },
    error:   { iconName: 'x-circle',        cssVar: 'var(--error)',   label: 'Error' },
};

// ── Render ───────────────────────────────────────────

/**
 * Render the notification center into the given container.
 * Preserves the exported signature — callers pass a container
 * element and a readonly list of notifications. On empty list we
 * fall through to the `empty-state` class used elsewhere.
 */
export function renderNotificationPanel(
    container: HTMLElement,
    notifications: readonly NotificationEntry[]
): void {
    // Reset host
    container.innerHTML = '';

    if (notifications.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No notifications';
        container.appendChild(empty);
        return;
    }

    const sorted = sortByTimestamp(notifications);
    const unreadCount = sorted.filter((n) => !n.read).length;

    const inbox = document.createElement('div');
    inbox.className = 'notif-inbox';
    inbox.setAttribute('data-selected', sorted[0]?.id ?? '');

    const listCol = buildList(sorted, unreadCount);
    const detailCol = document.createElement('div');
    detailCol.className = 'notif-inbox__detail';
    detailCol.setAttribute('aria-live', 'polite');

    const first = sorted[0] ?? null;
    detailCol.appendChild(buildDetail(first));

    inbox.appendChild(listCol);
    inbox.appendChild(detailCol);
    container.appendChild(inbox);

    wireInteractions(container, sorted);
}

// ── List column ─────────────────────────────────────

function buildList(
    entries: readonly NotificationEntry[],
    unreadCount: number,
): HTMLElement {
    const listCol = document.createElement('div');
    listCol.className = 'notif-inbox__list';
    listCol.setAttribute('role', 'listbox');
    listCol.setAttribute('aria-label', 'Notifications');
    listCol.setAttribute('tabindex', '0');

    const header = document.createElement('div');
    header.className = 'notif-inbox__list-header';

    const title = document.createElement('span');
    title.className = 'notif-inbox__list-title';
    title.textContent = 'Inbox';
    header.appendChild(title);

    if (unreadCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'notif-inbox__unread';
        badge.textContent = String(unreadCount);
        header.appendChild(badge);
    }
    listCol.appendChild(header);

    const items = document.createElement('div');
    items.className = 'notif-inbox__items';
    entries.forEach((entry, idx) => {
        items.appendChild(buildRow(entry, idx === 0));
    });
    listCol.appendChild(items);

    return listCol;
}

function buildRow(entry: NotificationEntry, selected: boolean): HTMLElement {
    const badge = TYPE_CONFIG[entry.type];
    const row = document.createElement('div');
    const classes = ['notif-row'];
    if (!entry.read) classes.push('notif-row--unread');
    if (selected) classes.push('notif-row--selected');
    row.className = classes.join(' ');
    row.setAttribute('data-id', entry.id);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
    row.setAttribute('tabindex', selected ? '0' : '-1');

    const badgeEl = document.createElement('span');
    badgeEl.className = 'notif-row__badge';
    badgeEl.setAttribute('style', `color:${badge.cssVar}`);
    badgeEl.setAttribute('aria-label', badge.label);
    badgeEl.innerHTML = icon(badge.iconName, { size: 14 });
    row.appendChild(badgeEl);

    const body = document.createElement('div');
    body.className = 'notif-row__body';

    const top = document.createElement('div');
    top.className = 'notif-row__top';

    const agent = document.createElement('span');
    if (entry.agent !== null) {
        agent.className = 'notif-row__agent';
        agent.textContent = entry.agent;
    } else {
        agent.className = 'notif-row__agent notif-row__agent--muted';
        agent.textContent = 'System';
    }
    top.appendChild(agent);

    const time = document.createElement('span');
    time.className = 'notif-row__time';
    time.textContent = formatRelativeTime(entry.timestamp);
    top.appendChild(time);
    body.appendChild(top);

    const titleEl = document.createElement('div');
    titleEl.className = 'notif-row__title';
    titleEl.textContent = entry.title;
    body.appendChild(titleEl);

    // Sub-line shows either the project name (most useful at a glance)
    // or a one-line summary — never both, and never the raw `event:*`
    // string that older agent_logs rows still carry.
    const sub = document.createElement('div');
    sub.className = 'notif-row__summary';
    const cleaned = cleanSummary(entry.message);
    const projectLabel = entry.projectName !== undefined && entry.projectName !== null && entry.projectName !== ''
        ? entry.projectName
        : null;
    sub.textContent = projectLabel ?? cleaned;
    body.appendChild(sub);

    row.appendChild(body);
    return row;
}

/** Strip the legacy `event:` prefix and collapse whitespace so the
 *  inbox doesn't show "event:task.completed" as the summary line. */
function cleanSummary(text: string): string {
    if (text === null || text === undefined) return '';
    let s = text.trim();
    if (s.startsWith('event:')) s = s.slice('event:'.length).trim();
    return oneLine(s);
}

// ── Detail pane ─────────────────────────────────────

function buildDetail(entry: NotificationEntry | null): HTMLElement {
    if (entry === null) {
        const empty = document.createElement('div');
        empty.className = 'notif-detail notif-detail--empty';
        empty.textContent = 'Select a notification';
        return empty;
    }

    const badge = TYPE_CONFIG[entry.type];

    const root = document.createElement('div');
    root.className = 'notif-detail';
    root.setAttribute('data-id', entry.id);

    const header = document.createElement('div');
    header.className = 'notif-detail__header';

    const heading = document.createElement('div');
    heading.className = 'notif-detail__heading';

    const badgeEl = document.createElement('span');
    badgeEl.className = 'notif-detail__badge';
    badgeEl.setAttribute('style', `color:${badge.cssVar}`);
    badgeEl.setAttribute('aria-label', badge.label);
    badgeEl.innerHTML = icon(badge.iconName, { size: 18 });
    heading.appendChild(badgeEl);

    const titles = document.createElement('div');
    titles.className = 'notif-detail__titles';

    const titleEl = document.createElement('div');
    titleEl.className = 'notif-detail__title';
    titleEl.textContent = entry.title;
    titles.appendChild(titleEl);

    const sub = document.createElement('div');
    sub.className = 'notif-detail__sub';
    const agentSpan = document.createElement('span');
    agentSpan.className = 'notif-detail__agent';
    agentSpan.textContent = entry.agent ?? 'System';
    sub.appendChild(agentSpan);
    const dot = document.createElement('span');
    dot.className = 'notif-detail__dot';
    dot.textContent = '\u00B7';
    sub.appendChild(dot);
    const timeEl = document.createElement('span');
    timeEl.className = 'notif-detail__time';
    timeEl.setAttribute('title', formatAbsoluteTime(entry.timestamp));
    timeEl.textContent = formatRelativeTime(entry.timestamp);
    sub.appendChild(timeEl);
    if (entry.projectId !== null) {
        const chip = document.createElement('span');
        chip.className = 'notif-detail__chip';
        const label = entry.projectName !== undefined && entry.projectName !== null && entry.projectName !== ''
            ? entry.projectName
            : `${entry.projectId.slice(0, 8)}\u2026`;
        chip.textContent = label;
        chip.setAttribute('title', `Project · ${entry.projectId}`);
        sub.appendChild(chip);
    }
    titles.appendChild(sub);
    heading.appendChild(titles);
    header.appendChild(heading);

    // Approve/Reject only on items the user can actually act on.
    if (entry.eventType === 'approval.required') {
        const actions = document.createElement('div');
        actions.className = 'notif-detail__actions';
        actions.appendChild(buildActionBtn('approve', 'check', 'Approve', 'notif-detail__btn--approve'));
        actions.appendChild(buildActionBtn('reject', 'x', 'Reject', 'notif-detail__btn--reject'));
        header.appendChild(actions);
    }
    root.appendChild(header);

    const body = document.createElement('div');
    body.className = 'notif-detail__body';
    const cleaned = (entry.message ?? '').trim().replace(/^event:/, '').trim();
    const fallback = cleaned !== '' ? cleaned : 'No additional details.';
    const parts = fallback.split(/\n{2,}/).filter((p) => p.trim() !== '');
    const chunks = parts.length > 0 ? parts : [fallback];
    for (const p of chunks) {
        const para = document.createElement('p');
        para.className = 'notif-detail__p';
        para.textContent = p.trim();
        body.appendChild(para);
    }
    root.appendChild(body);
    return root;
}

function buildActionBtn(
    action: 'approve' | 'reject',
    iconName: IconName,
    label: string,
    variantClass: string,
): HTMLElement {
    const btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    btn.className = `notif-detail__btn ${variantClass}`;
    btn.setAttribute('data-action', action);
    const g = document.createElement('span');
    g.className = 'notif-detail__btn-glyph';
    g.setAttribute('aria-hidden', 'true');
    g.innerHTML = icon(iconName, { size: 14 });
    btn.appendChild(g);
    const txt = document.createElement('span');
    txt.textContent = label;
    btn.appendChild(txt);
    return btn;
}

// ── Wiring ──────────────────────────────────────────

function wireInteractions(
    container: HTMLElement,
    entries: readonly NotificationEntry[]
): void {
    const inbox = container.querySelector<HTMLElement>('.notif-inbox');
    const detail = container.querySelector<HTMLElement>('.notif-inbox__detail');
    const list = container.querySelector<HTMLElement>('.notif-inbox__list');
    if (inbox === null || detail === null || list === null) return;

    const rows = Array.from(container.querySelectorAll<HTMLElement>('.notif-row'));
    let selectedIdx = 0;

    function select(idx: number): void {
        if (entries.length === 0) return;
        const bounded = Math.max(0, Math.min(entries.length - 1, idx));
        if (bounded === selectedIdx && rows.length > 0 && detail !== null) {
            // Even if same, ensure current row is marked (used on first mount)
        } else {
            selectedIdx = bounded;
        }
        for (let i = 0; i < rows.length; i += 1) {
            const isSel = i === selectedIdx;
            rows[i].classList.toggle('notif-row--selected', isSel);
            rows[i].setAttribute('aria-selected', isSel ? 'true' : 'false');
            rows[i].tabIndex = isSel ? 0 : -1;
        }
        const picked = entries[selectedIdx];
        if (picked !== undefined && detail !== null) {
            detail.innerHTML = '';
            detail.appendChild(buildDetail(picked));
            inbox?.setAttribute('data-selected', picked.id);
        }
    }

    rows.forEach((row, idx) => {
        row.addEventListener('click', () => select(idx));
    });

    list.addEventListener('keydown', ((ev: KeyboardEvent) => {
        if (ev.key === 'ArrowDown') {
            ev.preventDefault();
            select(selectedIdx + 1);
        } else if (ev.key === 'ArrowUp') {
            ev.preventDefault();
            select(selectedIdx - 1);
        } else if (ev.key === 'Enter') {
            ev.preventDefault();
            select(selectedIdx);
        }
    }) as EventListener);
}

// ── Utilities ────────────────────────────────────────

function sortByTimestamp(
    list: readonly NotificationEntry[]
): readonly NotificationEntry[] {
    return [...list].sort((a, b) => {
        const ta = parseTs(a.timestamp);
        const tb = parseTs(b.timestamp);
        return tb - ta;
    });
}

function parseTs(iso: string): number {
    const n = new Date(iso).getTime();
    return Number.isFinite(n) ? n : 0;
}

function oneLine(text: string): string {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    return trimmed.length > 120 ? `${trimmed.slice(0, 119)}\u2026` : trimmed;
}

function formatRelativeTime(isoString: string): string {
    try {
        const now = Date.now();
        const then = new Date(isoString).getTime();
        if (!Number.isFinite(then)) return '--';
        const diffMs = now - then;

        if (diffMs < 60_000) return 'just now';
        if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
        if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
        return `${Math.floor(diffMs / 86_400_000)}d ago`;
    } catch {
        return '--';
    }
}

function formatAbsoluteTime(isoString: string): string {
    try {
        const d = new Date(isoString);
        if (Number.isNaN(d.getTime())) return isoString;
        return d.toLocaleString();
    } catch {
        return isoString;
    }
}
