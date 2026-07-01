import { describe, it, expect } from 'vitest';
import {
    createTrackedFinding,
    checkFileChanged,
    checkFindingResolved,
    resolveFindings,
    applyResolutions,
    formatResolutionReport,
    parseGitDiffForChangedLines,
    type TrackedFinding,
} from '../../src/agents/review-resolver';

// ── Helpers ──────────────────────────────────────────

function makeFinding(overrides: Partial<TrackedFinding> = {}): TrackedFinding {
    return {
        id: 'f1',
        file: 'src/foo.ts',
        line: 10,
        message: 'Use const',
        severity: 'high',
        status: 'open',
        resolvedBy: null,
        resolvedAt: null,
        ...overrides,
    };
}

// ── createTrackedFinding ─────────────────────────────

describe('createTrackedFinding', () => {
    it('creates an open finding with no resolution data', () => {
        const f = createTrackedFinding({ id: 'abc', file: 'a.ts', line: 5, message: 'msg', severity: 'low' });
        expect(f.status).toBe('open');
        expect(f.resolvedBy).toBeNull();
        expect(f.resolvedAt).toBeNull();
        expect(f.id).toBe('abc');
        expect(f.file).toBe('a.ts');
        expect(f.line).toBe(5);
    });
});

// ── checkFileChanged ─────────────────────────────────

describe('checkFileChanged', () => {
    it('returns true when file and line are in changedLines', () => {
        const map = new Map([['src/foo.ts', [10, 11, 12]]]);
        expect(checkFileChanged('src/foo.ts', 10, [], map)).toBe(true);
    });

    it('falls back to file-level check when file not in changedLines map', () => {
        const map = new Map<string, readonly number[]>();
        expect(checkFileChanged('src/foo.ts', 10, ['src/foo.ts'], map)).toBe(true);
    });

    it('returns false for unchanged files', () => {
        const map = new Map<string, readonly number[]>();
        expect(checkFileChanged('src/bar.ts', 10, ['src/foo.ts'], map)).toBe(false);
    });

    it('returns false when file is in map but line is not', () => {
        const map = new Map([['src/foo.ts', [20, 21]]]);
        expect(checkFileChanged('src/foo.ts', 10, ['src/foo.ts'], map)).toBe(false);
    });
});

// ── checkFindingResolved ─────────────────────────────

describe('checkFindingResolved', () => {
    it('resolves a finding whose file+line was changed', () => {
        const finding = makeFinding({ file: 'src/foo.ts', line: 10 });
        const map = new Map([['src/foo.ts', [10]]]);
        const check = checkFindingResolved(finding, [], map);
        expect(check.resolved).toBe(true);
        expect(check.findingId).toBe('f1');
    });

    it('keeps already-resolved finding as resolved', () => {
        const finding = makeFinding({ status: 'resolved', resolvedBy: 'sha123', resolvedAt: 1000 });
        const check = checkFindingResolved(finding, [], new Map());
        expect(check.resolved).toBe(true);
        expect(check.reason).toMatch(/already/i);
    });

    it('treats wont-fix as resolved', () => {
        const finding = makeFinding({ status: 'wont-fix' });
        const check = checkFindingResolved(finding, [], new Map());
        expect(check.resolved).toBe(true);
        expect(check.reason).toMatch(/wont-fix/i);
    });

    it('reports unchanged finding as not resolved', () => {
        const finding = makeFinding({ file: 'src/foo.ts', line: 10 });
        const check = checkFindingResolved(finding, [], new Map());
        expect(check.resolved).toBe(false);
    });
});

// ── resolveFindings ──────────────────────────────────

describe('resolveFindings', () => {
    it('counts resolved and open correctly', () => {
        const findings: readonly TrackedFinding[] = [
            makeFinding({ id: 'f1', file: 'src/a.ts', line: 1 }),
            makeFinding({ id: 'f2', file: 'src/b.ts', line: 2 }),
        ];
        const map = new Map([['src/a.ts', [1]]]);
        const result = resolveFindings(findings, [], map, 'agent-forge');
        expect(result.resolvedCount).toBe(1);
        expect(result.openCount).toBe(1);
    });

    it('builds a summary string with agent name and counts', () => {
        const findings: readonly TrackedFinding[] = [
            makeFinding({ id: 'f1', file: 'src/a.ts', line: 1 }),
        ];
        const map = new Map([['src/a.ts', [1]]]);
        const result = resolveFindings(findings, [], map, 'agent-forge');
        expect(result.summary).toContain('agent-forge');
        expect(result.summary).toContain('1/1');
    });

    it('does not mutate input findings', () => {
        const findings: readonly TrackedFinding[] = [makeFinding({ id: 'f1', file: 'src/a.ts', line: 1 })];
        const map = new Map([['src/a.ts', [1]]]);
        resolveFindings(findings, [], map, 'forge');
        expect(findings[0].status).toBe('open');
    });
});

// ── applyResolutions ─────────────────────────────────

describe('applyResolutions', () => {
    it('updates status to resolved immutably', () => {
        const findings: readonly TrackedFinding[] = [makeFinding({ id: 'f1' })];
        const checks = [{ findingId: 'f1', resolved: true, reason: 'changed' }];
        const updated = applyResolutions(findings, checks, 'sha-abc');
        expect(updated[0].status).toBe('resolved');
        expect(findings[0].status).toBe('open'); // original unchanged
    });

    it('sets resolvedBy and resolvedAt on resolved findings', () => {
        const before = Date.now();
        const findings: readonly TrackedFinding[] = [makeFinding({ id: 'f1' })];
        const checks = [{ findingId: 'f1', resolved: true, reason: 'changed' }];
        const updated = applyResolutions(findings, checks, 'sha-xyz');
        expect(updated[0].resolvedBy).toBe('sha-xyz');
        expect(updated[0].resolvedAt).toBeGreaterThanOrEqual(before);
    });

    it('leaves unresolved findings unchanged', () => {
        const findings: readonly TrackedFinding[] = [makeFinding({ id: 'f1' })];
        const checks = [{ findingId: 'f1', resolved: false, reason: 'not changed' }];
        const updated = applyResolutions(findings, checks, 'sha-abc');
        expect(updated[0].status).toBe('open');
        expect(updated[0].resolvedBy).toBeNull();
    });

    it('returns new array objects (immutable)', () => {
        const findings: readonly TrackedFinding[] = [makeFinding({ id: 'f1' })];
        const checks = [{ findingId: 'f1', resolved: true, reason: 'changed' }];
        const updated = applyResolutions(findings, checks, 'sha');
        expect(updated[0]).not.toBe(findings[0]);
    });
});

// ── formatResolutionReport ───────────────────────────

describe('formatResolutionReport', () => {
    it('includes resolved and open counts with emoji', () => {
        const result = {
            checks: [
                { findingId: 'f1', resolved: true, reason: 'changed' },
                { findingId: 'f2', resolved: false, reason: 'not changed' },
            ],
            resolvedCount: 1,
            openCount: 1,
            summary: 'test',
        };
        const report = formatResolutionReport(result);
        expect(report).toContain('✅');
        expect(report).toContain('🔴');
        expect(report).toContain('Resolved: 1');
        expect(report).toContain('Open: 1');
    });

    it('includes per-finding detail lines', () => {
        const result = {
            checks: [{ findingId: 'finding-99', resolved: true, reason: 'fixed' }],
            resolvedCount: 1,
            openCount: 0,
            summary: 'done',
        };
        const report = formatResolutionReport(result);
        expect(report).toContain('finding-99');
        expect(report).toContain('fixed');
    });
});

// ── parseGitDiffForChangedLines ──────────────────────

describe('parseGitDiffForChangedLines', () => {
    const sampleDiff = [
        'diff --git a/src/foo.ts b/src/foo.ts',
        'index abc..def 100644',
        '--- a/src/foo.ts',
        '+++ b/src/foo.ts',
        '@@ -5,3 +5,4 @@',
        ' unchanged',
        '+added line',
        ' another',
        'diff --git a/src/bar.ts b/src/bar.ts',
        '--- a/src/bar.ts',
        '+++ b/src/bar.ts',
        '@@ -1,2 +20,3 @@',
        '+new line',
    ].join('\n');

    it('extracts file paths from +++ b/ lines', () => {
        const map = parseGitDiffForChangedLines(sampleDiff);
        expect(map.has('src/foo.ts')).toBe(true);
        expect(map.has('src/bar.ts')).toBe(true);
    });

    it('extracts line numbers from @@ headers', () => {
        const map = parseGitDiffForChangedLines(sampleDiff);
        const fooLines = map.get('src/foo.ts');
        expect(fooLines).toBeDefined();
        // @@ -5,3 +5,4 @@ → new lines 5,6,7,8
        expect(fooLines).toContain(5);
        expect(fooLines).toContain(8);

        const barLines = map.get('src/bar.ts');
        // @@ -1,2 +20,3 @@ → new lines 20,21,22
        expect(barLines).toContain(20);
        expect(barLines).toContain(22);
    });

    it('returns empty map for empty diff', () => {
        const map = parseGitDiffForChangedLines('');
        expect(map.size).toBe(0);
    });
});
