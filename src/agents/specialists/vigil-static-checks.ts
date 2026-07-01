/**
 * Vigil — Deterministic Static Checks
 *
 * Pre-LLM rejection gate for code reviews. Catches whole classes of defects
 * that LLM reviewers miss (selector mismatches, dual scaffolds, etc.) with
 * zero token spend and 100% recall for the patterns it covers.
 *
 * Design: pure functions over a filename→content map. File I/O lives in
 * vigil.ts so these functions are trivial to unit-test.
 */

export type StaticCheckKind = 'id-mismatch' | 'dual-scaffold' | 'inline-css-bloat';

export interface StaticCheckViolation {
    readonly check: StaticCheckKind;
    readonly severity: 'critical' | 'high';
    readonly file: string;
    readonly message: string;
    readonly fix: string;
}

export interface StaticCheckResult {
    readonly passed: boolean;
    readonly violations: readonly StaticCheckViolation[];
    readonly summary: string;
}

export interface JsSelector {
    readonly value: string;
    readonly source: 'getElementById' | 'querySelector' | 'querySelectorAll';
}

// ── Extractors ───────────────────────────────────────

/**
 * Extract every `id="..."` attribute value from HTML content.
 */
export function extractHtmlIds(html: string): readonly string[] {
    const ids: string[] = [];
    const regex = /\bid\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(html)) !== null) {
        ids.push(m[1]);
    }
    return ids;
}

/**
 * Extract all DOM ID selectors referenced from JS/TS:
 * - getElementById("foo")
 * - querySelector("#foo") / querySelectorAll("#foo")
 *
 * Only string-literal arguments are captured; dynamic expressions
 * (variables, template literals) are intentionally ignored to avoid
 * false positives.
 */
export function extractJsSelectors(js: string): readonly JsSelector[] {
    const out: JsSelector[] = [];

    const byId = /getElementById\s*\(\s*["']([^"']+)["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = byId.exec(js)) !== null) {
        out.push({ value: m[1], source: 'getElementById' });
    }

    const querySel = /querySelector(All)?\s*\(\s*["']#([A-Za-z_][\w-]*)["']\s*\)/g;
    while ((m = querySel.exec(js)) !== null) {
        const source: JsSelector['source'] = m[1] === 'All' ? 'querySelectorAll' : 'querySelector';
        out.push({ value: m[2], source });
    }

    return out;
}

// ── Checks ───────────────────────────────────────────

/**
 * Flag JS selectors that reference IDs not present in any HTML file.
 * Skipped entirely if the project has no HTML files (not a frontend).
 */
export function checkHtmlJsIdMatches(
    files: ReadonlyMap<string, string>
): readonly StaticCheckViolation[] {
    const allHtmlIds = new Set<string>();
    for (const [name, content] of files) {
        if (name.endsWith('.html') || name.endsWith('.htm')) {
            for (const id of extractHtmlIds(content)) {
                allHtmlIds.add(id);
            }
        }
    }

    if (allHtmlIds.size === 0) {
        return [];
    }

    const violations: StaticCheckViolation[] = [];
    for (const [name, content] of files) {
        if (!/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(name)) continue;

        const seen = new Set<string>();
        for (const sel of extractJsSelectors(content)) {
            if (allHtmlIds.has(sel.value)) continue;
            const dedupKey = `${sel.source}:${sel.value}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);

            const known = Array.from(allHtmlIds).sort().join(', ');
            violations.push({
                check: 'id-mismatch',
                severity: 'critical',
                file: name,
                message: `${sel.source}("${sel.value}") references an element ID that does not exist in any HTML file. Known IDs: [${known}]`,
                fix: `Either rename the HTML element to id="${sel.value}", or change the JS selector to one of: [${known}]. Do NOT leave them out of sync.`,
            });
        }
    }
    return violations;
}

/**
 * Flag a repo that ships both a root static `index.html` AND a `package.json`
 * pulling in a build framework. Picking one scaffold is required — otherwise
 * the generated app is either two apps glued together or one broken app.
 */
export function checkDualScaffold(
    files: ReadonlyMap<string, string>
): readonly StaticCheckViolation[] {
    const hasStaticIndex = files.has('index.html');
    const pkgJson = files.get('package.json');
    if (!hasStaticIndex || pkgJson === undefined) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(pkgJson);
    } catch {
        return [];
    }
    if (typeof parsed !== 'object' || parsed === null) return [];

    const deps: Record<string, string> = {
        ...((parsed as { dependencies?: Record<string, string> }).dependencies ?? {}),
        ...((parsed as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
    };
    const frameworks: readonly string[] = [
        'react',
        'react-dom',
        'vue',
        'svelte',
        '@angular/core',
        'next',
        'vite',
        'rollup',
        'webpack',
        'parcel',
    ];
    const found = frameworks.filter((f) => deps[f] !== undefined);
    if (found.length === 0) return [];

    return [
        {
            check: 'dual-scaffold',
            severity: 'high',
            file: 'package.json',
            message: `Repo root contains BOTH a static index.html AND a package.json depending on build tooling (${found.join(', ')}). This is a dual scaffold — the two scaffolds do not share assets and the resulting app is broken.`,
            fix: 'Pick ONE scaffold. For a simple app (counter/todo/calc), delete package.json plus any src/, dist/, node_modules/, rollup/vite config and keep only index.html, styles.css, script.js. For a built SPA, move HTML into src/ and remove the root index.html.',
        },
    ];
}

/**
 * F-371: flag index.html that inlines a large <style> block instead of
 * emitting a separate styles.css file. Cap is 40 lines; below that an
 * inline block is fine (small components, critical above-the-fold CSS).
 * Above that, every line of inline CSS is a line of styles.css that
 * wasn't written — class-consistency checks can't see inline rules.
 */
const INLINE_STYLE_LINE_CAP = 40;

export function checkInlineCssBloat(
    files: ReadonlyMap<string, string>
): readonly StaticCheckViolation[] {
    const violations: StaticCheckViolation[] = [];
    for (const [name, content] of files) {
        if (!name.endsWith('.html') && !name.endsWith('.htm')) continue;
        const styleBlockRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
        let totalLines = 0;
        let m: RegExpExecArray | null;
        while ((m = styleBlockRegex.exec(content)) !== null) {
            totalLines += m[1].split('\n').length;
        }
        if (totalLines > INLINE_STYLE_LINE_CAP) {
            violations.push({
                check: 'inline-css-bloat',
                severity: 'high',
                file: name,
                message: `index.html inlines ${totalLines} lines of CSS inside <style> blocks (cap: ${INLINE_STYLE_LINE_CAP}). Class-consistency and design-system checks cannot read inline CSS — a separate styles.css is required for any non-trivial design.`,
                fix: `Move the CSS out of <style> blocks in ${name} into a separate styles.css at the project root. Link via <link rel="stylesheet" href="styles.css">. Keep <style> only for genuinely page-specific overrides (under ${INLINE_STYLE_LINE_CAP} lines).`,
            });
        }
    }
    return violations;
}

// ── Orchestration ────────────────────────────────────

export function runStaticChecks(
    files: ReadonlyMap<string, string>
): StaticCheckResult {
    const violations: readonly StaticCheckViolation[] = [
        ...checkHtmlJsIdMatches(files),
        ...checkDualScaffold(files),
        ...checkInlineCssBloat(files),
    ];
    const passed = violations.length === 0;
    const summary = passed
        ? 'Static checks passed'
        : violations
              .map((v) => `[${v.check} ${v.severity}] ${v.file}: ${v.message} FIX: ${v.fix}`)
              .join(' || ');
    return { passed, violations, summary };
}

/**
 * Render violations as a Markdown report for docs/reviews/code-review.md.
 */
export function formatViolationsReport(
    violations: readonly StaticCheckViolation[]
): string {
    const lines: string[] = [
        '# Code Review — Rejected by Deterministic Checks',
        '',
        `**${violations.length} violation(s)** were detected by static analysis before AI review ran. Fix these exactly before re-submitting.`,
        '',
    ];
    for (const v of violations) {
        lines.push(`## [${v.severity.toUpperCase()}] ${v.check} — \`${v.file}\``);
        lines.push('');
        lines.push(`**Problem:** ${v.message}`);
        lines.push('');
        lines.push(`**Required fix:** ${v.fix}`);
        lines.push('');
    }
    return lines.join('\n');
}
