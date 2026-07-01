/**
 * KageOps — Branded idle screen
 *
 * A self-contained, tip-cycling "waiting" panel that replaces every plain
 * "No data yet" empty state. Uses the design-pack kanji-stroke loader (same
 * SVG geometry as ThinkingRotator) at a larger display size, a brand tagline,
 * and rotating quick-tip cards drawn from KAGEOPS_TIPS.
 *
 * Usage:
 *   const idle = mountIdleScreen(containerEl, { context: 'activity' });
 *   // later, when real content arrives:
 *   idle.unmount();
 */

const TIP_INTERVAL_MS = 5_000;
const TIP_FADE_MS = 300;

interface Tip {
    readonly heading: string;
    readonly body: string;
}

// ── Tip library ───────────────────────────────────────────────────────────────
// Organised in roughly the order a new user would want to learn them.

const KAGEOPS_TIPS: readonly Tip[] = [
    {
        heading: 'Start your first mission',
        body: 'Open the New Project panel, describe your idea, and Sensei routes it through all 6 phases automatically — no manual hand-offs.',
    },
    {
        heading: 'The 6-phase pipeline',
        body: 'Discovery → POC → Business Viability → Design & Planning → Development → Launch & Growth. Each phase is owned by a specialist Autonaut.',
    },
    {
        heading: 'Talk to Sensei',
        body: 'Type /sensei <message> in the Terminal tab to ask the orchestrator anything — project status, a cost breakdown, or a plan change.',
    },
    {
        heading: 'Trust levels control the gates',
        body: 'Set trust to "high" and Sensei approves all phase gates automatically. "low" requires your sign-off at every phase transition.',
    },
    {
        heading: 'Recover from failures gracefully',
        body: '/retry-task <id> re-runs one failed task. /retry-phase re-runs an entire phase. /retry-failed catches everything at once.',
    },
    {
        heading: 'Intercept a running agent',
        body: '/pause stops an agent at the next safe checkpoint. /inject sends it course-correction guidance mid-run. /takeover brings the task to you.',
    },
    {
        heading: 'Presets tune cost vs. quality',
        body: 'Pick claude-cli-premium for production code, codex-cli if you have ChatGPT Plus, ollama for offline. Switch any time from Model Routing.',
    },
    {
        heading: 'Always dry-run first',
        body: 'Run npm run run:headless -- --dry-run to preview the full pipeline at zero AI cost before committing to a live run.',
    },
    {
        heading: 'Hard budget caps',
        body: 'Set KAGEOPS_MAX_RUN_USD before a live run. Budget-kill polls every 3 s and cancels the project if spend exceeds the cap.',
    },
    {
        heading: 'APO — overnight prompt tuning',
        body: 'Enable KAGEOPS_APO_ENABLED=1 to let KageOps iteratively improve Scout, Herald, and Pixel prompts using beam search overnight.',
    },
    {
        heading: 'Approval queue is your control point',
        body: 'Every gate escalation lands in the Approval Queue tab. Use /approve or /deny from the Terminal for keyboard-driven review.',
    },
    {
        heading: 'Agent Logs streams everything',
        body: 'The Agent Logs tab captures npm install, git push, and claude-cli subprocess output live — across every project simultaneously.',
    },
    {
        heading: 'The Autonauts roster',
        body: 'Scout (research) · Blueprint (architecture) · Forge (engineering) · Vigil (QA) · Pixel (design) · Cipher (data) · Aegis (platform) · Herald (marketing).',
    },
    {
        heading: 'Resume an interrupted run',
        body: 'Use --resume <project-id> with the headless runner to pick up exactly where a run was cut off, without restarting the whole pipeline.',
    },
];

// ── Kanji-stroke SVG (Loader 3 from design pack) ─────────────────────────────
// Four slate strokes + one accent vertical, drawn in cascade order.
// Geometry is the same as ThinkingRotator but rendered at a larger viewport.

const LOADER_SVG =
    '<svg class="idle-screen__loader-svg" viewBox="0 0 100 100" aria-hidden="true">' +
    '<path class="idle-screen__stroke" d="M20 30 L48 30"/>' +
    '<path class="idle-screen__stroke" d="M20 46 L60 46"/>' +
    '<path class="idle-screen__stroke" d="M20 62 L52 62"/>' +
    '<path class="idle-screen__stroke" d="M20 78 L72 78"/>' +
    '<path class="idle-screen__stroke idle-screen__stroke--accent" d="M76 22 L76 84"/>' +
    '</svg>';

// ── Context-specific taglines ─────────────────────────────────────────────────

interface IdleScreenOptions {
    /** Determines the tagline shown below the wordmark. */
    readonly context?: 'activity' | 'approvals' | 'build' | 'agent-logs' | 'generic';
}

const TAGLINES: Record<NonNullable<IdleScreenOptions['context']>, string> = {
    'activity':   'Agent events will stream here the moment a mission starts.',
    'approvals':  'Phase gate approvals appear here when Sensei needs a decision.',
    'build':      'Build & acceptance results appear here after development completes.',
    'agent-logs': 'Subprocess output from all active projects streams here in real time.',
    'generic':    'Standing by for your next mission.',
};

// ── Public API ────────────────────────────────────────────────────────────────

export interface IdleScreenHandle {
    /** Remove the idle screen from the DOM and stop all timers. */
    unmount(): void;
}

/**
 * Mounts a branded idle screen into `container`, replacing any existing
 * content. Returns a handle whose `unmount()` cleans everything up.
 */
export function mountIdleScreen(
    container: HTMLElement,
    options: IdleScreenOptions = {},
): IdleScreenHandle {
    const context = options.context ?? 'generic';
    const tagline = TAGLINES[context];

    container.innerHTML = '';

    // ── Root ──────────────────────────────────────────
    const root = document.createElement('div');
    root.className = 'idle-screen';

    // ── Brand block ───────────────────────────────────
    const brand = document.createElement('div');
    brand.className = 'idle-screen__brand';
    brand.innerHTML = LOADER_SVG;

    const wordmark = document.createElement('div');
    wordmark.className = 'idle-screen__wordmark';
    wordmark.textContent = 'KAGEOPS';

    const sub = document.createElement('div');
    sub.className = 'idle-screen__tagline';
    sub.textContent = tagline;

    brand.appendChild(wordmark);
    brand.appendChild(sub);

    // ── Tip line (replaces card + dots) ───────────────
    const tipLine = document.createElement('div');
    tipLine.className = 'idle-screen__tip';

    root.appendChild(brand);
    root.appendChild(tipLine);
    container.appendChild(root);

    // ── Tip rotation ──────────────────────────────────
    let tipIdx = 0;
    const totalTips = KAGEOPS_TIPS.length;

    function showTip(idx: number): void {
        const tip = KAGEOPS_TIPS[idx % totalTips];
        if (tip === undefined) return;
        tipLine.style.opacity = '0';
        setTimeout(() => {
            tipLine.textContent = tip.body;
            tipLine.style.opacity = '1';
        }, TIP_FADE_MS);
    }

    // Prime with first tip immediately (no delay)
    const firstTip = KAGEOPS_TIPS[0]!;
    tipLine.textContent = firstTip.body;
    tipLine.style.opacity = '1';

    const intervalId = setInterval(() => {
        tipIdx = (tipIdx + 1) % totalTips;
        showTip(tipIdx);
    }, TIP_INTERVAL_MS);

    return {
        unmount(): void {
            clearInterval(intervalId);
            root.remove();
        },
    };
}
