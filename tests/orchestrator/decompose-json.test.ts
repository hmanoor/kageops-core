/**
 * BPF-36 — robust JSON task-array recovery.
 */

import { describe, it, expect } from 'vitest';
import { recoverTaskArray, decompositionParseFailed } from '../../src/orchestrator/decompose-json';

const TASK = (title: string): string =>
    `{"title":"${title}","taskType":"concept-brief","assignedAgent":"scout","priority":5,"dependsOn":[]}`;

describe('recoverTaskArray', () => {
    it('parses a clean JSON array', () => {
        const arr = recoverTaskArray(`[${TASK('A')},${TASK('B')}]`);
        expect(arr).not.toBeNull();
        expect(arr).toHaveLength(2);
    });

    it('extracts the real array out of prose with stray brackets around it', () => {
        const resp = `Here are the tasks [see the plan below]:\n[${TASK('A')}]\nThat completes it [end].`;
        const arr = recoverTaskArray(resp);
        expect(arr).toHaveLength(1);
        expect((arr![0] as Record<string, unknown>).title).toBe('A');
    });

    it('recovers a markdown-fenced array', () => {
        const resp = '```json\n[' + TASK('A') + ']\n```';
        expect(recoverTaskArray(resp)).toHaveLength(1);
    });

    it('repairs trailing commas before a closing bracket/brace', () => {
        const resp = `[${TASK('A')},]`;
        expect(recoverTaskArray(resp)).toHaveLength(1);
    });

    it('strips full-line // comments but never a :// inside a string value', () => {
        const resp =
            '[\n' +
            '  // the first task\n' +
            '  {"title":"A","taskType":"concept-brief","assignedAgent":"scout","outputPath":"https://example.com/x"}\n' +
            ']';
        const arr = recoverTaskArray(resp);
        expect(arr).toHaveLength(1);
        expect((arr![0] as Record<string, unknown>).outputPath).toBe('https://example.com/x');
    });

    it('salvages valid task objects when one sibling object is malformed', () => {
        const resp = `[${TASK('A')},{"title":"B", broken },${TASK('C')}]`;
        const arr = recoverTaskArray(resp);
        expect(arr).toHaveLength(2);
        expect((arr![0] as Record<string, unknown>).title).toBe('A');
        expect((arr![1] as Record<string, unknown>).title).toBe('C');
    });

    it('prefers the real task array over a small example array in the preamble', () => {
        const resp =
            'Example shape: [{"title":"example"}]\n\n' +
            `Actual tasks:\n[${TASK('A')},${TASK('B')},${TASK('C')}]`;
        const arr = recoverTaskArray(resp);
        expect(arr).toHaveLength(3);
    });

    it('returns null for pure prose with no array or task object', () => {
        expect(recoverTaskArray('Sorry, I cannot help with that.')).toBeNull();
    });

    it('returns null for an empty array (no tasks to recover)', () => {
        expect(recoverTaskArray('[]')).toBeNull();
    });

    it('returns null for empty / non-string input', () => {
        expect(recoverTaskArray('')).toBeNull();
        expect(recoverTaskArray(undefined as never)).toBeNull();
    });

    it('is not fooled by brackets inside string values', () => {
        const resp = '[{"title":"uses [brackets] and \\"quotes\\"","taskType":"x","assignedAgent":"scout"}]';
        const arr = recoverTaskArray(resp);
        expect(arr).toHaveLength(1);
        expect((arr![0] as Record<string, unknown>).title).toBe('uses [brackets] and "quotes"');
    });
});

describe('decompositionParseFailed', () => {
    it('is false for a valid array (even empty)', () => {
        expect(decompositionParseFailed('[]')).toBe(false);
        expect(decompositionParseFailed(`[${TASK('A')}]`)).toBe(false);
    });

    it('is false when individual task objects are salvageable', () => {
        expect(decompositionParseFailed(`one ${TASK('A')} two`)).toBe(false);
    });

    it('is true for pure prose', () => {
        expect(decompositionParseFailed('Sorry, I cannot help with that.')).toBe(true);
    });

    it('is true for an unbalanced / truncated array', () => {
        expect(decompositionParseFailed('[{"title": "broken"')).toBe(true);
    });

    it('is true for non-string input', () => {
        expect(decompositionParseFailed(undefined as never)).toBe(true);
    });
});
