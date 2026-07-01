/**
 * artifact-metadata-panel unit tests (B-428).
 *
 * Covers the pure render helpers — no DOM required. The panel module
 * returns HTML strings so the tests assert on substring patterns and
 * structural markers (`<dl>`, `<details>`, status badge class).
 */

import { describe, it, expect } from 'vitest';
import {
    renderMetadataPanel,
    formatTaskDuration,
    formatCostUsd,
    formatTokenCount,
    type TaskDetails,
} from '../../src/renderer/command-center/artifact-metadata-panel';

const completedTask: TaskDetails = {
    id: 'task-1',
    title: 'Build landing page',
    description: 'Emit index.html with hero + CTA',
    status: 'completed',
    phase: 'development',
    taskType: 'ui-build',
    assignedAgent: 'pixel',
    retryCount: 2,
    qualityScore: 8.5,
    errorMessage: null,
    branchName: 'agent/pixel/task-1',
    outputPath: 'index.html',
    createdAtIso: '2026-04-25T00:00:00.000Z',
    startedAtIso: '2026-04-25T00:00:05.000Z',
    completedAtIso: '2026-04-25T00:00:42.500Z',
    totalCostUsd: 0.0123,
    totalTokensIn: 1500,
    totalTokensOut: 3200,
    lastModel: 'claude-sonnet-4-6',
};

// ── renderMetadataPanel states ───────────────────────

describe('renderMetadataPanel', () => {
    it('returns empty string for hidden state', () => {
        expect(renderMetadataPanel({ kind: 'hidden' })).toBe('');
    });

    it('shows a loading stub', () => {
        const out = renderMetadataPanel({ kind: 'loading' });
        expect(out).toContain('Loading');
        expect(out).toContain('<details');
    });

    it('escapes error messages', () => {
        const out = renderMetadataPanel({ kind: 'error', message: '<script>alert(1)</script>' });
        expect(out).not.toContain('<script>alert(1)</script>');
        expect(out).toContain('&lt;script&gt;');
    });

    it('shows a neutral state when the producing task no longer exists', () => {
        const out = renderMetadataPanel({ kind: 'unknown-task' });
        expect(out).toMatch(/no longer exists/i);
    });

    it('renders core fields for a loaded task', () => {
        const out = renderMetadataPanel({ kind: 'loaded', task: completedTask });
        expect(out).toContain('Build landing page');
        expect(out).toContain('completed');
        expect(out).toContain('pixel');
        expect(out).toContain('development');
        expect(out).toContain('ui-build');
        expect(out).toContain('agent/pixel/task-1');
        expect(out).toContain('claude-sonnet-4-6');
    });

    it('shows duration when started and completed are both present', () => {
        const out = renderMetadataPanel({ kind: 'loaded', task: completedTask });
        // 42.5s - 5s = 37.5s → "37.5 s"
        expect(out).toContain('37.5 s');
    });

    it('omits retry row when retryCount is zero', () => {
        const out = renderMetadataPanel({
            kind: 'loaded',
            task: { ...completedTask, retryCount: 0 },
        });
        expect(out).not.toMatch(/<dt[^>]*>Retries</);
    });

    it('renders an error block only when errorMessage is present', () => {
        const withError = renderMetadataPanel({
            kind: 'loaded',
            task: { ...completedTask, status: 'failed', errorMessage: 'Build crashed' },
        });
        expect(withError).toContain('Build crashed');
        expect(withError).toContain('ab-meta-block--error');
    });

    it('renders a status badge with a class derived from the status', () => {
        const out = renderMetadataPanel({ kind: 'loaded', task: completedTask });
        expect(out).toMatch(/ab-meta-badge--completed/);
    });

    it('escapes HTML in description', () => {
        const out = renderMetadataPanel({
            kind: 'loaded',
            task: { ...completedTask, description: '<img src=x onerror=alert(1)>' },
        });
        expect(out).not.toContain('<img src=x');
        expect(out).toContain('&lt;img src=x');
    });

    it('omits Tokens row when both in and out are null', () => {
        const out = renderMetadataPanel({
            kind: 'loaded',
            task: { ...completedTask, totalTokensIn: null, totalTokensOut: null },
        });
        expect(out).not.toMatch(/<dt[^>]*>Tokens</);
    });
});

// ── Pure formatters ──────────────────────────────────

describe('formatTaskDuration', () => {
    it('returns null when either side is missing', () => {
        expect(formatTaskDuration(null, '2026-04-25T00:00:00Z')).toBeNull();
        expect(formatTaskDuration('2026-04-25T00:00:00Z', null)).toBeNull();
    });

    it('returns null when end precedes start', () => {
        expect(formatTaskDuration('2026-04-25T00:00:10Z', '2026-04-25T00:00:00Z')).toBeNull();
    });

    it('formats sub-second as ms', () => {
        expect(formatTaskDuration('2026-04-25T00:00:00.000Z', '2026-04-25T00:00:00.450Z')).toBe('450 ms');
    });

    it('formats seconds', () => {
        expect(formatTaskDuration('2026-04-25T00:00:00Z', '2026-04-25T00:00:12Z')).toBe('12.0 s');
    });

    it('formats minutes', () => {
        expect(formatTaskDuration('2026-04-25T00:00:00Z', '2026-04-25T00:03:30Z')).toBe('3.5 min');
    });

    it('formats hours', () => {
        expect(formatTaskDuration('2026-04-25T00:00:00Z', '2026-04-25T02:30:00Z')).toBe('2.5 h');
    });
});

describe('formatCostUsd', () => {
    it('returns null for null', () => {
        expect(formatCostUsd(null)).toBeNull();
    });

    it('returns $0.00 for zero', () => {
        expect(formatCostUsd(0)).toBe('$0.00');
    });

    it('uses six decimals for sub-cent amounts', () => {
        expect(formatCostUsd(0.001234)).toBe('$0.001234');
    });

    it('uses four decimals for sub-dollar amounts', () => {
        expect(formatCostUsd(0.1234)).toBe('$0.1234');
    });

    it('uses two decimals for dollars+', () => {
        expect(formatCostUsd(1.234567)).toBe('$1.23');
    });
});

describe('formatTokenCount', () => {
    it('returns null for null', () => {
        expect(formatTokenCount(null)).toBeNull();
    });

    it('inserts thousands separators', () => {
        expect(formatTokenCount(1234567)).toBe('1,234,567');
    });
});
