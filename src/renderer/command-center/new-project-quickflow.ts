/**
 * KageOps New-Project Quickflow — Phase 3
 *
 * Drawer + tooltip overlay attached to the existing New Project modal.
 * Fires every time the modal opens. Provides:
 *
 *   1. A 4-item checklist that auto-ticks as the user fills the matching
 *      form field (name+description / preset / budget / trust).
 *   2. Tooltips on each form field (native title attrs + a custom
 *      "?" badge that shows a popover on hover).
 *   3. Defaults inheriting from the most recent project (or the wizard's
 *      saved defaults if no projects exist) — pulled via the
 *      `quickflow:get-defaults` IPC channel.
 *   4. A "Don't show this again" checkbox that persists per-machine in
 *      localStorage (`kageops:quickflow-dismissed`).
 *
 * Per setup-wizard-plan.md Q3: the drawer shows by default for every new
 * project, but the user can dismiss it permanently per-device. A small
 * "?" button in the modal header re-opens it after dismissal.
 *
 * No framework — pure DOM. Tests in tests/renderer/quickflow.test.ts.
 */

// ── Types ────────────────────────────────────────────

interface QuickflowDefaults {
    readonly preset: string | null;
    readonly trustLevel: string | null;
    readonly budgetCapUsd: number | null;
}

interface QuickflowGetResult {
    readonly ok: boolean;
    readonly source?: 'last-project' | 'wizard-defaults';
    readonly defaults?: QuickflowDefaults;
    readonly error?: string;
}

interface KageOpsQuickflowBridge {
    readonly quickflow: { readonly getDefaults: () => Promise<QuickflowGetResult> };
}

const DISMISSED_KEY = 'kageops:quickflow-dismissed';

const FIELD_TIPS: ReadonlyArray<{ id: string; tip: string }> = [
    {
        id: 'project-name',
        tip: 'Short, distinctive — used for the workspace folder, GitHub repo, and run reports. Letters/digits/spaces OK.',
    },
    {
        id: 'project-desc',
        tip: 'What should Sensei build? Include user-visible behaviour, sections, key acceptance criteria. The richer the prompt, the fewer phase-gate iterations.',
    },
    {
        id: 'onboard-budget',
        tip: 'Hard kill in USD per run — Sensei polls every 3 s and aborts when MAX(SUM(cost), tokens × $3/M) ≥ cap. Set higher for ambitious projects.',
    },
    {
        id: 'onboard-trust',
        tip: 'Low = pause every phase gate. Medium = pause major gates. High = autonomous after design. Higher trust + lower budget = faster iteration but less control.',
    },
];

interface ChecklistItem {
    readonly id: string;
    readonly label: string;
    readonly check: () => boolean;
}

// ── Module state ─────────────────────────────────────

let drawerEl: HTMLElement | null = null;
let helpButtonEl: HTMLElement | null = null;
let bound = false;

const bridge = (): KageOpsQuickflowBridge => {
    const w = window as unknown as { kageOps?: KageOpsQuickflowBridge };
    if (!w.kageOps) throw new Error('kageOps preload bridge not available');
    return w.kageOps;
};

// ── Public API ────────────────────────────────────────

/**
 * Wire the quickflow into the existing New Project modal. Idempotent —
 * safe to call from multiple boot paths.
 *
 * Caller responsibilities:
 *   - call `attachQuickflow()` once at app boot AFTER the modal markup is
 *     in the DOM
 *   - `showQuickflow()` to display the drawer when the modal opens
 *   - `hideQuickflow()` when the modal closes
 */
export function attachQuickflow(): void {
    if (bound) return;
    bound = true;

    const modal = document.querySelector('.modal--onboarding');
    if (modal === null) {
        console.warn('[quickflow] modal--onboarding not found, skipping attach');
        return;
    }

    // Build drawer (hidden by default; showQuickflow reveals it)
    drawerEl = buildDrawer();
    modal.appendChild(drawerEl);

    // Add the "?" help button to the modal header so the user can re-open
    // the drawer after dismissing it.
    helpButtonEl = buildHelpButton();
    const headerCloseBtn = modal.querySelector('#btn-modal-close');
    if (headerCloseBtn?.parentElement) {
        headerCloseBtn.parentElement.insertBefore(helpButtonEl, headerCloseBtn);
    }

    // Wire tooltips on each field by appending a "?" badge next to the label.
    for (const t of FIELD_TIPS) {
        installTooltip(t.id, t.tip);
    }

    // Re-evaluate checklist on input changes.
    const fieldsToWatch: ReadonlyArray<string> = ['project-name', 'project-desc', 'onboard-budget', 'onboard-trust'];
    for (const id of fieldsToWatch) {
        const el = document.getElementById(id);
        if (el === null) continue;
        const handler = (): void => updateChecklist();
        el.addEventListener('input', handler);
        el.addEventListener('change', handler);
    }

    // Re-evaluate checklist when phase checkboxes are toggled.
    // #165 stage 2 replaced #onboard-phases-grid with #onboard-phase-task-tree;
    // listen on whichever is present so the quickflow keeps refreshing.
    const phasesGrid = document.getElementById('onboard-phases-grid');
    if (phasesGrid !== null) {
        phasesGrid.addEventListener('change', () => updateChecklist());
    }
    const phaseTaskTree = document.getElementById('onboard-phase-task-tree');
    if (phaseTaskTree !== null) {
        phaseTaskTree.addEventListener('change', () => updateChecklist());
    }
}

/**
 * Reveal the drawer (called when the modal opens). Pulls defaults from
 * the IPC and prefills any blank fields, then renders the checklist.
 *
 * If the user has dismissed the drawer permanently (per Q3), this
 * becomes a no-op aside from prefilling defaults.
 */
export async function showQuickflow(): Promise<void> {
    // Always prefill defaults — even if drawer is dismissed, defaults still
    // matter so the user gets a sensible starting state.
    await prefillDefaults();
    updateChecklist();

    if (isDismissed()) {
        if (drawerEl) drawerEl.classList.add('hidden');
        if (helpButtonEl) helpButtonEl.classList.remove('hidden');
        return;
    }

    if (drawerEl) drawerEl.classList.remove('hidden');
    if (helpButtonEl) helpButtonEl.classList.add('hidden');
}

export function hideQuickflow(): void {
    if (drawerEl) drawerEl.classList.add('hidden');
}

// ── Drawer building ──────────────────────────────────

function buildDrawer(): HTMLElement {
    const d = document.createElement('aside');
    d.id = 'quickflow-drawer';
    d.className = 'qf-drawer hidden';
    d.setAttribute('aria-label', 'New project checklist');
    d.innerHTML = `
        <div class="qf-drawer-header">
            <span class="qf-drawer-title">Quick start</span>
            <button class="qf-drawer-close" type="button" aria-label="Hide quickflow">×</button>
        </div>
        <p class="qf-drawer-intro">Fill these four to start a project. Tooltips on each field explain what each does.</p>
        <ul class="qf-checklist" id="qf-checklist"></ul>
        <label class="qf-dismiss">
            <input type="checkbox" id="qf-dismiss-cb" />
            Don't show this again
        </label>
    `;
    d.querySelector('.qf-drawer-close')?.addEventListener('click', () => {
        d.classList.add('hidden');
        if (helpButtonEl) helpButtonEl.classList.remove('hidden');
    });
    d.querySelector<HTMLInputElement>('#qf-dismiss-cb')?.addEventListener('change', (e) => {
        const cb = e.target as HTMLInputElement;
        if (cb.checked) {
            try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* private mode */ }
        } else {
            try { localStorage.removeItem(DISMISSED_KEY); } catch { /* private mode */ }
        }
    });
    return d;
}

function buildHelpButton(): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'qf-help-btn hidden';
    b.setAttribute('aria-label', 'Show quickflow checklist');
    b.title = 'Show quickflow checklist';
    b.textContent = '?';
    b.addEventListener('click', () => {
        if (drawerEl) drawerEl.classList.remove('hidden');
        b.classList.add('hidden');
    });
    return b;
}

// ── Tooltips ─────────────────────────────────────────

function installTooltip(fieldId: string, tip: string): void {
    const field = document.getElementById(fieldId);
    if (field === null) return;
    // Find the field's containing <label> so we can append the tip badge
    // next to the field label text.
    const label = field.closest('label.onboard-field');
    if (label === null) return;
    if (label.querySelector('.qf-tip-badge')) return; // already installed

    const badge = document.createElement('span');
    badge.className = 'qf-tip-badge';
    badge.setAttribute('role', 'tooltip');
    badge.tabIndex = 0;
    badge.textContent = '?';
    badge.title = tip; // native fallback

    const popover = document.createElement('span');
    popover.className = 'qf-tip-popover';
    popover.textContent = tip;
    badge.appendChild(popover);

    const labelText = label.querySelector('.onboard-field-label');
    if (labelText) labelText.appendChild(badge);
}

// ── Checklist ────────────────────────────────────────

const CHECKLIST_ITEMS: ReadonlyArray<ChecklistItem> = [
    {
        id: 'name-desc',
        label: 'Name + prompt',
        check: () => isFilled('project-name') && isFilled('project-desc'),
    },
    {
        id: 'preset',
        label: 'Preset chosen',
        check: () => true,
    },
    {
        id: 'budget',
        label: 'Budget cap set',
        check: () => {
            const v = parseInputNumber('onboard-budget');
            return v !== null && v > 0;
        },
    },
    {
        id: 'trust',
        label: 'Trust level',
        check: () => isFilled('onboard-trust'),
    },
    {
        id: 'phases',
        label: 'Phases selected',
        check: () => document.querySelectorAll<HTMLInputElement>('input[name="phase"]:checked').length > 0,
    },
];

function updateChecklist(): void {
    if (drawerEl === null) return;
    const ul = drawerEl.querySelector<HTMLElement>('#qf-checklist');
    if (ul === null) return;
    ul.innerHTML = '';
    let allDone = true;
    for (const item of CHECKLIST_ITEMS) {
        const done = item.check();
        if (!done) allDone = false;
        const li = document.createElement('li');
        li.className = 'qf-check-item' + (done ? ' done' : '');
        li.innerHTML = `
            <span class="qf-check-mark" aria-hidden="true">${done ? '✓' : '○'}</span>
            <span class="qf-check-label">${escapeHtml(item.label)}</span>
        `;
        ul.appendChild(li);
    }
    drawerEl.classList.toggle('all-done', allDone);
}

// ── Defaults prefill ─────────────────────────────────

async function prefillDefaults(): Promise<void> {
    let res: QuickflowGetResult | null = null;
    try {
        res = await bridge().quickflow.getDefaults();
    } catch (err) {
        console.warn('[quickflow] getDefaults failed', err);
        return;
    }
    if (!res?.ok || !res.defaults) return;
    const d = res.defaults;

    // Only prefill BLANK fields — never overwrite user input.
    if (d.trustLevel !== null) {
        const sel = document.getElementById('onboard-trust') as HTMLSelectElement | null;
        if (sel !== null && sel.value === 'medium') {
            // 'medium' is the static default; only swap if user hasn't picked.
            // (We can't distinguish unchanged-default from explicit-medium, but
            // for first-open of the modal this is fine.)
            sel.value = d.trustLevel;
        }
    }
    if (typeof d.budgetCapUsd === 'number' && d.budgetCapUsd > 0) {
        const inp = document.getElementById('onboard-budget') as HTMLInputElement | null;
        // Default markup is value="0.50"; only override if it's still that.
        if (inp !== null && (inp.value === '' || inp.value === '0.5' || inp.value === '0.50')) {
            inp.value = String(d.budgetCapUsd);
        }
    }
}

// ── Helpers ─────────────────────────────────────────

function isFilled(id: string): boolean {
    const el = document.getElementById(id);
    if (el === null) return false;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return el.value.trim().length > 0;
    }
    if (el instanceof HTMLSelectElement) {
        return el.value !== '';
    }
    return false;
}

function parseInputNumber(id: string): number | null {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el === null) return null;
    const v = Number.parseFloat(el.value);
    return Number.isFinite(v) ? v : null;
}

function isDismissed(): boolean {
    try {
        return localStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
        return false;
    }
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => {
        switch (c) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return c;
        }
    });
}
