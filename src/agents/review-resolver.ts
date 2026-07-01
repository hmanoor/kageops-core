/**
 * Auto-resolve review threads when an agent fixes flagged code.
 * Tracks findings mapped to code locations and marks them resolved after fix verification.
 *
 * B-221
 */

// ── Types ───────────────────────────────────────────

export interface TrackedFinding {
    readonly id: string;
    readonly file: string;
    readonly line: number;
    readonly message: string;
    readonly severity: string;
    readonly status: 'open' | 'resolved' | 'wont-fix';
    readonly resolvedBy: string | null;
    readonly resolvedAt: number | null;
}

export interface ResolutionCheck {
    readonly findingId: string;
    readonly resolved: boolean;
    readonly reason: string;
}

export interface ResolutionResult {
    readonly checks: readonly ResolutionCheck[];
    readonly resolvedCount: number;
    readonly openCount: number;
    readonly summary: string;
}

// ── Factory ─────────────────────────────────────────

/**
 * Creates an open tracked finding with no resolution data.
 */
export function createTrackedFinding(finding: {
    id: string;
    file: string;
    line: number;
    message: string;
    severity: string;
}): TrackedFinding {
    return {
        id: finding.id,
        file: finding.file,
        line: finding.line,
        message: finding.message,
        severity: finding.severity,
        status: 'open',
        resolvedBy: null,
        resolvedAt: null,
    };
}

// ── Change Detection ─────────────────────────────────

/**
 * Returns true if the file+line was modified in the fix.
 * Falls back to file-level check when per-line data is unavailable.
 */
export function checkFileChanged(
    file: string,
    line: number,
    changedFiles: readonly string[],
    changedLines: ReadonlyMap<string, readonly number[]>,
): boolean {
    const lines = changedLines.get(file);
    if (lines !== undefined) {
        return lines.includes(line);
    }
    return changedFiles.includes(file);
}

// ── Resolution Logic ─────────────────────────────────

/**
 * Checks if a single finding is resolved.
 * Resolved when its code location was changed, or it is already resolved/wont-fix.
 */
export function checkFindingResolved(
    finding: TrackedFinding,
    changedFiles: readonly string[],
    changedLines: ReadonlyMap<string, readonly number[]>,
): ResolutionCheck {
    if (finding.status === 'resolved') {
        return { findingId: finding.id, resolved: true, reason: 'Already marked resolved' };
    }
    if (finding.status === 'wont-fix') {
        return { findingId: finding.id, resolved: true, reason: 'Marked as wont-fix' };
    }
    const changed = checkFileChanged(finding.file, finding.line, changedFiles, changedLines);
    if (changed) {
        return { findingId: finding.id, resolved: true, reason: `${finding.file}:${finding.line} was modified in fix` };
    }
    return { findingId: finding.id, resolved: false, reason: `${finding.file}:${finding.line} not modified` };
}

/**
 * Checks all findings and returns a result with counts and summary.
 * Does NOT mutate input findings.
 */
export function resolveFindings(
    findings: readonly TrackedFinding[],
    changedFiles: readonly string[],
    changedLines: ReadonlyMap<string, readonly number[]>,
    resolvedBy: string,
): ResolutionResult {
    const checks = findings.map(f => checkFindingResolved(f, changedFiles, changedLines));
    const resolvedCount = checks.filter(c => c.resolved).length;
    const openCount = checks.length - resolvedCount;
    const summary = `${resolvedBy} resolved ${resolvedCount}/${checks.length} findings (${openCount} still open)`;
    return { checks, resolvedCount, openCount, summary };
}

/**
 * Returns a new array of findings with resolved ones updated.
 * Immutable — returns new objects, never mutates inputs.
 */
export function applyResolutions(
    findings: readonly TrackedFinding[],
    checks: readonly ResolutionCheck[],
    resolvedBy: string,
): readonly TrackedFinding[] {
    const checkMap = new Map<string, ResolutionCheck>(checks.map(c => [c.findingId, c]));
    const now = Date.now();
    return findings.map(finding => {
        const check = checkMap.get(finding.id);
        if (check?.resolved && finding.status === 'open') {
            return { ...finding, status: 'resolved' as const, resolvedBy, resolvedAt: now };
        }
        return finding;
    });
}

// ── Reporting ────────────────────────────────────────

/**
 * Formats a markdown resolution report with emoji status indicators.
 */
export function formatResolutionReport(result: ResolutionResult): string {
    const lines: string[] = [
        '## Review Resolution Report',
        '',
        `- ✅ Resolved: ${result.resolvedCount}`,
        `- 🔴 Open: ${result.openCount}`,
        '',
        '### Details',
        '',
    ];
    for (const check of result.checks) {
        const icon = check.resolved ? '✅' : '🔴';
        lines.push(`${icon} \`${check.findingId}\` — ${check.reason}`);
    }
    return lines.join('\n');
}

// ── Diff Parsing ─────────────────────────────────────

/**
 * Parses unified diff output to extract which files and line numbers were changed.
 * Handles `+++ b/file` and `@@ -old,count +new,start @@` patterns.
 */
export function parseGitDiffForChangedLines(diffOutput: string): ReadonlyMap<string, readonly number[]> {
    const result = new Map<string, number[]>();
    let currentFile: string | null = null;

    for (const rawLine of diffOutput.split('\n')) {
        const fileMatch = rawLine.match(/^\+\+\+ b\/(.+)$/);
        if (fileMatch) {
            currentFile = fileMatch[1];
            if (!result.has(currentFile)) {
                result.set(currentFile, []);
            }
            continue;
        }

        if (currentFile === null) continue;

        // @@ -oldStart,oldCount +newStart,newCount @@ ...
        const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (hunkMatch) {
            const newStart = parseInt(hunkMatch[1], 10);
            const newCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
            const lines = result.get(currentFile)!;
            for (let i = 0; i < newCount; i++) {
                lines.push(newStart + i);
            }
        }
    }

    return result as ReadonlyMap<string, readonly number[]>;
}
