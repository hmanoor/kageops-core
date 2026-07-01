/**
 * KageOps Command Center — View Switcher (v2)
 *
 * Manages switching between Command Center views:
 * MC (Mission Control), CH (Chat Hub), KB (Knowledge Base), ID (Identity)
 *
 * Supports lazy initialization — each view's init function is called
 * only on first switch, keeping startup fast.
 */

// ── Types ────────────────────────────────────────────

export type ViewId =
    | 'mc'
    | 'au'
    | 'kb'
    | 'id'
    | 'model-routing'
    | 'cost-intel'
    | 'code-graph'
    | 'github'
    | 'deployments'
    | 'cloud-burst'
    | 'apo'
    | 'team'
    | 'config'
    | 'terminal-hub'
    | 'help'
    | 'board';

// ── State ────────────────────────────────────────────

let currentView: ViewId = 'mc';
const initCallbacks = new Map<ViewId, () => void>();
const initialized = new Set<ViewId>();

// ── Public API ───────────────────────────────────────

/**
 * Register a lazy init callback for a view.
 * Called exactly once, the first time the user switches to that view.
 */
export function registerViewInit(viewId: ViewId, initFn: () => void): void {
    initCallbacks.set(viewId, initFn);
}

/**
 * Initialize the view switcher — wire tab buttons to show/hide views.
 */
export function initViewSwitcher(): void {
    const buttons = document.querySelectorAll<HTMLButtonElement>('.view-btn[data-view]');

    buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const viewId = btn.dataset['view'] as ViewId | undefined;
            if (viewId !== undefined) {
                switchToView(viewId);
            }
        });
    });

    // Mark MC as initialized (it inits at startup)
    initialized.add('mc');
}

/**
 * Switch to a specific view.
 */
export function switchToView(viewId: ViewId): void {
    if (viewId === currentView) return;

    // Hide all view panels
    const panels = document.querySelectorAll<HTMLElement>('.view-panel');
    panels.forEach((panel) => {
        panel.classList.add('hidden');
    });

    // Show the target view
    const target = document.getElementById(`view-${viewId}`);
    if (target !== null) {
        target.classList.remove('hidden');
    }

    // Update tab button active state
    const buttons = document.querySelectorAll<HTMLButtonElement>('.view-btn[data-view]');
    buttons.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset['view'] === viewId);
    });

    currentView = viewId;

    // Lazy init: call the view's init function on first switch
    if (!initialized.has(viewId)) {
        initialized.add(viewId);
        const initFn = initCallbacks.get(viewId);
        if (initFn !== undefined) {
            initFn();
        }
    }
}

/**
 * Get the current active view.
 */
export function getCurrentView(): ViewId {
    return currentView;
}
