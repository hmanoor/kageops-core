/**
 * Simple-App Detector (v1.6)
 *
 * Shared heuristic used by task-decomposer (SIMPLE-APP GUARD), Forge
 * (static-HTML routing), and the headless-runner dry-run preview.
 *
 * Returns {simple:true, kind} when the project description matches any of
 * the trivial-app patterns (counter/todo/calculator/clock/landing-page/
 * dashboard-mock/single-file/single-page/index.html). Those projects
 * should be implemented as a single static index.html + styles.css +
 * script.js — no bundler, no framework, no test runner.
 */

export interface SimpleAppDetection {
    readonly simple: boolean;
    readonly kind: string | null;
}

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bcounter\b/, 'counter'],
    [/\btodo\s*(list|app)?\b/, 'todo'],
    [/\bcalculator\b/, 'calculator'],
    [/\b(clock|timer|stopwatch)\b/, 'clock'],
    [/\blanding\s*page\b/, 'landing-page'],
    [/\bdashboard\s*mock\b/, 'dashboard-mock'],
    [/\bsingle[-\s]*file\b/, 'single-file'],
    [/\bsingle[-\s]*page\b/, 'single-page'],
    [/\bindex\.html\b/, 'static-html'],
];

/**
 * Veto signals — if any of these appear, the project is NOT a simple
 * static-HTML scaffold even when the surface-pattern matched.
 *
 * The previous heuristic over-matched: a brief like "single-page personal
 * task manager using Node.js + Express + SQLite" matched `\bsingle[-\s]*page\b`
 * and was classified as static-HTML. That triggered WorkspaceManager's
 * stripBuildScaffold which deleted package.json + src/ + tests/ — and
 * Forge's static-HTML route then emitted index.html only, leaving the
 * user with a half-corrupted "Node app" missing every Node file.
 *
 * Veto vocabulary covers the common cues that signal a real backend or
 * a build-tool-based frontend. False negatives (a genuine static site
 * accidentally mentioning "node") just take the full pipeline path, which
 * is slower but correct. False positives destroyed files; vetoes don't.
 */
const VETO_PATTERNS: readonly RegExp[] = [
    /\bnode\.?js\b/,
    /\bexpress\b/,
    /\bfastify\b/,
    /\bnest\.?js\b/,
    /\bbackend\b/,
    /\bserver\.js\b/,
    /\bsqlite\b/,
    /\bpostgres\b/,
    /\bmongo\b/,
    /\bapi\s*endpoint/,
    /\bnpm\s+(install|start|run)\b/,
    /\bpackage\.json\b/,
    /\breact\b/,
    /\bvue\b/,
    /\bsvelte\b/,
    /\bnext\.?js\b/,
    /\bvite\b/,
    /\btypescript\b/,
    // 2026-05-31: HabbitForge + FleetPulse smokes both classified as
    // static-HTML because their briefs use "landing page at /" routing
    // language without naming next.js or react explicitly. SaaS-shaped
    // briefs that mention these services are NEVER static HTML —
    // they're full backend apps. Adding them as vetoes prevents
    // stripBuildScaffold from destroying the bundle scaffold before
    // Sensei's bundle matcher can persist selected_bundle.
    /\bclerk\b/,
    /\bsupabase\b/,
    /\bneon\b/,
    /\bdrizzle\b/,
    /\bprisma\b/,
    /\bauth0\b/,
    /\bfirebase\b/,
    /\bstripe\b/,
    /\boauth\b/,
    /\bmagic\s*link/,
    /\bsign[-\s]*in\b/,
    /\bsign[-\s]*up\b/,
    /\bsaas\b/,
    /\bsubscription\b/,
    /\bpaywall\b/,
    /\bcheckout\b/,
    /\/api\//,
    /\bserver[-\s]*sent\s*events\b/,
    /\bwebsocket\b/,
    /\bredis\b/,
    /\bbull[-\s]*mq\b/,
    /\bkafka\b/,
];

export function detectSimpleApp(description: string): SimpleAppDetection {
    if (description === '' || description === undefined) {
        return { simple: false, kind: null };
    }
    const d = description.toLowerCase();
    // Vetoes win — if the brief names a backend, ORM, or frontend
    // framework, the static-HTML route is the wrong one regardless of
    // surface keywords.
    for (const veto of VETO_PATTERNS) {
        if (veto.test(d)) return { simple: false, kind: null };
    }
    for (const [re, kind] of PATTERNS) {
        if (re.test(d)) return { simple: true, kind };
    }
    return { simple: false, kind: null };
}
