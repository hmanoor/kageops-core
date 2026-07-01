/**
 * KageOps — Notification Inbox (Track D reskin) unit tests
 *
 * Uses a minimal jsdom-free DOM patch. The production module
 * builds the tree with document.createElement + appendChild (no
 * innerHTML parsing), so our FakeEl only needs to mirror those
 * primitives plus dataset/setAttribute/addEventListener and a
 * shallow querySelector that walks childNodes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    renderNotificationPanel,
    type NotificationEntry,
} from '../../src/renderer/command-center/notification-panel';

// ── Minimal fake DOM ─────────────────────────────────────────

interface Listener {
    readonly type: string;
    readonly fn: (ev?: unknown) => void;
}

class FakeEl {
    tagName: string;
    className = '';
    innerHTML = '';
    textContent = '';
    tabIndex = -1;
    readonly childNodes: FakeEl[] = [];
    parentElement: FakeEl | null = null;
    readonly dataset: Record<string, string> = {};
    readonly attributes: Record<string, string> = {};
    private readonly listeners: Listener[] = [];

    constructor(tag: string) {
        this.tagName = tag;
    }

    get firstChild(): FakeEl | null {
        return this.childNodes[0] ?? null;
    }
    get children(): readonly FakeEl[] {
        return this.childNodes;
    }
    get classList(): {
        add(n: string): void;
        remove(n: string): void;
        contains(n: string): boolean;
        toggle(n: string, force?: boolean): void;
    } {
        const self = this;
        const parse = (): Set<string> =>
            new Set(self.className.split(/\s+/).filter(Boolean));
        const commit = (set: Set<string>): void => {
            self.className = Array.from(set).join(' ');
        };
        return {
            add: (n) => {
                const s = parse();
                s.add(n);
                commit(s);
            },
            remove: (n) => {
                const s = parse();
                s.delete(n);
                commit(s);
            },
            contains: (n) => parse().has(n),
            toggle: (n, force) => {
                const s = parse();
                const want = force ?? !s.has(n);
                if (want) s.add(n);
                else s.delete(n);
                commit(s);
            },
        };
    }
    setAttribute(n: string, v: string): void {
        this.attributes[n] = v;
    }
    getAttribute(n: string): string | null {
        return this.attributes[n] ?? null;
    }
    appendChild(c: FakeEl): FakeEl {
        c.parentElement = this;
        this.childNodes.push(c);
        return c;
    }
    removeChild(c: FakeEl): FakeEl {
        const i = this.childNodes.indexOf(c);
        if (i !== -1) {
            this.childNodes.splice(i, 1);
            c.parentElement = null;
        }
        return c;
    }
    addEventListener(type: string, fn: (ev?: unknown) => void): void {
        this.listeners.push({ type, fn });
    }
    trigger(type: string, ev?: unknown): void {
        for (const l of this.listeners) {
            if (l.type === type) l.fn(ev);
        }
    }
    scrollIntoView(_opts?: unknown): void { /* noop */ }

    querySelectorAll<T = FakeEl>(selector: string): T[] {
        const want = selector.trim();
        const results: FakeEl[] = [];
        const walk = (node: FakeEl): void => {
            if (matchesSingle(node, want)) results.push(node);
            for (const c of node.childNodes) walk(c);
        };
        for (const c of this.childNodes) walk(c);
        return results as unknown as T[];
    }
    querySelector<T = FakeEl>(selector: string): T | null {
        const list = this.querySelectorAll<T>(selector);
        return list[0] ?? null;
    }
}

function matchesSingle(node: FakeEl, selector: string): boolean {
    if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        return node.className.split(/\s+/).includes(cls);
    }
    if (selector.startsWith('[')) {
        const match = /^\[([^=\]]+)="([^"]*)"\]$/.exec(selector);
        if (match === null) return false;
        return node.attributes[match[1]] === match[2];
    }
    return node.tagName.toLowerCase() === selector.toLowerCase();
}

function installFakeDom(): { body: FakeEl; restore: () => void } {
    const body = new FakeEl('body');
    const orig = (globalThis as { document?: unknown }).document;
    (globalThis as Record<string, unknown>)['document'] = {
        createElement: (tag: string) => new FakeEl(tag),
        body,
    };
    return {
        body,
        restore: () => {
            (globalThis as Record<string, unknown>)['document'] = orig as unknown;
        },
    };
}

/** Recursively stringify text content of a FakeEl tree. */
function flatText(node: FakeEl): string {
    const own = node.textContent;
    const kids = node.childNodes.map(flatText).join(' ');
    return `${own} ${kids}`.trim();
}

// ── Fixtures ────────────────────────────────────────────────

function entry(
    partial: Partial<NotificationEntry> & Pick<NotificationEntry, 'id' | 'title'>,
): NotificationEntry {
    return {
        type: 'info',
        message: 'Body text for this notification',
        agent: 'Sensei',
        projectId: null,
        timestamp: new Date().toISOString(),
        read: false,
        ...partial,
    };
}

// ── Tests ────────────────────────────────────────────────────

describe('notification-panel — empty state', () => {
    let dom: ReturnType<typeof installFakeDom>;
    beforeEach(() => {
        dom = installFakeDom();
    });
    afterEach(() => dom.restore());

    it('renders an empty-state card when list is empty', () => {
        const host = new FakeEl('div');
        renderNotificationPanel(host as unknown as HTMLElement, []);
        const empty = host.querySelector<FakeEl>('.empty-state');
        expect(empty).not.toBeNull();
        expect(empty!.textContent).toBe('No notifications');
    });
});

describe('notification-panel — two-column shell', () => {
    let dom: ReturnType<typeof installFakeDom>;
    beforeEach(() => {
        dom = installFakeDom();
    });
    afterEach(() => dom.restore());

    it('renders a list column and a detail column', () => {
        const host = new FakeEl('div');
        renderNotificationPanel(host as unknown as HTMLElement, [
            entry({ id: 'n1', title: 'First' }),
            entry({ id: 'n2', title: 'Second' }),
        ]);
        expect(host.querySelector<FakeEl>('.notif-inbox__list')).not.toBeNull();
        expect(host.querySelector<FakeEl>('.notif-inbox__detail')).not.toBeNull();
    });

    it('shows an unread badge when there are unread notifications', () => {
        const host = new FakeEl('div');
        renderNotificationPanel(host as unknown as HTMLElement, [
            entry({ id: 'n1', title: 'a', read: false }),
            entry({ id: 'n2', title: 'b', read: true }),
        ]);
        const badge = host.querySelector<FakeEl>('.notif-inbox__unread');
        expect(badge).not.toBeNull();
        expect(badge!.textContent).toBe('1');
    });

    it('does not show an unread badge when all are read', () => {
        const host = new FakeEl('div');
        renderNotificationPanel(host as unknown as HTMLElement, [
            entry({ id: 'n1', title: 'a', read: true }),
            entry({ id: 'n2', title: 'b', read: true }),
        ]);
        expect(host.querySelector<FakeEl>('.notif-inbox__unread')).toBeNull();
    });
});

describe('notification-panel — sorting and selection', () => {
    let dom: ReturnType<typeof installFakeDom>;
    beforeEach(() => {
        dom = installFakeDom();
    });
    afterEach(() => dom.restore());

    it('sorts newest first and marks the top row selected', () => {
        const older = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const newer = new Date(Date.now() - 60 * 1000).toISOString();
        const host = new FakeEl('div');
        renderNotificationPanel(host as unknown as HTMLElement, [
            entry({ id: 'old', title: 'Old one', timestamp: older }),
            entry({ id: 'new', title: 'New one', timestamp: newer }),
        ]);
        const rows = host.querySelectorAll<FakeEl>('.notif-row');
        expect(rows).toHaveLength(2);
        expect(rows[0].attributes['data-id']).toBe('new');
        expect(rows[0].className).toContain('notif-row--selected');
        expect(rows[1].className).not.toContain('notif-row--selected');
    });

    it('escapes HTML in title (uses textContent, not innerHTML)', () => {
        const host = new FakeEl('div');
        renderNotificationPanel(host as unknown as HTMLElement, [
            entry({ id: 'x', title: '<b>danger</b>', message: '<script>alert(1)</script>' }),
        ]);
        const title = host.querySelector<FakeEl>('.notif-row__title');
        expect(title).not.toBeNull();
        // textContent preserves the raw string; no HTML parsing happens.
        expect(title!.textContent).toBe('<b>danger</b>');
        const summary = host.querySelector<FakeEl>('.notif-row__summary');
        expect(summary).not.toBeNull();
        expect(summary!.textContent).toContain('<script>');
    });

    it('clicking a row re-renders the detail pane for that entry', () => {
        const host = new FakeEl('div');
        renderNotificationPanel(host as unknown as HTMLElement, [
            entry({ id: 'a', title: 'Alpha' }),
            entry({
                id: 'b',
                title: 'Bravo',
                message: 'Bravo body',
                timestamp: new Date(Date.now() - 60_000).toISOString(),
            }),
        ]);
        const rows = host.querySelectorAll<FakeEl>('.notif-row');
        expect(rows).toHaveLength(2);
        // First row is most recent (Alpha ts=now); click the second (Bravo).
        rows[1].trigger('click');
        const detail = host.querySelector<FakeEl>('.notif-inbox__detail');
        expect(detail).not.toBeNull();
        expect(flatText(detail!)).toContain('Bravo');
        expect(flatText(detail!)).toContain('Bravo body');
    });

    it('ArrowDown on the list moves selection and ArrowUp reverses it', () => {
        const host = new FakeEl('div');
        renderNotificationPanel(host as unknown as HTMLElement, [
            entry({ id: 'a', title: 'Alpha' }),
            entry({
                id: 'b',
                title: 'Bravo',
                timestamp: new Date(Date.now() - 60_000).toISOString(),
            }),
            entry({
                id: 'c',
                title: 'Charlie',
                timestamp: new Date(Date.now() - 120_000).toISOString(),
            }),
        ]);
        const list = host.querySelector<FakeEl>('.notif-inbox__list');
        expect(list).not.toBeNull();
        const preventDefault = (): void => { /* ignored */ };
        list!.trigger('keydown', { key: 'ArrowDown', preventDefault });
        const rows = host.querySelectorAll<FakeEl>('.notif-row');
        expect(rows[1].className).toContain('notif-row--selected');
        list!.trigger('keydown', { key: 'ArrowUp', preventDefault });
        expect(rows[0].className).toContain('notif-row--selected');
    });
});

describe('notification-panel — detail pane', () => {
    let dom: ReturnType<typeof installFakeDom>;
    beforeEach(() => {
        dom = installFakeDom();
    });
    afterEach(() => dom.restore());

    it('renders approve and reject action buttons for approval.required entries', () => {
        const host = new FakeEl('div');
        renderNotificationPanel(host as unknown as HTMLElement, [
            entry({ id: 'x', title: 'Something', eventType: 'approval.required' }),
        ]);
        expect(host.querySelector<FakeEl>('[data-action="approve"]')).not.toBeNull();
        expect(host.querySelector<FakeEl>('[data-action="reject"]')).not.toBeNull();
    });

    it('renders a project chip when projectId is set', () => {
        const host = new FakeEl('div');
        renderNotificationPanel(host as unknown as HTMLElement, [
            entry({ id: 'x', title: 'Something', projectId: 'proj-123' }),
        ]);
        const chip = host.querySelector<FakeEl>('.notif-detail__chip');
        expect(chip).not.toBeNull();
        expect(chip!.textContent).toContain('proj-123');
    });

    it('marks System when agent is null', () => {
        const host = new FakeEl('div');
        renderNotificationPanel(host as unknown as HTMLElement, [
            entry({ id: 'x', title: 'Something', agent: null }),
        ]);
        const agent = host.querySelector<FakeEl>('.notif-detail__agent');
        expect(agent).not.toBeNull();
        expect(agent!.textContent).toBe('System');
    });
});
