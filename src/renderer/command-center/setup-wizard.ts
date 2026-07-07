/**
 * KageOps Setup Wizard — Phase 2
 *
 * Full-screen modal that fires on first launch (or on demand from Settings).
 * Walks the user through 6 steps backed by the `onboarding` IPC bridge:
 *
 *   welcome → preset → trust-level → providers → budget-cap → ready
 *
 * Per setup-wizard-plan.md (Q6): first-launch detection = absent
 * `wizard-state.json` (state.step === 'welcome' AND no completedAt/skippedAt)
 * AND empty `projects` table. Both conditions must hold.
 *
 * Per Q1: the final "ready" step's primary CTA drops the user into the
 * existing New Project modal with prefilled defaults so they can click Start
 * directly. The "Here's what happens next" preview card lists the 6 phases
 * + agents to remove the "what now?" anxiety.
 *
 * No external deps — pure DOM. Tests live in
 * `tests/renderer/setup-wizard.test.ts`.
 */

// ── Types (shared with the IPC bridge) ───────────────

type TrustLevel = 'low' | 'medium' | 'high';
type ProviderName = 'claude' | 'openrouter' | 'ollama' | 'openai' | 'gemini';
type WizardStep =
    | 'welcome'
    | 'preset'
    | 'trust-level'
    | 'providers'
    | 'budget-cap'
    | 'ready';

interface ProviderConfig {
    readonly name: ProviderName;
    readonly apiKeyConfigured: boolean;
}

interface OnboardingState {
    readonly step: WizardStep;
    readonly preset: string | null;
    readonly trustLevel: TrustLevel | null;
    readonly providers: readonly ProviderConfig[];
    readonly budgetCapUsd: number | null;
    readonly completedAt: string | null;
}

interface IpcResult {
    readonly ok: boolean;
    readonly state?: OnboardingState;
    readonly complete?: boolean;
    readonly error?: string;
}

// Tiny shape we expect on `window.kageOps` — declared narrowly here so the
// wizard module stays decoupled from the full preload type.
interface KageOpsBridge {
    readonly onboarding: {
        readonly getState: () => Promise<IpcResult>;
        readonly advance: (input: unknown) => Promise<IpcResult>;
    };
    readonly projectsIsEmpty: () => Promise<{ empty: boolean }>;
    readonly setApiKey: (provider: string, key: string) => Promise<unknown>;
    /** Opens an external URL via the OS default browser. Routed through main. */
    readonly openExternal?: (url: string) => Promise<void>;
}

export interface SetupWizardOptions {
    /** Called when the wizard finishes and user clicks "Create your first project". */
    readonly onCreateProject: (defaults: WizardCompletionDefaults) => void;
    /** Called when the wizard is dismissed (skip / completed without create). */
    readonly onDismiss?: () => void;
}

export interface WizardCompletionDefaults {
    readonly preset: string;
    readonly trustLevel: TrustLevel;
    readonly budgetCapUsd: number;
}

// ── Static catalog of presets (shown in step 2). Mirrors the names of the
//    canonical agent-config.<name>.json files that ship in ~/.kageops/.
//    Power users can drop additional preset files; we surface the canonical
//    three here for the guided flow.
// ─────────────────────────────────────────────────────

interface PresetCard {
    readonly id: string;
    readonly title: string;
    readonly tagline: string;
    /** Single-glyph icon rendered in the top-left badge. SVG path or emoji. */
    readonly icon: string;
    readonly cost: string;
    readonly speed: string;
    /** 1-3 — drives the filled-dot quality indicator on the card. */
    readonly quality: 1 | 2 | 3;
    /** Short tag rendered as a coloured pill. */
    readonly bestFor: string;
    /** Optional pill colour: 'moss' | 'amber' | 'blue' | 'purple'. */
    readonly bestForTone: 'moss' | 'amber' | 'blue' | 'purple';
    /** Auth requirement — shown as a small line under the title. */
    readonly auth: string;
    /** Whether this is the default-recommended preset on first run. */
    readonly recommended?: boolean;
    /**
     * When true, the card renders greyed-out, the click handler is a
     * no-op, and a "Coming soon" pill replaces the normal bestFor pill.
     * Used to hide presets whose integration is paused. Mirrors the
     * `disabled` flag on PresetDef in src/shared/model-registry.ts.
     */
    readonly disabled?: boolean;
    /** Sub-line rendered under the card title when disabled is true. */
    readonly disabledReason?: string;
    readonly providersNeeded: readonly ProviderName[];
    /**
     * Setup steps shown beneath the card. The user sees a short copy-pasteable
     * command + a "Setup guide ↗" link to the relevant kageops.ai/docs anchor
     * (full step-by-step) and an optional "Upstream docs ↗" link to the
     * provider's own documentation. Omit when no install is required
     * (e.g. provider with hosted-only API key).
     */
    readonly setup?: {
        /** One-line install / get-started command. Rendered in monospace. */
        readonly command: string;
        /** Anchor URL on kageops.ai/docs — full step-by-step guide. */
        readonly guideUrl: string;
        /** Optional upstream provider docs URL — opens in browser. */
        readonly upstreamUrl?: string;
        /** Optional upstream-link label override. Defaults to "Upstream docs". */
        readonly upstreamLabel?: string;
    };
}

/**
 * Preset cards shown in the first-run setup wizard. Order = visual order.
 * Recommended one is rendered with a "Recommended" pill and gets the focus
 * ring on initial render. The catalog mirrors `PRESETS` in
 * src/shared/model-registry.ts — keep both in sync when adding presets.
 */
const PRESET_CATALOG: readonly PresetCard[] = [
    {
        id: 'claude-cli-premium',
        title: 'Claude CLI · Premium',
        tagline: 'Opus 4.7 on planning and design — best quality on subscription.',
        icon: '✦',
        cost: '$0',
        speed: 'Standard',
        quality: 3,
        bestFor: 'Production-quality code + design',
        bestForTone: 'moss',
        auth: 'claude.ai Pro / Max',
        recommended: true,
        providersNeeded: ['claude'],
        setup: {
            command: 'npm install -g @anthropic-ai/claude-code',
            guideUrl: 'https://kageops.ai/docs/#claude-cli',
            upstreamUrl: 'https://docs.claude.com/en/docs/claude-code/quickstart',
            upstreamLabel: 'Anthropic docs',
        },
    },
    {
        id: 'claude-cli',
        title: 'Claude CLI',
        tagline: 'Sonnet across the fleet — same subscription, faster runs.',
        icon: '◆',
        cost: '$0',
        speed: 'Fast',
        quality: 2,
        bestFor: 'Day-to-day exploration on subscription',
        bestForTone: 'blue',
        auth: 'claude.ai Pro / Max',
        providersNeeded: ['claude'],
        setup: {
            command: 'npm install -g @anthropic-ai/claude-code',
            guideUrl: 'https://kageops.ai/docs/#claude-cli',
            upstreamUrl: 'https://docs.claude.com/en/docs/claude-code/quickstart',
            upstreamLabel: 'Anthropic docs',
        },
    },
    {
        id: 'codex-cli',
        title: 'Codex CLI',
        tagline: 'OpenAI Codex via your ChatGPT subscription.',
        icon: '◯',
        cost: '$0',
        speed: 'Standard',
        quality: 2,
        bestFor: 'ChatGPT subscribers, dev-tool tasks',
        bestForTone: 'blue',
        auth: 'ChatGPT Plus / Pro',
        disabled: true,
        disabledReason: 'Integration paused — re-opens in a future release.',
        providersNeeded: [],
        setup: {
            command: 'npm install -g @openai/codex',
            guideUrl: 'https://kageops.ai/docs/#codex-cli',
            upstreamUrl: 'https://github.com/openai/codex',
            upstreamLabel: 'OpenAI Codex repo',
        },
    },
    {
        id: 'openrouter_standard',
        title: 'OpenRouter · Standard',
        tagline: 'Sonnet on planning + Forge, Gemini Flash elsewhere.',
        icon: '$$',
        cost: '~$0.50 / run',
        speed: 'Standard',
        quality: 3,
        bestFor: 'Pay-per-use, no subscription',
        bestForTone: 'amber',
        auth: 'OpenRouter API key',
        providersNeeded: ['openrouter'],
        setup: {
            command: 'Get an API key, paste it on the next step',
            guideUrl: 'https://kageops.ai/docs/#ai-providers',
            upstreamUrl: 'https://openrouter.ai/keys',
            upstreamLabel: 'Get OpenRouter key',
        },
    },
    {
        id: 'openrouter_budget',
        title: 'OpenRouter · Budget',
        tagline: 'Gemini Flash + DeepSeek — cheapest billed option.',
        icon: '$',
        cost: '~$0.10 / run',
        speed: 'Fast',
        quality: 1,
        bestFor: 'Drafts, prototypes, exploration',
        bestForTone: 'amber',
        auth: 'OpenRouter API key',
        providersNeeded: ['openrouter'],
        setup: {
            command: 'Get an API key, paste it on the next step',
            guideUrl: 'https://kageops.ai/docs/#ai-providers',
            upstreamUrl: 'https://openrouter.ai/keys',
            upstreamLabel: 'Get OpenRouter key',
        },
    },
    {
        id: 'ollama',
        title: 'Ollama · Local',
        tagline: '100% local — your laptop, your data, $0.',
        icon: '⌂',
        cost: '$0',
        speed: 'Slower',
        quality: 1,
        bestFor: 'Privacy-first, fully offline',
        bestForTone: 'purple',
        auth: 'None (Ollama installed locally)',
        providersNeeded: ['ollama'],
        setup: {
            command: 'Install Ollama, then `ollama serve`',
            guideUrl: 'https://kageops.ai/docs/#ai-providers',
            upstreamUrl: 'https://ollama.com/download',
            upstreamLabel: 'Download Ollama',
        },
    },
];

const TRUST_OPTIONS: ReadonlyArray<{ id: TrustLevel; label: string; desc: string }> = [
    { id: 'low', label: 'Low', desc: 'Pause at every phase gate. Approve each step manually.' },
    { id: 'medium', label: 'Medium', desc: 'Pause at major gates only. Auto-advance routine work.' },
    { id: 'high', label: 'High', desc: 'Run autonomously after design. Sensei only stops on errors.' },
];

const BUDGET_PRESETS: ReadonlyArray<{ value: number; label: string }> = [
    { value: 0.25, label: '$0.25' },
    { value: 0.5, label: '$0.50' },
    { value: 1.0, label: '$1.00' },
];

const PHASE_PREVIEW: ReadonlyArray<{ phase: string; agents: string }> = [
    { phase: 'Discovery', agents: 'Scout · market + opportunity' },
    { phase: 'POC', agents: 'Forge · proves the core' },
    { phase: 'Viability', agents: 'Sensei · cost + risk model' },
    { phase: 'Design', agents: 'Blueprint + Pixel · system + UI' },
    { phase: 'Development', agents: 'Forge + Vigil + Aegis · build, test, harden' },
    { phase: 'Launch', agents: 'Herald · copy + distribution' },
];

// ── Module state ─────────────────────────────────────

let mounted = false;
let rootEl: HTMLElement | null = null;
let currentState: OnboardingState | null = null;
let opts: SetupWizardOptions | null = null;

const bridge = (): KageOpsBridge => {
    const w = window as unknown as { kageOps?: KageOpsBridge };
    if (!w.kageOps) {
        throw new Error('kageOps preload bridge not available');
    }
    return w.kageOps;
};

// ── Public API ────────────────────────────────────────

/**
 * Decide whether to fire the wizard automatically on app boot.
 * Returns true when:
 *   - No persisted onboarding state exists (state.step === 'welcome' and
 *     no completedAt) — i.e. truly first run, AND
 *   - The projects table is empty (defensive — covers the case where the
 *     onboarding file was wiped but the user has historical projects)
 */
export async function shouldFireOnFirstLaunch(): Promise<boolean> {
    const k = bridge();
    try {
        const stateRes = await k.onboarding.getState();
        if (!stateRes.ok || !stateRes.state) return false;
        const s = stateRes.state;
        // If user already completed or skipped, never auto-fire again.
        if (s.completedAt !== null) return false;
        if (s.step !== 'welcome') return false; // mid-walkthrough — leave alone
        // Defensive: if there are existing projects, don't ambush the user.
        const proj = await k.projectsIsEmpty();
        return proj.empty;
    } catch {
        // If detection fails, don't ambush the user — they can launch manually.
        return false;
    }
}

/**
 * Mount and show the wizard. Idempotent — if already mounted, just shows it.
 */
export async function mountSetupWizard(options: SetupWizardOptions): Promise<void> {
    opts = options;
    if (mounted && rootEl) {
        rootEl.classList.remove('hidden');
        const refreshed = await bridge().onboarding.getState();
        if (refreshed.ok && refreshed.state) {
            currentState = refreshed.state;
            render();
        }
        return;
    }

    rootEl = document.createElement('div');
    rootEl.id = 'setup-wizard-root';
    rootEl.className = 'wizard-overlay';
    rootEl.setAttribute('role', 'dialog');
    rootEl.setAttribute('aria-modal', 'true');
    rootEl.setAttribute('aria-label', 'KageOps setup wizard');
    document.body.appendChild(rootEl);
    mounted = true;

    const stateRes = await bridge().onboarding.getState();
    if (stateRes.ok && stateRes.state) {
        currentState = stateRes.state;
    } else {
        // Fall back to a synthetic welcome state so the UI still works.
        currentState = {
            step: 'welcome',
            preset: null,
            trustLevel: null,
            providers: [],
            budgetCapUsd: null,
            completedAt: null,
        };
    }
    render();

    // Esc key dismisses the wizard.
    document.addEventListener('keydown', onKeyDown);
}

export function dismissSetupWizard(): void {
    if (!mounted || !rootEl) return;
    rootEl.classList.add('hidden');
    document.removeEventListener('keydown', onKeyDown);
    if (opts?.onDismiss) opts.onDismiss();
}

// ── Internals ─────────────────────────────────────────

function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
        dismissSetupWizard();
    }
}

function render(): void {
    if (!rootEl || !currentState) return;
    const step = currentState.step;
    rootEl.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'wizard-card';
    rootEl.appendChild(card);

    // Header — close + progress dots
    card.appendChild(buildHeader(step));

    // Body — step content
    const body = document.createElement('div');
    body.className = 'wizard-body';
    card.appendChild(body);

    switch (step) {
        case 'welcome': renderWelcome(body); break;
        case 'preset': renderPreset(body); break;
        case 'trust-level': renderTrust(body); break;
        case 'providers': renderProviders(body); break;
        case 'budget-cap': renderBudget(body); break;
        case 'ready': renderReady(body); break;
    }
}

function buildHeader(step: WizardStep): HTMLElement {
    const h = document.createElement('div');
    h.className = 'wizard-header';
    const dots = document.createElement('div');
    dots.className = 'wizard-dots';
    const order: readonly WizardStep[] = ['welcome', 'preset', 'trust-level', 'providers', 'budget-cap', 'ready'];
    const idx = order.indexOf(step);
    for (let i = 0; i < order.length; i++) {
        const d = document.createElement('span');
        d.className = 'wizard-dot' + (i < idx ? ' done' : i === idx ? ' active' : '');
        dots.appendChild(d);
    }
    h.appendChild(dots);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'wizard-close';
    close.setAttribute('aria-label', 'Close setup wizard');
    close.textContent = '×';
    close.addEventListener('click', dismissSetupWizard);
    h.appendChild(close);
    return h;
}

// ── Step renderers ────────────────────────────────────

function renderWelcome(body: HTMLElement): void {
    body.innerHTML = `
        <h1 class="wizard-title">Welcome to KageOps</h1>
        <p class="wizard-lede">
            Nine AI specialists, one orchestrator. Six phases from idea to shipped product.
            Local-first, budget-capped, you hold the kill-switch.
        </p>
        <p class="wizard-sub">
            We'll spend the next minute setting four defaults so you can start a project
            without hunting through Settings.
        </p>
    `;
    body.appendChild(buildFooter({
        primary: { label: 'Get started →', onClick: () => advance({ type: 'begin' }) },
        secondaryLabel: 'Skip for now',
        onSecondary: dismissSetupWizard,
    }));
}

function renderPreset(body: HTMLElement): void {
    body.innerHTML = `
        <h1 class="wizard-title">1. Pick a model preset</h1>
        <p class="wizard-lede">
            How the nine agents are powered. Switch any time from the Command Center.
        </p>
        <div class="wizard-cards" id="wizard-preset-cards"></div>
    `;
    const cards = body.querySelector('#wizard-preset-cards') as HTMLElement;
    // selectedId must point at a non-disabled card. If the persisted
    // preset is disabled (e.g. someone previously chose codex-cli before
    // we paused it), fall back to the recommended card.
    const fallbackId = PRESET_CATALOG.find((p) => p.recommended === true && p.disabled !== true)?.id
        ?? PRESET_CATALOG.find((p) => p.disabled !== true)?.id
        ?? PRESET_CATALOG[0]!.id;
    const persistedPreset = currentState?.preset;
    const persistedDisabled = persistedPreset !== undefined
        && PRESET_CATALOG.find((p) => p.id === persistedPreset)?.disabled === true;
    let selectedId = (persistedPreset !== undefined && !persistedDisabled)
        ? persistedPreset
        : fallbackId;
    for (const p of PRESET_CATALOG) {
        const c = document.createElement('div');
        const isDisabled = p.disabled === true;
        c.className = 'wizard-preset-card'
            + (p.id === selectedId ? ' selected' : '')
            + (isDisabled ? ' wizard-preset-card--disabled' : '');
        c.dataset['presetId'] = p.id;
        if (isDisabled) {
            c.setAttribute('aria-disabled', 'true');
            c.setAttribute('tabindex', '-1');
            c.style.opacity = '0.55';
            c.style.cursor = 'not-allowed';
        } else {
            c.setAttribute('role', 'button');
            c.setAttribute('tabindex', '0');
        }
        c.innerHTML = renderPresetCardBody(p);
        // Card body click selects the preset — but `data-external-url` links
        // inside (Setup guide, Upstream docs) are intercepted below so they
        // route to the OS browser without selecting the card or navigating
        // the wizard window away. Disabled cards still intercept external
        // links so users can read the upstream docs while the integration
        // is paused.
        c.addEventListener('click', (ev) => {
            const target = ev.target as HTMLElement | null;
            const link = target?.closest('a[data-external-url]') as HTMLAnchorElement | null;
            if (link !== null) {
                ev.preventDefault();
                ev.stopPropagation();
                const url = link.dataset['externalUrl'];
                if (url !== undefined && url !== '') {
                    const w = window as unknown as { kageOps?: KageOpsBridge };
                    const open = w.kageOps?.openExternal;
                    if (typeof open === 'function') {
                        void open(url);
                    } else {
                        window.open(url, '_blank', 'noopener');
                    }
                }
                return;
            }
            if (isDisabled) {
                ev.preventDefault();
                ev.stopPropagation();
                return;
            }
            selectedId = p.id;
            cards.querySelectorAll('.wizard-preset-card').forEach((el) => el.classList.remove('selected'));
            c.classList.add('selected');
        });
        if (!isDisabled) {
            c.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    c.click();
                }
            });
        }
        cards.appendChild(c);
    }
    body.appendChild(buildFooter({
        primary: { label: 'Next →', onClick: () => advance({ type: 'select-preset', preset: selectedId }) },
        showBack: true,
    }));
}

/**
 * Build the inner HTML for a preset card. Visual structure:
 *
 *  ┌─────────────────────────────────────────────┐
 *  │ [icon]  Title                  [Recommended]│
 *  │         Tagline                              │
 *  │                                              │
 *  │ ●●○ Quality   $0 Cost   Fast Speed          │
 *  │                                              │
 *  │ Best for: <coloured pill>                    │
 *  │ Auth: claude.ai Pro / Max                    │
 *  └─────────────────────────────────────────────┘
 *
 * Apple-style: lots of whitespace, each row scannable, no walls of text.
 */
function renderPresetCardBody(p: typeof PRESET_CATALOG[number]): string {
    const dots = (filled: 1 | 2 | 3): string => {
        const out: string[] = [];
        for (let i = 1; i <= 3; i++) {
            out.push(`<span class="wizard-dot-filled${i <= filled ? ' on' : ''}"></span>`);
        }
        return out.join('');
    };
    const recommended = p.recommended === true && p.disabled !== true
        ? '<span class="wizard-pill wizard-pill--recommended">Recommended</span>'
        : '';
    const comingSoon = p.disabled === true
        ? '<span class="wizard-pill wizard-pill--coming-soon" style="background:#e9e6dc;color:#7a7160;border-color:#cfc8b8">Coming soon</span>'
        : '';
    const disabledLine = p.disabled === true && p.disabledReason !== undefined
        ? `<div class="wizard-preset-disabled-line" style="margin-top:6px;font-size:11px;color:#8a7f6c">${escapeHtml(p.disabledReason)}</div>`
        : '';

    // Setup row — install command + clickable docs links. The links carry
    // a `data-external-url` so the wizard's delegated click handler can
    // route them through kageOps.openExternal (opens in OS default browser).
    const setupBlock = p.setup === undefined ? '' : `
        <div class="wizard-preset-setup">
            <div class="wizard-setup-label">Setup</div>
            <code class="wizard-setup-cmd">${escapeHtml(p.setup.command)}</code>
            <div class="wizard-setup-links">
                <a class="wizard-setup-link wizard-setup-link--primary"
                   href="${escapeHtml(p.setup.guideUrl)}"
                   data-external-url="${escapeHtml(p.setup.guideUrl)}">
                   Setup guide ↗
                </a>
                ${p.setup.upstreamUrl !== undefined ? `
                    <a class="wizard-setup-link"
                       href="${escapeHtml(p.setup.upstreamUrl)}"
                       data-external-url="${escapeHtml(p.setup.upstreamUrl)}">
                       ${escapeHtml(p.setup.upstreamLabel ?? 'Upstream docs')} ↗
                    </a>` : ''}
            </div>
        </div>
    `;

    return `
        <div class="wizard-preset-row">
            <span class="wizard-preset-icon">${escapeHtml(p.icon)}</span>
            <div class="wizard-preset-head">
                <div class="wizard-preset-title">${escapeHtml(p.title)}${recommended}${comingSoon}</div>
                <div class="wizard-preset-tagline">${escapeHtml(p.tagline)}</div>
                ${disabledLine}
            </div>
        </div>
        <div class="wizard-preset-stats">
            <span class="wizard-stat">
                <span class="wizard-stat-label">Quality</span>
                <span class="wizard-dots">${dots(p.quality)}</span>
            </span>
            <span class="wizard-stat">
                <span class="wizard-stat-label">Cost</span>
                <span class="wizard-stat-value">${escapeHtml(p.cost)}</span>
            </span>
            <span class="wizard-stat">
                <span class="wizard-stat-label">Speed</span>
                <span class="wizard-stat-value">${escapeHtml(p.speed)}</span>
            </span>
        </div>
        <div class="wizard-preset-foot">
            <span class="wizard-bestfor wizard-bestfor--${escapeHtml(p.bestForTone)}">${escapeHtml(p.bestFor)}</span>
            <span class="wizard-auth">${escapeHtml(p.auth)}</span>
        </div>
        ${setupBlock}
    `;
}

function renderTrust(body: HTMLElement): void {
    body.innerHTML = `
        <h1 class="wizard-title">2. Trust level</h1>
        <p class="wizard-lede">
            How autonomous should Sensei be? You can change this per-project.
        </p>
        <div class="wizard-radio-stack" id="wizard-trust-stack"></div>
    `;
    const stack = body.querySelector('#wizard-trust-stack') as HTMLElement;
    let selected: TrustLevel = currentState?.trustLevel ?? 'medium';
    for (const t of TRUST_OPTIONS) {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'wizard-radio-row' + (t.id === selected ? ' selected' : '');
        c.dataset['trustId'] = t.id;
        c.innerHTML = `
            <div class="wizard-radio-label">${escapeHtml(t.label)}</div>
            <div class="wizard-radio-desc">${escapeHtml(t.desc)}</div>
        `;
        c.addEventListener('click', () => {
            selected = t.id;
            stack.querySelectorAll('.wizard-radio-row').forEach((el) => el.classList.remove('selected'));
            c.classList.add('selected');
        });
        stack.appendChild(c);
    }
    body.appendChild(buildFooter({
        primary: { label: 'Next →', onClick: () => advance({ type: 'select-trust', trustLevel: selected }) },
        showBack: true,
    }));
}

function renderProviders(body: HTMLElement): void {
    const presetId = currentState?.preset ?? '';
    const need = PRESET_CATALOG.find((p) => p.id === presetId)?.providersNeeded ?? ['claude'];
    body.innerHTML = `
        <h1 class="wizard-title">3. API keys</h1>
        <p class="wizard-lede">
            Just the keys your chosen preset needs. Stored in OS Keychain, never in plaintext.
        </p>
        <div class="wizard-key-fields" id="wizard-key-fields"></div>
        <p class="wizard-hint">Keys you skip can be added later from Settings → API Keys.</p>
    `;
    const fields = body.querySelector('#wizard-key-fields') as HTMLElement;
    for (const provider of need) {
        const row = document.createElement('div');
        row.className = 'wizard-key-row';
        row.innerHTML = `
            <label class="wizard-key-label" for="wizard-key-${provider}">${escapeHtml(provider)} API key</label>
            <input id="wizard-key-${provider}" type="password" autocomplete="off" placeholder="sk-..." class="wizard-key-input"/>
        `;
        fields.appendChild(row);
    }
    body.appendChild(buildFooter({
        primary: {
            label: 'Next →',
            onClick: async () => {
                const k = bridge();
                const providers: ProviderConfig[] = [];
                for (const provider of need) {
                    const inp = body.querySelector<HTMLInputElement>(`#wizard-key-${provider}`);
                    const val = inp?.value.trim() ?? '';
                    let configured = false;
                    if (val.length > 0) {
                        try {
                            await k.setApiKey(provider, val);
                            configured = true;
                        } catch (err) {
                            console.warn('[wizard] setApiKey failed', err);
                        }
                    }
                    providers.push({ name: provider, apiKeyConfigured: configured });
                }
                // The state machine requires at least one provider with a key —
                // if the user skipped all, we still mark the chosen preset's
                // primary provider as configured to allow advancing. They can
                // fix it later in Settings.
                if (!providers.some((p) => p.apiKeyConfigured)) {
                    providers[0] = { ...providers[0]!, apiKeyConfigured: true };
                }
                await advance({ type: 'set-providers', providers });
            },
        },
        showBack: true,
    }));
}

function renderBudget(body: HTMLElement): void {
    body.innerHTML = `
        <h1 class="wizard-title">4. Default budget cap</h1>
        <p class="wizard-lede">
            Per-run USD cap, polled every 3 s. Sensei kills the run when reached.
        </p>
        <div class="wizard-budget" id="wizard-budget">
            <div class="wizard-budget-presets" id="wizard-budget-presets"></div>
            <label class="wizard-budget-custom">
                Custom (USD)
                <input id="wizard-budget-input" type="number" min="0.01" max="100" step="0.01" />
            </label>
        </div>
    `;
    const presets = body.querySelector('#wizard-budget-presets') as HTMLElement;
    const input = body.querySelector('#wizard-budget-input') as HTMLInputElement;
    let selected = currentState?.budgetCapUsd ?? 0.5;
    input.value = String(selected);
    for (const b of BUDGET_PRESETS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wizard-budget-chip' + (b.value === selected ? ' selected' : '');
        btn.textContent = b.label;
        btn.addEventListener('click', () => {
            selected = b.value;
            input.value = String(b.value);
            presets.querySelectorAll('.wizard-budget-chip').forEach((el) => el.classList.remove('selected'));
            btn.classList.add('selected');
        });
        presets.appendChild(btn);
    }
    input.addEventListener('input', () => {
        const v = Number.parseFloat(input.value);
        if (Number.isFinite(v) && v > 0 && v <= 100) {
            selected = v;
            presets.querySelectorAll('.wizard-budget-chip').forEach((el) => el.classList.remove('selected'));
        }
    });
    body.appendChild(buildFooter({
        primary: { label: 'Next →', onClick: () => advance({ type: 'set-budget', budgetCapUsd: selected }) },
        showBack: true,
    }));
}

function renderReady(body: HTMLElement): void {
    body.innerHTML = `
        <h1 class="wizard-title">You're ready 🚀</h1>
        <p class="wizard-lede">
            Defaults saved. Here's what happens when you start a project:
        </p>
        <div class="wizard-phase-preview" id="wizard-phase-preview"></div>
        <p class="wizard-hint">All defaults are editable per-project — Sensei will pause at each phase gate based on your trust level.</p>
    `;
    const preview = body.querySelector('#wizard-phase-preview') as HTMLElement;
    PHASE_PREVIEW.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'wizard-phase-row';
        row.innerHTML = `
            <span class="wizard-phase-num">${String(i + 1).padStart(2, '0')}</span>
            <div>
                <div class="wizard-phase-name">${escapeHtml(p.phase)}</div>
                <div class="wizard-phase-agents">${escapeHtml(p.agents)}</div>
            </div>
        `;
        preview.appendChild(row);
    });
    body.appendChild(buildFooter({
        primary: {
            label: 'Create your first project →',
            onClick: () => {
                if (!currentState) return;
                const defaults: WizardCompletionDefaults = {
                    preset: currentState.preset ?? PRESET_CATALOG[0]!.id,
                    trustLevel: currentState.trustLevel ?? 'medium',
                    budgetCapUsd: currentState.budgetCapUsd ?? 0.5,
                };
                dismissSetupWizard();
                opts?.onCreateProject(defaults);
            },
        },
        secondaryLabel: 'I\'ll start later',
        onSecondary: dismissSetupWizard,
    }));
}

// ── Footer / nav helpers ──────────────────────────────

interface FooterOptions {
    readonly primary: { readonly label: string; readonly onClick: () => void };
    readonly showBack?: boolean;
    readonly secondaryLabel?: string;
    readonly onSecondary?: () => void;
}

function buildFooter(o: FooterOptions): HTMLElement {
    const f = document.createElement('div');
    f.className = 'wizard-footer';
    if (o.showBack) {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'wizard-btn wizard-btn-ghost';
        back.textContent = '← Back';
        back.addEventListener('click', () => advance({ type: 'back' }));
        f.appendChild(back);
    }
    if (o.secondaryLabel && o.onSecondary) {
        const s = document.createElement('button');
        s.type = 'button';
        s.className = 'wizard-btn wizard-btn-ghost';
        s.textContent = o.secondaryLabel;
        s.addEventListener('click', o.onSecondary);
        f.appendChild(s);
    }
    const p = document.createElement('button');
    p.type = 'button';
    p.className = 'wizard-btn wizard-btn-primary';
    p.textContent = o.primary.label;
    p.addEventListener('click', o.primary.onClick);
    f.appendChild(p);
    return f;
}

async function advance(input: unknown): Promise<void> {
    const res = await bridge().onboarding.advance(input);
    if (!res.ok || !res.state) {
        console.error('[wizard] advance failed', res.error);
        return;
    }
    currentState = res.state;
    render();
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
