/**
 * P1-05b — iteration history side-panel renderer.
 *
 * Locks in the markup the `<button class="iteration-badge">`-click
 * surfaces. DOM wiring (open the overlay, fetch via IPC) is integration
 * territory — these tests cover the pure formatter that converts a row
 * list into HTML.
 *
 * Reuses the same export-from-the-renderer pattern as the P1-01f
 * checkpoint timeline tests: pure function in the renderer module,
 * test pulls it directly.
 */

import { describe, it, expect } from 'vitest';
import {
    renderIterationHistory,
    IterationHistoryEntry as Row,
} from '../../src/renderer/command-center/iteration-history-renderer';

function row(overrides: Partial<Row>): Row {
    return {
        id: 'it-x',
        iterationIndex: 0,
        startedAt: '2026-05-24T00:00:00Z',
        endedAt: '2026-05-24T00:05:00Z',
        requirementText: null,
        ...overrides,
    };
}

describe('renderIterationHistory()', () => {
    it('empty state when no iterations exist', () => {
        const html = renderIterationHistory([]);
        expect(html).toContain('No iteration history yet');
        expect(html).not.toContain('iteration-row');
    });

    it('renders the summary line with closed/open counts', () => {
        const html = renderIterationHistory([
            row({ iterationIndex: 0, endedAt: '2026-05-24T00:05:00Z' }),
            row({ iterationIndex: 1, endedAt: null }),
        ]);
        expect(html).toContain('2 iterations');
        expect(html).toContain('1 closed');
        expect(html).toContain('1 open');
    });

    it('singular "1 iteration" not "1 iterations"', () => {
        const html = renderIterationHistory([row({ iterationIndex: 0 })]);
        expect(html).toMatch(/1 iteration\b/);
        expect(html).not.toMatch(/1 iterations\b/);
    });

    it('iteration 0 → "Original build" label, others → "Iteration N"', () => {
        const html = renderIterationHistory([
            row({ iterationIndex: 0 }),
            row({ iterationIndex: 1, requirementText: 'fix the dark-mode toggle' }),
            row({ iterationIndex: 7, requirementText: 'add a contact form' }),
        ]);
        expect(html).toContain('Original build');
        expect(html).toContain('Iteration 1');
        expect(html).toContain('Iteration 7');
    });

    it('open iteration gets the open class + visible "in flight" state', () => {
        const html = renderIterationHistory([
            row({ iterationIndex: 1, endedAt: null }),
        ]);
        expect(html).toContain('iteration-row--open');
        expect(html).toContain('still running');
    });

    it('closed iteration gets the closed class + visible close timestamp', () => {
        const html = renderIterationHistory([
            row({
                iterationIndex: 1,
                startedAt: '2026-05-24T00:00:00Z',
                endedAt: '2026-05-24T01:30:00Z',
            }),
        ]);
        expect(html).toContain('iteration-row--closed');
        expect(html).toContain('closed');
    });

    it('shows the requirement_text when present', () => {
        const html = renderIterationHistory([
            row({ iterationIndex: 1, requirementText: 'fix the dark-mode toggle' }),
        ]);
        expect(html).toContain('fix the dark-mode toggle');
    });

    it('iteration 0 with no requirement gets the muted "from the original brief" placeholder', () => {
        const html = renderIterationHistory([
            row({ iterationIndex: 0, requirementText: null }),
        ]);
        expect(html).toContain('From the original brief');
        expect(html).toContain('iteration-row-req--muted');
    });

    it('iteration N>0 with no requirement omits the requirement block', () => {
        const html = renderIterationHistory([
            row({ iterationIndex: 1, requirementText: null }),
        ]);
        // No req-block for "operator clicked Reopen button without a prompt".
        expect(html).not.toContain('From the original brief');
        // The row itself still renders.
        expect(html).toContain('Iteration 1');
    });

    it('escapes HTML in requirement_text (no XSS)', () => {
        const html = renderIterationHistory([
            row({ iterationIndex: 1, requirementText: '<script>alert(1)</script>' }),
        ]);
        expect(html).not.toContain('<script>alert');
        expect(html).toContain('&lt;script&gt;');
    });

    it('formats duration in min for short cycles, h+m for long ones', () => {
        const html = renderIterationHistory([
            row({
                iterationIndex: 0,
                startedAt: '2026-05-24T00:00:00Z',
                endedAt: '2026-05-24T00:25:00Z',
            }),
            row({
                iterationIndex: 1,
                startedAt: '2026-05-24T00:00:00Z',
                endedAt: '2026-05-24T03:42:00Z',
            }),
        ]);
        expect(html).toContain('25 min');
        expect(html).toContain('3h 42m');
    });

    it('shows "in flight" for an open iteration\'s duration', () => {
        const html = renderIterationHistory([
            row({ iterationIndex: 1, endedAt: null }),
        ]);
        expect(html).toContain('in flight');
    });
});
