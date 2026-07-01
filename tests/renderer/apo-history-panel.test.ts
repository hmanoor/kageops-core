/**
 * APO History / Diff Panel — renderer unit tests
 *
 * No jsdom. Pure helpers + HTML string builders are exercised directly;
 * DOM interactions are covered by integration tests downstream.
 */

import { describe, it, expect } from 'vitest';
import {
    diffLines,
    formatReward,
    formatRelative,
    escapeHtml,
    statusBadgeClass,
    buildHistoryHtml,
    buildDiffHtml,
    buildFilterChipsHtml,
    filterByStatus,
    APO_STATUS_FILTERS,
    type PromptOptimizationRecord,
} from '../../src/renderer/command-center/apo-history-panel';

// ── fixtures ──────────────────────────────────────────

function makeRecord(overrides: Partial<PromptOptimizationRecord> = {}): PromptOptimizationRecord {
    return {
        id: 'opt-123',
        agentName: 'scout',
        baselinePrompt: 'You are a scout.\nGather intel.',
        optimizedPrompt: 'You are a scout.\nGather intel carefully.\nReport findings.',
        baselineReward: 0.42,
        optimizedReward: 0.51,
        rewardDelta: 0.09,
        beamWidth: 4,
        branchFactor: 3,
        rounds: 2,
        nSamples: 6,
        status: 'proposed',
        createdAt: '2026-04-20T10:00:00.000Z',
        appliedAt: null,
        ...overrides,
    };
}

// ── diffLines ─────────────────────────────────────────

describe('diffLines', () => {
    it('returns a single same-line for identical inputs', () => {
        const out = diffLines('hello world', 'hello world');
        expect(out).toEqual([{ kind: 'same', text: 'hello world' }]);
    });

    it('marks pure additions as added', () => {
        const out = diffLines('', 'alpha\nbeta');
        // a is '' → one empty line; b is 'alpha\nbeta' → two lines.
        // LCS is 0 (no shared line); expect two added lines plus the empty same line.
        const added = out.filter((r) => r.kind === 'added').map((r) => r.text);
        expect(added).toEqual(['alpha', 'beta']);
    });

    it('marks pure removals as removed', () => {
        const out = diffLines('alpha\nbeta', '');
        const removed = out.filter((r) => r.kind === 'removed').map((r) => r.text);
        expect(removed).toEqual(['alpha', 'beta']);
    });

    it('mixes same + added when lines are appended', () => {
        const out = diffLines('a\nb', 'a\nb\nc');
        expect(out).toEqual([
            { kind: 'same', text: 'a' },
            { kind: 'same', text: 'b' },
            { kind: 'added', text: 'c' },
        ]);
    });

    it('marks middle-line replacement as removed + added', () => {
        const out = diffLines('a\nb\nc', 'a\nB\nc');
        // Shared: a, c. Middle 'b' removed, 'B' added.
        expect(out.map((r) => r.kind)).toEqual(['same', 'removed', 'added', 'same']);
        expect(out.find((r) => r.kind === 'removed')?.text).toBe('b');
        expect(out.find((r) => r.kind === 'added')?.text).toBe('B');
    });

    it('preserves line ordering in output', () => {
        const out = diffLines('x\ny\nz', 'x\ny\nQ\nz');
        const kinds = out.map((r) => r.kind);
        // x same, y same, Q added, z same — added must appear before the final same.
        const lastSameIdx = kinds.lastIndexOf('same');
        const addedIdx = kinds.indexOf('added');
        expect(addedIdx).toBeLessThan(lastSameIdx);
    });
});

// ── formatReward ──────────────────────────────────────

describe('formatReward', () => {
    it('formats positive with plus sign', () => {
        expect(formatReward(0.1234)).toBe('+0.1234');
    });
    it('formats negative without a sign prefix (minus comes from number)', () => {
        expect(formatReward(-0.0056)).toBe('-0.0056');
    });
    it('formats zero without plus sign', () => {
        expect(formatReward(0)).toBe('0.0000');
    });
    it('returns em-dash for non-finite', () => {
        expect(formatReward(NaN)).toBe('—');
        expect(formatReward(Infinity)).toBe('—');
    });
});

// ── formatRelative ────────────────────────────────────

describe('formatRelative', () => {
    const now = new Date('2026-04-21T12:00:00.000Z');

    it('says "just now" within the last minute', () => {
        expect(formatRelative('2026-04-21T11:59:30.000Z', now)).toBe('just now');
    });
    it('formats minutes', () => {
        expect(formatRelative('2026-04-21T11:45:00.000Z', now)).toBe('15m ago');
    });
    it('formats hours', () => {
        expect(formatRelative('2026-04-21T09:00:00.000Z', now)).toBe('3h ago');
    });
    it('formats days', () => {
        expect(formatRelative('2026-04-19T12:00:00.000Z', now)).toBe('2d ago');
    });
    it('falls back to ISO date for > 7d', () => {
        expect(formatRelative('2026-04-01T12:00:00.000Z', now)).toBe('2026-04-01');
    });
    it('passes through unparseable input verbatim', () => {
        expect(formatRelative('not-a-date', now)).toBe('not-a-date');
    });
});

// ── escapeHtml ────────────────────────────────────────

describe('escapeHtml', () => {
    it('escapes the five HTML entities', () => {
        expect(escapeHtml('<a href="x">&\'</a>')).toBe(
            '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;'
        );
    });
    it('is a no-op for plain text', () => {
        expect(escapeHtml('plain text 123')).toBe('plain text 123');
    });
});

// ── statusBadgeClass ──────────────────────────────────

describe('statusBadgeClass', () => {
    it('returns proposed class', () => {
        expect(statusBadgeClass('proposed')).toBe('apo-status-proposed');
    });
    it('returns accepted class', () => {
        expect(statusBadgeClass('accepted')).toBe('apo-status-accepted');
    });
    it('returns rolled_back class', () => {
        expect(statusBadgeClass('rolled_back')).toBe('apo-status-rolled-back');
    });
});

// ── buildHistoryHtml ──────────────────────────────────

describe('buildHistoryHtml', () => {
    const now = new Date('2026-04-21T12:00:00.000Z');

    it('renders APO-disabled empty state when there are no records (decision #48)', () => {
        const html = buildHistoryHtml([], now);
        expect(html).toContain('Automatic Prompt Optimization is disabled');
        expect(html).toContain('KAGEOPS_APO_ENABLED=1');
        expect(html).toContain('data-action="apo-history-refresh"');
    });

    it('renders a row per record with agent and delta', () => {
        const records = [
            makeRecord({ id: 'a', agentName: 'scout', rewardDelta: 0.12 }),
            makeRecord({ id: 'b', agentName: 'herald', rewardDelta: -0.03 }),
        ];
        const html = buildHistoryHtml(records, now);
        expect(html).toContain('data-history-row="a"');
        expect(html).toContain('data-history-row="b"');
        expect(html).toContain('scout');
        expect(html).toContain('herald');
        expect(html).toContain('+0.1200');
        expect(html).toContain('-0.0300');
    });

    it('applies delta-pos class for positive deltas and delta-neg for negative', () => {
        const records = [
            makeRecord({ id: 'pos', rewardDelta: 0.01 }),
            makeRecord({ id: 'neg', rewardDelta: -0.02 }),
        ];
        const html = buildHistoryHtml(records, now);
        expect(html).toContain('apo-delta-pos');
        expect(html).toContain('apo-delta-neg');
    });

    it('escapes agent names containing HTML', () => {
        const records = [makeRecord({ agentName: '<script>' })];
        const html = buildHistoryHtml(records, now);
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('emits status badges', () => {
        const records = [
            makeRecord({ id: '1', status: 'proposed' }),
            makeRecord({ id: '2', status: 'accepted' }),
            makeRecord({ id: '3', status: 'rolled_back' }),
        ];
        const html = buildHistoryHtml(records, now);
        expect(html).toContain('apo-status-proposed');
        expect(html).toContain('apo-status-accepted');
        expect(html).toContain('apo-status-rolled-back');
    });

    it('includes an empty detail placeholder for the diff pane', () => {
        const html = buildHistoryHtml([makeRecord()], now);
        expect(html).toContain('data-apo-history-detail');
        expect(html).toContain('Select a row to view the prompt diff');
    });
});

// ── buildDiffHtml ─────────────────────────────────────

describe('buildDiffHtml', () => {
    it('renders baseline + optimized reward lines', () => {
        const record = makeRecord({
            baselineReward: 0.42,
            optimizedReward: 0.51,
            rewardDelta: 0.09,
        });
        const html = buildDiffHtml(record);
        expect(html).toContain('+0.4200');
        expect(html).toContain('+0.5100');
        expect(html).toContain('+0.0900');
    });

    it('renders diff sigils for added / removed / same lines', () => {
        const record = makeRecord({
            baselinePrompt: 'same\nold-line',
            optimizedPrompt: 'same\nnew-line',
        });
        const html = buildDiffHtml(record);
        expect(html).toContain('apo-diff-same');
        expect(html).toContain('apo-diff-add');
        expect(html).toContain('apo-diff-del');
    });

    it('shows "—" for missing applied timestamp', () => {
        const record = makeRecord({ appliedAt: null });
        const html = buildDiffHtml(record);
        // Ensure the Applied label is followed by a dash (not a real timestamp).
        expect(html).toMatch(/Applied:<\/strong>\s*—/);
    });

    it('shows applied timestamp when present', () => {
        const record = makeRecord({ appliedAt: '2026-04-20T11:00:00.000Z' });
        const html = buildDiffHtml(record);
        expect(html).toContain('2026-04-20T11:00:00.000Z');
    });

    it('escapes prompt content when rendering diff', () => {
        const record = makeRecord({
            baselinePrompt: '<script>alert(1)</script>',
            optimizedPrompt: '<b>safe</b>',
        });
        const html = buildDiffHtml(record);
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).not.toContain('<b>safe</b>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('&lt;b&gt;safe&lt;/b&gt;');
    });

    it('renders search metadata (beam, branch, rounds)', () => {
        const record = makeRecord({ beamWidth: 5, branchFactor: 4, rounds: 3 });
        const html = buildDiffHtml(record);
        expect(html).toContain('beam=5');
        expect(html).toContain('branch=4');
        expect(html).toContain('rounds=3');
    });
});

// ── filterByStatus (P4) ───────────────────────────────

describe('filterByStatus', () => {
    const records = [
        makeRecord({ id: 'a', status: 'proposed' }),
        makeRecord({ id: 'b', status: 'accepted' }),
        makeRecord({ id: 'c', status: 'rolled_back' }),
        makeRecord({ id: 'd', status: 'proposed' }),
    ];

    it('returns the same reference when filter is "all"', () => {
        expect(filterByStatus(records, 'all')).toBe(records);
    });

    it('keeps only proposed rows', () => {
        const out = filterByStatus(records, 'proposed');
        expect(out.map((r) => r.id)).toEqual(['a', 'd']);
    });

    it('keeps only accepted rows', () => {
        expect(filterByStatus(records, 'accepted').map((r) => r.id)).toEqual(['b']);
    });

    it('keeps only rolled_back rows', () => {
        expect(filterByStatus(records, 'rolled_back').map((r) => r.id)).toEqual(['c']);
    });

    it('returns an empty array when nothing matches', () => {
        const onlyAccepted = [makeRecord({ status: 'accepted' })];
        expect(filterByStatus(onlyAccepted, 'proposed')).toEqual([]);
    });
});

// ── buildFilterChipsHtml (P4) ─────────────────────────

describe('buildFilterChipsHtml', () => {
    it('emits one chip per status, in canonical order', () => {
        const html = buildFilterChipsHtml('all');
        for (const f of APO_STATUS_FILTERS) {
            expect(html).toContain(`data-apo-filter="${f}"`);
        }
    });

    it('marks the active filter with the --active class', () => {
        const html = buildFilterChipsHtml('accepted');
        expect(html).toMatch(/class="apo-filter-chip apo-filter-chip--active"\s+data-apo-filter="accepted"/);
        // Other chips should NOT carry the active class.
        expect(html).toMatch(/class="apo-filter-chip"\s+data-apo-filter="proposed"/);
    });

    it('humanizes rolled_back as "rolled back"', () => {
        const html = buildFilterChipsHtml('all');
        expect(html).toContain('>rolled back<');
        expect(html).not.toContain('>rolled_back<');
    });
});

// ── buildHistoryHtml with actions (P4) ────────────────

describe('buildHistoryHtml — action column', () => {
    const now = new Date('2026-04-22T10:00:00.000Z');

    it('omits the Actions column header when canAct is false', () => {
        const html = buildHistoryHtml([makeRecord()], now, { canAct: false });
        expect(html).not.toContain('<span>Actions</span>');
        expect(html).not.toContain('data-apo-action');
    });

    it('renders Accept + Reject buttons on proposed rows when canAct is true', () => {
        const html = buildHistoryHtml([makeRecord({ status: 'proposed' })], now, { canAct: true });
        expect(html).toContain('data-apo-action="accept"');
        expect(html).toContain('data-apo-action="reject"');
        expect(html).toContain('data-apo-target="opt-123"');
    });

    it('renders a muted placeholder (no buttons) on non-proposed rows', () => {
        const html = buildHistoryHtml(
            [makeRecord({ id: 'opt-accepted', status: 'accepted' })],
            now,
            { canAct: true },
        );
        expect(html).toContain('apo-history-actions--muted');
        expect(html).not.toContain('data-apo-action="accept" data-apo-target="opt-accepted"');
    });

    it('still renders filter chips on the empty-state view', () => {
        const html = buildHistoryHtml([], now, { filter: 'proposed', canAct: true });
        expect(html).toContain('data-apo-filter="proposed"');
        expect(html).toContain('No optimizations match the &quot;proposed&quot; filter.');
    });

    it('escapes row ids into the action button data attributes', () => {
        const html = buildHistoryHtml(
            [makeRecord({ id: 'abc"><script>' })],
            now,
            { canAct: true },
        );
        expect(html).not.toContain('abc"><script>');
        expect(html).toContain('abc&quot;&gt;&lt;script&gt;');
    });
});
