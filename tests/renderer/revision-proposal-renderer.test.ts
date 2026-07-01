/**
 * P1-08b — Sensei chat revision proposal renderer.
 *
 * Pure module — both the line-diff algorithm + the HTML render are
 * unit-tested without DOM. The IPC + click-handler wiring on top of
 * this lives in command-center.ts and is integration territory.
 *
 * Coverage:
 *   - computeLineDiff: new-file path, identical-content fast-path,
 *     basic add/remove/context, leading + trailing edits, both-null
 *     defensive.
 *   - renderRevisionProposal: empty-proposal path, instruction
 *     rendering, file blocks render diff, unchanged-file note,
 *     buttons carry data-action/project-id/task-id, XSS escape.
 */

import { describe, it, expect } from 'vitest';
import {
    computeLineDiff,
    renderRevisionProposal,
    type RevisionProposal,
    type RevisionProposalFile,
} from '../../src/renderer/command-center/revision-proposal-renderer';

function makeFile(overrides: Partial<RevisionProposalFile> = {}): RevisionProposalFile {
    return {
        path: 'index.html',
        sizeBytes: 0,
        proposedSha256: 'a',
        currentSha256: 'b',
        unchanged: false,
        proposedContent: '',
        currentContent: '',
        ...overrides,
    };
}

function makeProposal(overrides: Partial<RevisionProposal> = {}): RevisionProposal {
    return {
        projectId: 'p-1',
        taskId: 't-1',
        createdAt: '2026-05-24T05:00:00Z',
        files: [],
        ...overrides,
    };
}

// ── computeLineDiff ──

describe('computeLineDiff()', () => {
    it('treats null current as "new file" — every line is an addition', () => {
        const diff = computeLineDiff(null, 'line1\nline2');
        expect(diff).toHaveLength(2);
        expect(diff[0]).toEqual({ kind: 'add', content: 'line1', oldLine: null, newLine: 1 });
        expect(diff[1]).toEqual({ kind: 'add', content: 'line2', oldLine: null, newLine: 2 });
    });

    it('returns empty diff when contents are identical (fast path)', () => {
        expect(computeLineDiff('same\ncontent', 'same\ncontent')).toEqual([]);
    });

    it('returns empty diff when both inputs are null', () => {
        expect(computeLineDiff(null, null)).toEqual([]);
    });

    it('marks a single-line change as remove + add (one line replaced)', () => {
        const diff = computeLineDiff('hello world', 'hello earth');
        const adds = diff.filter((d) => d.kind === 'add');
        const removes = diff.filter((d) => d.kind === 'remove');
        expect(adds).toHaveLength(1);
        expect(removes).toHaveLength(1);
        expect(adds[0].content).toBe('hello earth');
        expect(removes[0].content).toBe('hello world');
    });

    it('keeps unchanged surrounding lines as context', () => {
        const before = 'header\nold line\nfooter';
        const after = 'header\nnew line\nfooter';
        const diff = computeLineDiff(before, after);
        const contexts = diff.filter((d) => d.kind === 'context').map((d) => d.content);
        expect(contexts).toEqual(['header', 'footer']);
    });

    it('handles purely additive change (lines appended)', () => {
        const diff = computeLineDiff('a\nb', 'a\nb\nc');
        const adds = diff.filter((d) => d.kind === 'add');
        expect(adds.map((d) => d.content)).toEqual(['c']);
    });

    it('handles purely removal change (lines deleted)', () => {
        const diff = computeLineDiff('a\nb\nc', 'a\nc');
        const removes = diff.filter((d) => d.kind === 'remove');
        expect(removes.map((d) => d.content)).toEqual(['b']);
    });

    it('numbers context lines correctly in both old + new', () => {
        const diff = computeLineDiff('a\nb\nc', 'a\nb\nc');
        // Identical → fast-path returns [] (covered above). Verify
        // line numbering through a mixed-diff case instead:
        const mixed = computeLineDiff('a\nx\nc', 'a\ny\nc');
        const context = mixed.filter((d) => d.kind === 'context');
        expect(context[0]).toMatchObject({ oldLine: 1, newLine: 1 });
        expect(context[1]).toMatchObject({ oldLine: 3, newLine: 3 });
    });
});

// ── renderRevisionProposal ──

describe('renderRevisionProposal()', () => {
    it('renders the empty-proposal placeholder when no files', () => {
        const html = renderRevisionProposal(makeProposal({ files: [] }), null);
        expect(html).toContain('revision-proposal--empty');
        expect(html).toContain('empty (no files staged)');
    });

    it('renders the operator instruction quoted', () => {
        const html = renderRevisionProposal(
            makeProposal({
                files: [makeFile({ proposedContent: 'A', currentContent: 'B' })],
            }),
            'fix the dark-mode toggle',
        );
        expect(html).toContain('"fix the dark-mode toggle"');
        expect(html).toContain('revision-proposal-instruction');
    });

    it('omits instruction block when null/empty', () => {
        const html = renderRevisionProposal(makeProposal({ files: [makeFile()] }), null);
        expect(html).not.toContain('revision-proposal-instruction');
    });

    it('renders one file block per changed file with diff content', () => {
        const html = renderRevisionProposal(
            makeProposal({
                files: [
                    makeFile({ path: 'a.html', currentContent: 'old', proposedContent: 'new' }),
                    makeFile({ path: 'b.css', currentContent: 'red', proposedContent: 'blue' }),
                ],
            }),
            null,
        );
        expect(html).toContain('a.html');
        expect(html).toContain('b.css');
        expect(html).toContain('diff-line--add');
        expect(html).toContain('diff-line--remove');
    });

    it('lists unchanged files at the bottom (when any)', () => {
        const html = renderRevisionProposal(
            makeProposal({
                files: [
                    makeFile({ path: 'changed.html', currentContent: 'a', proposedContent: 'b' }),
                    makeFile({ path: 'noop.css', currentContent: 'same', proposedContent: 'same', unchanged: true }),
                ],
            }),
            null,
        );
        expect(html).toContain('revision-proposal-unchanged');
        expect(html).toContain('1 file unchanged');
        expect(html).toContain('<code>noop.css</code>');
    });

    it('Accept/Reject buttons carry data-action/project-id/task-id', () => {
        const html = renderRevisionProposal(
            makeProposal({
                projectId: 'proj-X',
                taskId: 'task-Y',
                files: [makeFile({ currentContent: 'a', proposedContent: 'b' })],
            }),
            null,
        );
        expect(html).toMatch(/data-action="accept"/);
        expect(html).toMatch(/data-action="reject"/);
        expect(html).toMatch(/data-project-id="proj-X"/);
        expect(html).toMatch(/data-task-id="task-Y"/);
    });

    it('escapes HTML in operator-supplied content (XSS-safe)', () => {
        const html = renderRevisionProposal(
            makeProposal({
                files: [makeFile({
                    path: '<script>alert(1)</script>',
                    currentContent: '<old>',
                    proposedContent: '<new>',
                })],
            }),
            '<script>alert(2)</script>',
        );
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).not.toContain('<script>alert(2)</script>');
        expect(html).toContain('&lt;script&gt;');
        // The diff body should also be escaped.
        expect(html).toContain('&lt;new&gt;');
        expect(html).toContain('&lt;old&gt;');
    });

    it('shows "(file too large to preview…)" when proposedContent is null', () => {
        const html = renderRevisionProposal(
            makeProposal({
                files: [makeFile({
                    path: 'huge.html',
                    proposedContent: null,
                    currentContent: null,
                    unchanged: false,
                })],
            }),
            null,
        );
        expect(html).toContain('file too large to preview');
    });

    it('marks a new-file diff with "new file" summary', () => {
        const html = renderRevisionProposal(
            makeProposal({
                files: [makeFile({
                    path: 'fresh.html',
                    currentContent: null,
                    currentSha256: null,
                    proposedContent: '<html></html>',
                })],
            }),
            null,
        );
        expect(html).toContain('new file');
    });
});
