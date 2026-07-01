import { FEATURE_CARDS, HOWTO_ITEMS, WHATS_NEW } from '../../shared/welcome-content';

export {};

interface KageOpsWelcomeBridge {
    getVersion(): Promise<string>;
    dismiss(): Promise<void>;
    openDocs(): Promise<void>;
    quickAction(kind: 'new-project' | 'open-settings'): Promise<void>;
}

declare global {
    interface Window { kageOpsWelcome: KageOpsWelcomeBridge; }
}

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function renderFeatures(): void {
    const grid = $('feature-grid');
    if (grid === null) return;
    grid.innerHTML = FEATURE_CARDS.map((card) => `
        <div class="feature-card">
            <div class="feature-icon">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="${card.icon}"/>
                </svg>
            </div>
            <div class="feature-title">${card.title}</div>
            <div class="feature-desc">${card.description}</div>
        </div>
    `).join('');
}

function renderHowTo(): void {
    const list = $('howto-list');
    if (list === null) return;
    list.innerHTML = HOWTO_ITEMS.map((item, i) => `
        <div class="howto-item" data-action="${item.action}">
            <div class="howto-num">${i + 1}</div>
            <div class="howto-text">
                <div class="howto-title">${item.title}</div>
                <div class="howto-desc">${item.description}</div>
            </div>
            <span class="howto-arrow">›</span>
        </div>
    `).join('');

    list.querySelectorAll<HTMLElement>('.howto-item').forEach((el) => {
        el.addEventListener('click', () => {
            const action = el.dataset['action'] as typeof HOWTO_ITEMS[0]['action'];
            if (action === 'docs') {
                void window.kageOpsWelcome.openDocs();
            } else {
                void window.kageOpsWelcome.quickAction(action);
            }
        });
    });
}

function renderWhatsNew(): void {
    const versionEl = $('whats-new-version');
    const list = $('news-list');
    if (versionEl !== null) versionEl.textContent = `v${WHATS_NEW.version} · ${WHATS_NEW.date}`;
    if (list === null) return;
    list.innerHTML = WHATS_NEW.items.map((item) => `<li>${item}</li>`).join('');
}

async function init(): Promise<void> {
    renderFeatures();
    renderHowTo();
    renderWhatsNew();

    // Version badge
    try {
        const ver = await window.kageOpsWelcome.getVersion();
        const badge = $('version-badge');
        if (badge !== null) badge.textContent = `v${ver}`;
    } catch { /* best-effort */ }

    // Close / dismiss button
    $('btn-close')?.addEventListener('click', () => {
        const checked = ($('chk-dont-show') as HTMLInputElement | null)?.checked ?? false;
        if (checked) void window.kageOpsWelcome.dismiss();
        else void window.kageOpsWelcome.dismiss();
    });

    $('btn-got-it')?.addEventListener('click', () => {
        void window.kageOpsWelcome.dismiss();
    });

    $('btn-docs')?.addEventListener('click', () => {
        void window.kageOpsWelcome.openDocs();
    });

    $('chk-dont-show')?.addEventListener('change', () => {
        // dismiss() already marks hasSeenWelcome=true; the checkbox is purely
        // UX signalling — "Got it" always saves the flag either way.
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void init(); });
} else {
    void init();
}
