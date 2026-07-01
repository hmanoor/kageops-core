/**
 * KageOps Command Center — Activity Bar (Track C)
 *
 * VS Code-inspired vertical left rail. Icon-only buttons, tooltips on
 * hover, active-state bar on the left edge in --accent. Owns no panel
 * state — fires `onSelect(viewId)` callbacks to the shell controller.
 *
 * Keep this file < 300 lines.
 */

import { icon, type IconName } from '../../shared/icons';

// ── Public types ────────────────────────────────────────

/**
 * A single activity-bar entry. `id` is the logical view key the shell
 * controller will route to its existing switcher; it does not have to
 * correspond to a DOM id.
 */
export interface ActivityBarView {
    readonly id: string;
    readonly label: string;
    readonly icon: IconName;
    /** Optional bottom-anchored entry (e.g. Config). */
    readonly position?: 'top' | 'bottom';
}

export interface ActivityBarOptions {
    readonly views: readonly ActivityBarView[];
    readonly onSelect: (viewId: string) => void;
    readonly initialActive?: string;
}

export interface ActivityBarHandle {
    readonly element: HTMLElement;
    setActive(viewId: string): void;
    setBadge(viewId: string, count: number): void;
}

// ── Implementation ──────────────────────────────────────

export function initActivityBar(
    container: HTMLElement,
    opts: ActivityBarOptions,
): ActivityBarHandle {
    const nav = document.createElement('nav');
    nav.className = 'activity-bar';
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'Primary navigation');

    const topGroup = document.createElement('div');
    topGroup.className = 'activity-bar__group activity-bar__group--top';

    const bottomGroup = document.createElement('div');
    bottomGroup.className = 'activity-bar__group activity-bar__group--bottom';

    const buttons = new Map<string, HTMLButtonElement>();
    const badges = new Map<string, HTMLSpanElement>();

    for (const view of opts.views) {
        const btn = buildButton(view, opts);
        buttons.set(view.id, btn.element);
        badges.set(view.id, btn.badge);

        if (view.position === 'bottom') {
            bottomGroup.appendChild(btn.element);
        } else {
            topGroup.appendChild(btn.element);
        }
    }

    nav.appendChild(topGroup);
    nav.appendChild(bottomGroup);
    container.appendChild(nav);

    function setActive(viewId: string): void {
        buttons.forEach((btn, id) => {
            const active = id === viewId;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
            btn.tabIndex = active ? 0 : -1;
        });
    }

    function setBadge(viewId: string, count: number): void {
        const badge = badges.get(viewId);
        if (badge === undefined) return;
        if (count <= 0) {
            badge.textContent = '';
            badge.dataset['count'] = '0';
            badge.hidden = true;
            return;
        }
        badge.hidden = false;
        badge.dataset['count'] = String(count);
        badge.textContent = count > 99 ? '99+' : String(count);
    }

    // Keyboard navigation along the rail (VS Code style: up/down cycles).
    nav.addEventListener('keydown', (ev) => handleKeydown(ev, buttons, opts));

    const initial = opts.initialActive ?? opts.views[0]?.id;
    if (initial !== undefined) {
        setActive(initial);
    }

    return {
        element: nav,
        setActive,
        setBadge,
    };
}

// ── Internals ───────────────────────────────────────────

interface ButtonResult {
    readonly element: HTMLButtonElement;
    readonly badge: HTMLSpanElement;
}

function buildButton(
    view: ActivityBarView,
    opts: ActivityBarOptions,
): ButtonResult {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'activity-bar__btn';
    btn.dataset['viewId'] = view.id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('aria-label', view.label);
    btn.tabIndex = -1;

    const iconWrap = document.createElement('span');
    iconWrap.className = 'activity-bar__icon';
    iconWrap.innerHTML = icon(view.icon, { size: 20 });

    const badge = document.createElement('span');
    badge.className = 'activity-bar__badge';
    badge.hidden = true;
    badge.setAttribute('aria-hidden', 'true');

    const tooltip = document.createElement('span');
    tooltip.className = 'activity-bar__tooltip';
    tooltip.textContent = view.label;

    const indicator = document.createElement('span');
    indicator.className = 'activity-bar__indicator';
    indicator.setAttribute('aria-hidden', 'true');

    btn.appendChild(indicator);
    btn.appendChild(iconWrap);
    btn.appendChild(badge);
    btn.appendChild(tooltip);

    btn.addEventListener('click', () => {
        try {
            opts.onSelect(view.id);
        } catch (err) {
            console.error(
                '[ActivityBar] onSelect threw for',
                view.id,
                ':',
                err instanceof Error ? err.message : String(err),
            );
        }
    });

    return { element: btn, badge };
}

function handleKeydown(
    ev: KeyboardEvent,
    buttons: Map<string, HTMLButtonElement>,
    opts: ActivityBarOptions,
): void {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;

    const ordered = Array.from(buttons.entries());
    const active = document.activeElement;
    const idx = ordered.findIndex(([, btn]) => btn === active);
    if (idx < 0) return;

    const dir = ev.key === 'ArrowDown' ? 1 : -1;
    const next = (idx + dir + ordered.length) % ordered.length;
    const entry = ordered[next];
    if (entry === undefined) return;

    const [nextId, nextBtn] = entry;
    ev.preventDefault();
    nextBtn.focus();
    try {
        opts.onSelect(nextId);
    } catch (err) {
        console.error(
            '[ActivityBar] keyboard onSelect threw for',
            nextId,
            ':',
            err instanceof Error ? err.message : String(err),
        );
    }
}
