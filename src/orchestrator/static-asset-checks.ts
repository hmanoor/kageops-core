/**
 * Static-asset sanity checks for HTML artifacts.
 *
 * After the spec-rule gate, KageOps used to stop at "does index.html
 * contain the expected IDs?". That passed for the 2026-04-22 GreenThumb
 * run even though the site was broken — markdown-fenced CSS, truncated
 * CSS, and a `<script src="script.js">` that 404'd. These checks cover
 * that class of failure without paying for a headless browser.
 *
 * Keep the checks cheap and deterministic. False positives here block
 * the pipeline, so err on the side of "obviously wrong" rather than
 * "statistically suspicious".
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Types ────────────────────────────────────────────

export type StaticAssetCheck =
    | 'missing-asset'
    | 'markdown-fenced-asset'
    | 'unbalanced-css-braces';

export interface StaticAssetViolation {
    readonly check: StaticAssetCheck;
    readonly expected: string;
    readonly message: string;
}

interface LinkedAsset {
    readonly href: string;
    readonly kind: 'css' | 'js';
}

// ── Public API ───────────────────────────────────────

/**
 * Run every static-asset check against the produced artifact. Returns
 * the list of violations found; empty array means the artifact passes.
 */
export function runStaticAssetChecks(
    repoPath: string,
    html: string,
): readonly StaticAssetViolation[] {
    const violations: StaticAssetViolation[] = [];
    const assets = collectLinkedAssets(html);

    for (const asset of assets) {
        if (isRemote(asset.href)) continue;

        const relPath = stripQueryHash(asset.href);
        const fullPath = path.resolve(repoPath, relPath);

        if (!fs.existsSync(fullPath)) {
            violations.push({
                check: 'missing-asset',
                expected: relPath,
                message: `Linked ${asset.kind.toUpperCase()} file does not exist on disk: ${relPath}`,
            });
            continue;
        }

        const content = safeRead(fullPath);
        if (content === null) continue;

        if (hasMarkdownFence(content)) {
            violations.push({
                check: 'markdown-fenced-asset',
                expected: relPath,
                message: `${relPath} contains a markdown code fence (\`\`\`) — Forge output was not cleaned up`,
            });
        }

        if (asset.kind === 'css' && !hasBalancedBraces(content)) {
            violations.push({
                check: 'unbalanced-css-braces',
                expected: relPath,
                message: `${relPath} has unbalanced \`{\` and \`}\` — CSS likely truncated mid-rule`,
            });
        }
    }

    return violations;
}

// ── Helpers (exported for tests) ─────────────────────

/**
 * Extract every `<link rel="stylesheet" href>` and `<script src>` URL
 * from an HTML document. Regex-based — deliberately forgiving of
 * arbitrary attribute order and case.
 */
export function collectLinkedAssets(html: string): readonly LinkedAsset[] {
    const out: LinkedAsset[] = [];

    // <link ... href="..."> where rel=stylesheet (or omitted — most
    // <link> tags in static sites are stylesheets anyway).
    const linkPattern = /<link\b([^>]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkPattern.exec(html)) !== null) {
        const attrs = m[1];
        const rel = attr(attrs, 'rel');
        if (rel !== null && !/stylesheet/i.test(rel)) continue;
        const href = attr(attrs, 'href');
        if (href !== null && href !== '') {
            out.push({ href, kind: 'css' });
        }
    }

    const scriptPattern = /<script\b([^>]*)>/gi;
    while ((m = scriptPattern.exec(html)) !== null) {
        const attrs = m[1];
        const src = attr(attrs, 'src');
        if (src !== null && src !== '') {
            out.push({ href: src, kind: 'js' });
        }
    }

    return out;
}

/** True if the URL points off-host (http, https, //cdn, data:). */
export function isRemote(url: string): boolean {
    return /^(?:https?:)?\/\//i.test(url) || url.startsWith('data:');
}

/**
 * True if the file looks like it was copied out of an LLM response with
 * the markdown code fence left in. Handles both ` ```css ` and bare ` ``` `
 * anywhere in the file (Forge on the GreenThumb run left a leading
 * fence without a closing one).
 */
export function hasMarkdownFence(content: string): boolean {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        if (/^\s*```/.test(line)) return true;
    }
    return false;
}

/**
 * Balance-check CSS-style braces. Strips strings and comments first so
 * legitimate `{` inside e.g. `content: "{"` doesn't skew the count. Not
 * a full parser — just catches files that were clearly cut short.
 */
export function hasBalancedBraces(css: string): boolean {
    const stripped = stripCssStringsAndComments(css);
    let open = 0;
    let close = 0;
    for (const ch of stripped) {
        if (ch === '{') open += 1;
        else if (ch === '}') close += 1;
    }
    return open === close;
}

// ── Internal ─────────────────────────────────────────

function attr(attrs: string, name: string): string | null {
    const re = new RegExp(
        `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
        'i',
    );
    const match = re.exec(attrs);
    if (match === null) return null;
    return match[1] ?? match[2] ?? match[3] ?? null;
}

function stripQueryHash(url: string): string {
    const q = url.indexOf('?');
    const h = url.indexOf('#');
    let end = url.length;
    if (q >= 0) end = Math.min(end, q);
    if (h >= 0) end = Math.min(end, h);
    return url.slice(0, end);
}

function safeRead(p: string): string | null {
    try {
        return fs.readFileSync(p, 'utf-8');
    } catch {
        return null;
    }
}

function stripCssStringsAndComments(css: string): string {
    let out = '';
    let i = 0;
    while (i < css.length) {
        const ch = css[i];
        // Block comment
        if (ch === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            if (end < 0) return out;
            i = end + 2;
            continue;
        }
        // Double-quoted string
        if (ch === '"') {
            const end = findUnescaped(css, i + 1, '"');
            if (end < 0) return out;
            i = end + 1;
            continue;
        }
        // Single-quoted string
        if (ch === "'") {
            const end = findUnescaped(css, i + 1, "'");
            if (end < 0) return out;
            i = end + 1;
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}

function findUnescaped(str: string, start: number, quote: string): number {
    for (let i = start; i < str.length; i += 1) {
        if (str[i] === '\\') { i += 1; continue; }
        if (str[i] === quote) return i;
    }
    return -1;
}
