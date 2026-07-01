/**
 * Panel Resize — custom drag-bar resize for scrollable panel bodies.
 *
 * Native CSS `resize: vertical` puts the handle in the bottom-right corner
 * of the resizable element, which gets occluded by the Sensei sidebar. We
 * inject a full-width drag bar at the bottom edge of each scrollable panel
 * body and persist the chosen height per-panel in localStorage.
 */

const STORAGE_KEY = 'kageops_panel_heights';
const MIN_HEIGHT_PX = 120;
const MAX_HEIGHT_VH = 0.8;

interface HeightMap {
    readonly [panelId: string]: number;
}

function loadHeights(): HeightMap {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return {};
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return {};
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
        }
        return out;
    } catch {
        return {};
    }
}

function saveHeights(map: HeightMap): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch { /* quota / disabled — ignore */ }
}

function clampHeight(px: number): number {
    const max = Math.round(window.innerHeight * MAX_HEIGHT_VH);
    if (px < MIN_HEIGHT_PX) return MIN_HEIGHT_PX;
    if (px > max) return max;
    return Math.round(px);
}

function attachHandle(
    body: HTMLElement,
    panelId: string,
    heights: Record<string, number>,
): void {
    const handle = document.createElement('div');
    handle.className = 'panel-resize-handle';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'horizontal');
    handle.setAttribute('aria-label', `Resize ${panelId} panel`);
    handle.tabIndex = 0;

    body.insertAdjacentElement('afterend', handle);

    let startY = 0;
    let startHeight = 0;

    const onPointerMove = (ev: PointerEvent): void => {
        const dy = ev.clientY - startY;
        const next = clampHeight(startHeight + dy);
        body.style.height = `${next}px`;
    };

    const onPointerUp = (ev: PointerEvent): void => {
        handle.classList.remove('dragging');
        document.body.classList.remove('panel-resizing');
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', onPointerUp);
        handle.removeEventListener('pointercancel', onPointerUp);

        const finalHeight = body.getBoundingClientRect().height;
        heights[panelId] = Math.round(finalHeight);
        saveHeights(heights);
    };

    handle.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        startY = ev.clientY;
        startHeight = body.getBoundingClientRect().height;
        handle.classList.add('dragging');
        document.body.classList.add('panel-resizing');
        handle.setPointerCapture(ev.pointerId);
        handle.addEventListener('pointermove', onPointerMove);
        handle.addEventListener('pointerup', onPointerUp);
        handle.addEventListener('pointercancel', onPointerUp);
    });

    handle.addEventListener('keydown', (ev) => {
        const step = ev.shiftKey ? 40 : 10;
        let next: number | null = null;
        if (ev.key === 'ArrowUp') next = body.getBoundingClientRect().height - step;
        else if (ev.key === 'ArrowDown') next = body.getBoundingClientRect().height + step;
        if (next === null) return;
        ev.preventDefault();
        const clamped = clampHeight(next);
        body.style.height = `${clamped}px`;
        heights[panelId] = clamped;
        saveHeights(heights);
    });

    handle.addEventListener('dblclick', () => {
        body.style.height = '';
        delete heights[panelId];
        saveHeights(heights);
    });
}

export function initPanelResize(): void {
    const stored = loadHeights();
    const heights: Record<string, number> = { ...stored };

    document.querySelectorAll<HTMLElement>('.panel[data-panel] .panel-body--scroll').forEach((body) => {
        const panel = body.closest<HTMLElement>('.panel[data-panel]');
        if (panel === null) return;
        const panelId = panel.dataset['panel'] ?? '';
        if (panelId === '') return;

        const saved = stored[panelId];
        if (saved !== undefined) {
            body.style.height = `${clampHeight(saved)}px`;
        }

        attachHandle(body, panelId, heights);
    });
}
