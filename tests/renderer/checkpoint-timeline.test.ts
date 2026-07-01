/**
 * P1-01f checkpoint timeline renderer — unit tests for the pure
 * formatter helpers exported from agent-detail-panel.ts. The DOM
 * wiring itself is integration territory (covered by manual smoke);
 * these tests lock in the shape of the per-op summary line and the
 * tally aggregation in the <summary> header so a regression doesn't
 * silently change what operators see at a glance.
 */

import { describe, it, expect } from 'vitest';
import {
    formatCheckpointMeta,
    renderCheckpointTimeline,
    CheckpointTimelineEntry,
} from '../../src/renderer/command-center/agent-detail-panel';

function entry(overrides: Partial<CheckpointTimelineEntry>): CheckpointTimelineEntry {
    return {
        id: 'ck-1',
        opIndex: 0,
        opType: 'askai',
        status: 'completed',
        createdAt: '2026-05-23T10:00:00Z',
        completedAt: '2026-05-23T10:00:01Z',
        errorText: null,
        meta: {},
        ...overrides,
    };
}

describe('formatCheckpointMeta()', () => {
    it('askai line: model · tokensIn→tokensOut · costUsd (4 dp)', () => {
        const out = formatCheckpointMeta(entry({
            opType: 'askai',
            meta: {
                model: 'claude/claude-sonnet-4-20250514',
                tokensIn: 1234,
                tokensOut: 567,
                costUsd: 0.0123,
            },
        }));
        expect(out).toBe('claude/claude-sonnet-4-20250514 · 1234→567 tok · $0.0123');
    });

    it('askai line: falls back to em-dash when model missing', () => {
        const out = formatCheckpointMeta(entry({
            opType: 'askai',
            meta: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        }));
        expect(out).toBe('— · 0→0 tok · $0.0000');
    });

    it('write line: filePath (formatted bytes)', () => {
        expect(formatCheckpointMeta(entry({
            opType: 'write',
            meta: { filePath: 'src/index.ts', bytes: 512 },
        }))).toBe('src/index.ts (512 B)');

        expect(formatCheckpointMeta(entry({
            opType: 'write',
            meta: { filePath: 'app.js', bytes: 2048 },
        }))).toBe('app.js (2.0 KB)');

        expect(formatCheckpointMeta(entry({
            opType: 'write',
            meta: { filePath: 'bundle.js', bytes: 5 * 1024 * 1024 },
        }))).toBe('bundle.js (5.0 MB)');
    });

    it('exec line: command args → exit N', () => {
        expect(formatCheckpointMeta(entry({
            opType: 'exec',
            meta: { command: 'npm', args: 'test --silent', exitCode: 0 },
        }))).toBe('npm test --silent → exit 0');
    });

    it('exec line: omits exit suffix when exitCode is missing', () => {
        expect(formatCheckpointMeta(entry({
            opType: 'exec',
            meta: { command: 'npm', args: 'install' },
        }))).toBe('npm install');
    });

    it('other op: surfaces errorText when present', () => {
        expect(formatCheckpointMeta(entry({
            opType: 'other',
            errorText: 'unhandled state',
            meta: {},
        }))).toBe('unhandled state');
    });
});

describe('renderCheckpointTimeline()', () => {
    it('header tally: all completed → only completed pill', () => {
        const html = renderCheckpointTimeline([
            entry({ opIndex: 0, status: 'completed' }),
            entry({ opIndex: 1, status: 'completed' }),
            entry({ opIndex: 2, status: 'completed' }),
        ]);
        expect(html).toContain('3 ops');
        expect(html).toContain('3 completed');
        expect(html).not.toContain('in-flight');
        expect(html).not.toContain('failed</span>'); // failed tally pill specifically
    });

    it('header tally: mixed → all three pills with correct counts', () => {
        const html = renderCheckpointTimeline([
            entry({ opIndex: 0, status: 'completed' }),
            entry({ opIndex: 1, status: 'completed' }),
            entry({ opIndex: 2, status: 'in-flight' }),
            entry({ opIndex: 3, status: 'failed' }),
            entry({ opIndex: 4, status: 'failed' }),
        ]);
        expect(html).toContain('5 ops');
        expect(html).toContain('2 completed');
        expect(html).toContain('1 in-flight');
        expect(html).toContain('2 failed');
    });

    it('singular form: "1 op" not "1 ops"', () => {
        const html = renderCheckpointTimeline([entry({ opIndex: 0 })]);
        // The summary line has "1 op" followed by a newline + indentation
        // before the next bullet — assert on the singular form without
        // pinning whitespace.
        expect(html).toMatch(/1 op\b/);
        expect(html).not.toMatch(/1 ops\b/);
    });

    it('row HTML: includes the op_index, op_type badge, status pip', () => {
        const html = renderCheckpointTimeline([
            entry({
                opIndex: 7,
                opType: 'write',
                status: 'completed',
                meta: { filePath: 'index.html', bytes: 1024 },
            }),
        ]);
        expect(html).toContain('#7');
        expect(html).toContain('ckpt-type--write');
        expect(html).toContain('ckpt-status--completed');
        expect(html).toContain('index.html');
    });

    it('escapes HTML in meta values (no XSS via filePath)', () => {
        const html = renderCheckpointTimeline([
            entry({
                opType: 'write',
                meta: { filePath: '<script>alert(1)</script>', bytes: 0 },
            }),
        ]);
        expect(html).not.toContain('<script>alert');
        expect(html).toContain('&lt;script&gt;');
    });

    it('renders inside a <details> element open by default', () => {
        const html = renderCheckpointTimeline([entry({ opIndex: 0 })]);
        expect(html).toContain('<details class="checkpoint-timeline" open>');
    });
});
