/**
 * Agent Terminal Panel — renderer unit tests (B-497)
 *
 * No jsdom. Exercises the pure helpers (line buffer, ANSI parser, IPC
 * payload validator) directly. The DOM mount layer is exercised in
 * integration tests downstream.
 */

import { describe, it, expect } from 'vitest';
import {
    appendLines,
    splitChunkIntoLines,
    parseAnsiToHtml,
    parseChunkEvent,
    escapeHtml,
    SCROLLBACK_LIMIT,
    type AgentTerminalLine,
} from '../../src/renderer/command-center/agent-terminal-panel';

// ── escapeHtml ──────────────────────────────────────

describe('escapeHtml', () => {
    it('escapes the five special HTML chars', () => {
        const out = escapeHtml('<a href="x">\'q\' & y</a>');
        expect(out).toBe('&lt;a href=&quot;x&quot;&gt;&#39;q&#39; &amp; y&lt;/a&gt;');
    });

    it('returns empty string unchanged', () => {
        expect(escapeHtml('')).toBe('');
    });
});

// ── splitChunkIntoLines ─────────────────────────────

describe('splitChunkIntoLines', () => {
    it('returns whole lines and a pending tail', () => {
        const out = splitChunkIntoLines('', 'a\nb\nc');
        expect(out.lines).toEqual(['a', 'b']);
        expect(out.pending).toBe('c');
    });

    it('joins prior pending with new chunk before splitting', () => {
        const out = splitChunkIntoLines('hel', 'lo\nworld\n');
        expect(out.lines).toEqual(['hello', 'world']);
        expect(out.pending).toBe('');
    });

    it('normalizes CRLF to LF', () => {
        const out = splitChunkIntoLines('', 'a\r\nb\r\n');
        expect(out.lines).toEqual(['a', 'b']);
        expect(out.pending).toBe('');
    });

    it('drops bare CR (progress-bar style redraws)', () => {
        const out = splitChunkIntoLines('', 'progress: 10%\rprogress: 20%\n');
        expect(out.lines).toEqual(['progress: 10%progress: 20%']);
    });

    it('returns no lines when the chunk has no newline', () => {
        const out = splitChunkIntoLines('', 'partial');
        expect(out.lines).toEqual([]);
        expect(out.pending).toBe('partial');
    });
});

// ── appendLines ─────────────────────────────────────

function makeLine(text: string, idx = 0): AgentTerminalLine {
    return {
        source: 'build-verification',
        stream: 'stdout',
        text,
        ts: 1_000_000 + idx,
    };
}

describe('appendLines', () => {
    it('appends without dropping when under the limit', () => {
        const buffer: readonly AgentTerminalLine[] = [makeLine('a', 0)];
        const next = appendLines(buffer, [makeLine('b', 1), makeLine('c', 2)]);
        expect(next.map((l) => l.text)).toEqual(['a', 'b', 'c']);
    });

    it('returns the same reference when no incoming lines', () => {
        const buffer: readonly AgentTerminalLine[] = [makeLine('a')];
        const next = appendLines(buffer, []);
        expect(next).toBe(buffer);
    });

    it('drops oldest entries when exceeding the cap', () => {
        const initial: readonly AgentTerminalLine[] = Array.from({ length: 5 }, (_, i) =>
            makeLine(`init-${i}`, i)
        );
        const incoming: readonly AgentTerminalLine[] = Array.from({ length: 4 }, (_, i) =>
            makeLine(`new-${i}`, 100 + i)
        );
        const next = appendLines(initial, incoming, 6);
        expect(next.length).toBe(6);
        expect(next.map((l) => l.text)).toEqual([
            'init-3', 'init-4', 'new-0', 'new-1', 'new-2', 'new-3',
        ]);
    });

    it('honours the SCROLLBACK_LIMIT default', () => {
        const tooMany: readonly AgentTerminalLine[] = Array.from(
            { length: SCROLLBACK_LIMIT + 50 },
            (_, i) => makeLine(`l-${i}`, i)
        );
        const next = appendLines([], tooMany);
        expect(next.length).toBe(SCROLLBACK_LIMIT);
        expect(next[0]?.text).toBe('l-50');
        expect(next[next.length - 1]?.text).toBe(`l-${SCROLLBACK_LIMIT + 49}`);
    });
});

// ── parseAnsiToHtml ─────────────────────────────────

describe('parseAnsiToHtml', () => {
    it('escapes plain text without ANSI codes', () => {
        expect(parseAnsiToHtml('1 < 2 & "ok"')).toBe('1 &lt; 2 &amp; &quot;ok&quot;');
    });

    it('wraps SGR foreground colours in spans', () => {
        const input = '\x1b[31merror\x1b[0m ok';
        const out = parseAnsiToHtml(input);
        expect(out).toBe('<span class="ansi-fg-1">error</span> ok');
    });

    it('handles bold + colour combos', () => {
        const input = '\x1b[1;32mPASS\x1b[0m';
        const out = parseAnsiToHtml(input);
        // Two opening spans (bold then green), single literal, two closes on reset.
        expect(out).toBe('<span class="ansi-bold"><span class="ansi-fg-2">PASS</span></span>');
    });

    it('drops unknown codes silently', () => {
        const input = '\x1b[99mhi\x1b[0m';
        expect(parseAnsiToHtml(input)).toBe('hi');
    });

    it('escapes HTML inside coloured runs', () => {
        const input = '\x1b[33m<script>\x1b[0m';
        expect(parseAnsiToHtml(input)).toBe('<span class="ansi-fg-3">&lt;script&gt;</span>');
    });

    it('returns empty string unchanged', () => {
        expect(parseAnsiToHtml('')).toBe('');
    });

    it('closes any still-open spans at end of input', () => {
        const input = '\x1b[31mleft-open';
        const out = parseAnsiToHtml(input);
        // Even without a reset, the output must be balanced.
        expect(out).toBe('<span class="ansi-fg-1">left-open</span>');
    });
});

// ── parseChunkEvent ─────────────────────────────────

describe('parseChunkEvent', () => {
    const valid = {
        projectId: 'p',
        data: {
            source: 'build-verification',
            stream: 'stdout',
            chunk: 'hi\n',
            ts: 1234,
        },
    };

    it('accepts a well-formed payload', () => {
        const out = parseChunkEvent(valid);
        expect(out).not.toBeNull();
        expect(out?.projectId).toBe('p');
        expect(out?.data.source).toBe('build-verification');
    });

    it('rejects when projectId is empty', () => {
        expect(parseChunkEvent({ ...valid, projectId: '' })).toBeNull();
    });

    it('rejects when source is unknown', () => {
        expect(parseChunkEvent({ ...valid, data: { ...valid.data, source: 'mystery' } })).toBeNull();
    });

    it('rejects when stream is not stdout/stderr', () => {
        expect(parseChunkEvent({ ...valid, data: { ...valid.data, stream: 'log' } })).toBeNull();
    });

    it('rejects when chunk is not a string', () => {
        expect(parseChunkEvent({ ...valid, data: { ...valid.data, chunk: 42 } })).toBeNull();
    });

    it('rejects when ts is not a number', () => {
        expect(parseChunkEvent({ ...valid, data: { ...valid.data, ts: '12' } })).toBeNull();
    });

    it('rejects null and primitives', () => {
        expect(parseChunkEvent(null)).toBeNull();
        expect(parseChunkEvent('payload')).toBeNull();
        expect(parseChunkEvent(undefined)).toBeNull();
    });

    it('preserves optional taskId and agent', () => {
        const out = parseChunkEvent({ ...valid, taskId: 't', agent: 'forge' });
        expect(out?.taskId).toBe('t');
        expect(out?.agent).toBe('forge');
    });
});
