/**
 * CSS completeness check.
 *
 * Verifies that every class name referenced in `class="..."` attributes
 * in `index.html` has at least one matching `.<name>` selector in the
 * site's CSS. The v8 benchmark surfaced this as the #1 cause of pages
 * that pass the spec-rule and static-asset gates but render unstyled —
 * Forge writes rich HTML with class names like `.sigil-card` and
 * `.phase-item`, then ships a `styles.css` that only contains design
 * tokens and never extends to component rules.
 *
 * The check is intentionally lenient on small sites (≤10 distinct HTML
 * classes) so trivial pages don't trip a noise threshold, and on small
 * orphan absolute counts (≤15) so a handful of state classes don't
 * block legitimate work. Anything beyond that is the structural drift
 * we are trying to catch.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Types ────────────────────────────────────────────

export type CssCompletenessCheck = 'orphan-css-classes';

export interface CssCompletenessViolation {
    readonly check: CssCompletenessCheck;
    readonly expected: string;
    readonly message: string;
}

interface LinkedStylesheet {
    readonly href: string;
}

// ── Thresholds ───────────────────────────────────────

/**
 * Don't bother checking pages that reference fewer than this many
 * distinct classes — they're either trivial or scaffolds, and forcing
 * a CSS rule for every utility there is over-strict.
 */
const MIN_HTML_CLASSES_TO_CHECK = 10;

/**
 * Allow this many orphan classes regardless of ratio. State helpers
 * (`.is-active`, `.is-open`, `.sr-only`) don't always need a rule.
 */
const ABSOLUTE_ORPHAN_TOLERANCE = 15;

/**
 * Fail the check when more than this fraction of HTML classes have
 * no matching CSS rule. 25% means "at least 75% of the markup has
 * styles" — the threshold v6 cleared after manual rescue.
 */
const MAX_ORPHAN_RATIO = 0.25;

/**
 * How many orphan class names to surface in the violation message
 * so Forge has a concrete remediation list. Keep this bounded so
 * the message doesn't balloon past LLM context limits.
 */
const ORPHAN_SAMPLE_SIZE = 30;

// ── Public API ───────────────────────────────────────

/**
 * Run the CSS-completeness check against the produced artifact.
 * Returns the list of violations (zero or one) — single-violation
 * shape kept consistent with `runStaticAssetChecks`.
 */
export function runCssCompletenessCheck(
    repoPath: string,
    html: string,
): readonly CssCompletenessViolation[] {
    const htmlClasses = extractHtmlClasses(html);
    if (htmlClasses.size < MIN_HTML_CLASSES_TO_CHECK) {
        return [];
    }

    const cssClasses = extractCssClassesFromAllLinkedSheets(repoPath, html);
    const orphans = [...htmlClasses].filter((c) => !cssClasses.has(c)).sort();
    const orphanRatio = orphans.length / htmlClasses.size;

    const fails =
        orphans.length > ABSOLUTE_ORPHAN_TOLERANCE &&
        orphanRatio > MAX_ORPHAN_RATIO;

    if (!fails) return [];

    const sample = orphans.slice(0, ORPHAN_SAMPLE_SIZE);
    const more = orphans.length - sample.length;
    const sampleText = sample.map((c) => `.${c}`).join(', ');
    const moreText = more > 0 ? ` (+${more} more)` : '';
    const pct = Math.round(orphanRatio * 100);

    return [
        {
            check: 'orphan-css-classes',
            expected: 'every HTML class has a matching CSS rule',
            message:
                `${orphans.length} of ${htmlClasses.size} HTML classes (${pct}%) ` +
                `have no matching CSS rule — page renders unstyled. ` +
                `Add rules using the locked design tokens for: ${sampleText}${moreText}`,
        },
    ];
}

// ── Helpers ──────────────────────────────────────────

function extractHtmlClasses(html: string): ReadonlySet<string> {
    const out = new Set<string>();
    const re = /\sclass\s*=\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        for (const tok of m[1].split(/\s+/)) {
            const trimmed = tok.trim();
            if (trimmed.length > 0) out.add(trimmed);
        }
    }
    return out;
}

function extractCssClassesFromAllLinkedSheets(
    repoPath: string,
    html: string,
): ReadonlySet<string> {
    const out = new Set<string>();

    const cssBuf: string[] = [];
    const inlineStyle = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    let s: RegExpExecArray | null;
    while ((s = inlineStyle.exec(html)) !== null) {
        cssBuf.push(s[1]);
    }

    for (const sheet of collectLinkedStylesheets(html)) {
        if (isRemote(sheet.href)) continue;
        const rel = stripQueryHash(sheet.href);
        const full = path.resolve(repoPath, rel);
        try {
            if (fs.existsSync(full)) {
                cssBuf.push(fs.readFileSync(full, 'utf-8'));
            }
        } catch {
            // unreadable stylesheet is the static-asset gate's problem,
            // not ours — silently skip and check the rest.
        }
    }

    if (cssBuf.length === 0) {
        const fallback = path.resolve(repoPath, 'styles.css');
        try {
            if (fs.existsSync(fallback)) {
                cssBuf.push(fs.readFileSync(fallback, 'utf-8'));
            }
        } catch {
            // ignore
        }
    }

    const classRe = /\.([a-zA-Z_][a-zA-Z0-9_-]*)/g;
    for (const css of cssBuf) {
        const stripped = stripCssCommentsAndStrings(css);
        let cm: RegExpExecArray | null;
        while ((cm = classRe.exec(stripped)) !== null) {
            out.add(cm[1]);
        }
    }
    return out;
}

function collectLinkedStylesheets(html: string): readonly LinkedStylesheet[] {
    const out: LinkedStylesheet[] = [];
    const linkRe = /<link\b[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null) {
        const tag = m[0];
        if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) continue;
        const hrefMatch = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
        if (hrefMatch !== null) out.push({ href: hrefMatch[1] });
    }
    return out;
}

function stripCssCommentsAndStrings(css: string): string {
    return css
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

function isRemote(href: string): boolean {
    return /^(https?:|\/\/|data:)/i.test(href);
}

function stripQueryHash(href: string): string {
    const i = href.search(/[?#]/);
    return i === -1 ? href : href.slice(0, i);
}
