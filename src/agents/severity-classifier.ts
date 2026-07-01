/**
 * Severity classification system for code review findings.
 * Three-tier model matching Anthropic's Code Review: Important / Nit / Pre-existing.
 *
 * B-215
 */

// ── Types ───────────────────────────────────────────

/** Three-tier severity matching Anthropic Code Review */
export type SeverityClass = 'important' | 'nit' | 'pre-existing';

export interface ClassifiedFinding {
    readonly severityClass: SeverityClass;
    readonly originalSeverity: string;
    readonly file: string;
    readonly line: number | null;
    readonly message: string;
    readonly reasoning: string;
}

export interface ClassificationResult {
    readonly findings: readonly ClassifiedFinding[];
    readonly importantCount: number;
    readonly nitCount: number;
    readonly preExistingCount: number;
    readonly blockRelease: boolean;
}

interface RawFinding {
    readonly file: string;
    readonly line: number | null;
    readonly severity: string;
    readonly message: string;
}

// ── Prompt Builder ──────────────────────────────────

/**
 * Builds a prompt asking the AI to classify each finding as important/nit/pre-existing.
 * Includes the list of changed files so the AI can distinguish pre-existing issues.
 */
export function buildClassificationPrompt(
    findings: readonly RawFinding[],
    changedFiles: readonly string[],
): string {
    const changedList = changedFiles.length > 0
        ? changedFiles.map(f => `  - ${f}`).join('\n')
        : '  (none)';

    const findingsList = findings.map((f, idx) => {
        const line = f.line !== null ? String(f.line) : 'unknown';
        return [
            `Finding #${idx + 1}:`,
            `  FILE: ${f.file}`,
            `  LINE: ${line}`,
            `  SEVERITY: ${f.severity}`,
            `  MESSAGE: ${f.message}`,
        ].join('\n');
    }).join('\n\n');

    return [
        'You are a code review classifier. Classify each finding below as one of:',
        '  important  — must be fixed before release (new issue introduced in this change)',
        '  nit        — worth fixing but not blocking (style, minor quality, new change)',
        '  pre-existing — not introduced by this change (file not in changed files list)',
        '',
        'Changed files in this diff:',
        changedList,
        '',
        'Findings to classify:',
        findingsList,
        '',
        'For each finding, respond with a block in this exact format:',
        '--- CLASSIFIED ---',
        'FILE: <file>',
        'LINE: <line or null>',
        'CLASS: <important|nit|pre-existing>',
        'ORIGINAL_SEVERITY: <original severity>',
        'MESSAGE: <message>',
        'REASONING: <one-sentence explanation>',
        '--- END CLASSIFIED ---',
        '',
        'Repeat the block for every finding. Do not skip any.',
    ].join('\n');
}

// ── Parser ──────────────────────────────────────────

const BLOCK_RE =
    /--- CLASSIFIED ---\s*\nFILE:\s*(.+?)\s*\nLINE:\s*(.+?)\s*\nCLASS:\s*(important|nit|pre-existing)\s*\nORIGINAL_SEVERITY:\s*(.+?)\s*\nMESSAGE:\s*(.+?)\s*\nREASONING:\s*(.+?)\s*\n--- END CLASSIFIED ---/gi;

function parseLine(raw: string): number | null {
    const trimmed = raw.trim();
    if (trimmed === 'null' || trimmed === 'unknown' || trimmed === '') return null;
    const n = parseInt(trimmed, 10);
    return isNaN(n) ? null : n;
}

function toSeverityClass(raw: string): SeverityClass {
    const lower = raw.trim().toLowerCase();
    if (lower === 'important' || lower === 'nit' || lower === 'pre-existing') {
        return lower as SeverityClass;
    }
    return 'nit';
}

/**
 * Parses structured classification output from AI.
 * Falls back to loose line-by-line parsing if structured blocks not found.
 */
export function parseClassification(aiOutput: string): readonly ClassifiedFinding[] {
    const findings: ClassifiedFinding[] = [];
    let match: RegExpExecArray | null;

    BLOCK_RE.lastIndex = 0;
    while ((match = BLOCK_RE.exec(aiOutput)) !== null) {
        findings.push({
            file: match[1].trim(),
            line: parseLine(match[2]),
            severityClass: toSeverityClass(match[3]),
            originalSeverity: match[4].trim(),
            message: match[5].trim(),
            reasoning: match[6].trim(),
        });
    }

    if (findings.length > 0) return findings;

    // Loose fallback: scan for key:value lines
    return parseLoose(aiOutput);
}

function parseLoose(text: string): readonly ClassifiedFinding[] {
    const findings: ClassifiedFinding[] = [];
    const lines = text.split('\n');

    let file = '';
    let line: number | null = null;
    let severityClass: SeverityClass = 'nit';
    let originalSeverity = '';
    let message = '';
    let reasoning = '';
    let inBlock = false;

    const flush = (): void => {
        if (inBlock && file) {
            findings.push({ file, line, severityClass, originalSeverity, message, reasoning });
        }
    };

    for (const raw of lines) {
        const trimmed = raw.trim();
        if (trimmed === '--- CLASSIFIED ---') {
            flush();
            file = ''; line = null; severityClass = 'nit';
            originalSeverity = ''; message = ''; reasoning = '';
            inBlock = true;
            continue;
        }
        if (trimmed === '--- END CLASSIFIED ---') {
            flush();
            inBlock = false;
            continue;
        }
        if (!inBlock) continue;

        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;
        const key = trimmed.slice(0, colonIdx).trim().toUpperCase();
        const value = trimmed.slice(colonIdx + 1).trim();

        if (key === 'FILE') file = value;
        else if (key === 'LINE') line = parseLine(value);
        else if (key === 'CLASS') severityClass = toSeverityClass(value);
        else if (key === 'ORIGINAL_SEVERITY') originalSeverity = value;
        else if (key === 'MESSAGE') message = value;
        else if (key === 'REASONING') reasoning = value;
    }

    flush();
    return findings;
}

// ── Heuristic Classifier ────────────────────────────

/**
 * Quick heuristic (no AI needed):
 *   - If file NOT in changedFiles → 'pre-existing'
 *   - If severity is 'critical' or 'high' → 'important'
 *   - Otherwise → 'nit'
 */
export function classifyBySeverityHeuristic(
    finding: { readonly severity: string; readonly file: string },
    changedFiles: readonly string[],
): SeverityClass {
    if (!changedFiles.includes(finding.file)) return 'pre-existing';
    const lower = finding.severity.toLowerCase();
    if (lower === 'critical' || lower === 'high') return 'important';
    return 'nit';
}

// ── Result Builder ──────────────────────────────────

/**
 * Counts each class and sets blockRelease = importantCount > 0.
 */
export function buildClassificationResult(
    findings: readonly ClassifiedFinding[],
): ClassificationResult {
    const importantCount = findings.filter(f => f.severityClass === 'important').length;
    const nitCount = findings.filter(f => f.severityClass === 'nit').length;
    const preExistingCount = findings.filter(f => f.severityClass === 'pre-existing').length;
    return {
        findings,
        importantCount,
        nitCount,
        preExistingCount,
        blockRelease: importantCount > 0,
    };
}

// ── Report Formatter ────────────────────────────────

/**
 * Formats a markdown report with sections for each class and a release gate status.
 */
export function formatClassifiedReport(result: ClassificationResult): string {
    const lines: string[] = [];

    lines.push('## Code Review Classification Report');
    lines.push('');

    // Important
    lines.push(`### 🔴 Important (${result.importantCount})`);
    const important = result.findings.filter(f => f.severityClass === 'important');
    if (important.length === 0) {
        lines.push('_No important findings._');
    } else {
        for (const f of important) {
            const loc = f.line !== null ? `:${f.line}` : '';
            lines.push(`- 🔴 **${f.file}${loc}** — ${f.message}`);
            lines.push(`  > ${f.reasoning}`);
        }
    }
    lines.push('');

    // Nit
    lines.push(`### 🟡 Nit (${result.nitCount})`);
    const nits = result.findings.filter(f => f.severityClass === 'nit');
    if (nits.length === 0) {
        lines.push('_No nit findings._');
    } else {
        for (const f of nits) {
            const loc = f.line !== null ? `:${f.line}` : '';
            lines.push(`- 🟡 **${f.file}${loc}** — ${f.message}`);
            lines.push(`  > ${f.reasoning}`);
        }
    }
    lines.push('');

    // Pre-existing
    lines.push(`### 🟣 Pre-existing (${result.preExistingCount})`);
    const preExisting = result.findings.filter(f => f.severityClass === 'pre-existing');
    if (preExisting.length === 0) {
        lines.push('_No pre-existing findings._');
    } else {
        for (const f of preExisting) {
            const loc = f.line !== null ? `:${f.line}` : '';
            lines.push(`- 🟣 **${f.file}${loc}** — ${f.message}`);
            lines.push(`  > ${f.reasoning}`);
        }
    }
    lines.push('');

    // Release gate
    lines.push('---');
    lines.push('');
    if (result.blockRelease) {
        lines.push('**Release gate: BLOCKED** — fix all important findings before releasing.');
    } else {
        lines.push('**Release gate: PASSED** — no important findings.');
    }

    return lines.join('\n');
}
