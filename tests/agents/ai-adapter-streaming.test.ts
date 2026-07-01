/**
 * SSE / NDJSON Streaming Parser Tests
 *
 * Validates the parsing of Server-Sent Events, Newline-Delimited JSON,
 * and the stream accumulator that handles partial TCP chunks.
 */

import { describe, it, expect } from 'vitest';
import {
    parseSSEChunk,
    parseNDJSONChunk,
    createStreamAccumulator,
} from '../../src/agents/ai-adapter-streaming';

// ── parseSSEChunk ────────────────────────────────────

describe('parseSSEChunk', () => {
    it('parses a standard "data: hello" event', () => {
        const events = parseSSEChunk('data: hello\n\n');
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe('hello');
    });

    it('parses event with event type and data', () => {
        const chunk = 'event: message\ndata: hello\n\n';
        const events = parseSSEChunk(chunk);
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe('message');
        expect(events[0].data).toBe('hello');
    });

    it('concatenates multi-line data fields with newline', () => {
        const chunk = 'data: line one\ndata: line two\n\n';
        const events = parseSSEChunk(chunk);
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe('line one\nline two');
    });

    it('handles data: [DONE] as a regular data value', () => {
        const events = parseSSEChunk('data: [DONE]\n\n');
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe('[DONE]');
    });

    it('ignores comment lines starting with ":"', () => {
        const chunk = ': this is a comment\ndata: hello\n\n';
        const events = parseSSEChunk(chunk);
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe('hello');
    });

    it('returns empty array for empty string', () => {
        const events = parseSSEChunk('');
        expect(events).toHaveLength(0);
    });

    it('handles id: line correctly', () => {
        const chunk = 'id: 123\ndata: hello\n\n';
        const events = parseSSEChunk(chunk);
        expect(events).toHaveLength(1);
        expect(events[0].id).toBe('123');
        expect(events[0].data).toBe('hello');
    });

    it('parses multiple events in a single chunk', () => {
        const chunk = 'data: first\n\ndata: second\n\n';
        const events = parseSSEChunk(chunk);
        expect(events).toHaveLength(2);
        expect(events[0].data).toBe('first');
        expect(events[1].data).toBe('second');
    });

    it('ignores malformed lines without known field prefix', () => {
        const chunk = 'garbage line\ndata: valid\n\n';
        const events = parseSSEChunk(chunk);
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe('valid');
    });

    it('strips a single leading space after the colon in data field', () => {
        const events = parseSSEChunk('data:no-space\n\n');
        expect(events[0].data).toBe('no-space');
    });

    it('does not emit an event if chunk lacks trailing empty line', () => {
        // Incomplete event — no double newline at the end
        const events = parseSSEChunk('data: partial');
        expect(events).toHaveLength(0);
    });

    it('handles all fields together: event, id, and data', () => {
        const chunk = 'event: update\nid: 42\ndata: payload\n\n';
        const events = parseSSEChunk(chunk);
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            event: 'update',
            id: '42',
            data: 'payload',
        });
    });
});

// ── parseNDJSONChunk ─────────────────────────────────

describe('parseNDJSONChunk', () => {
    it('parses a single JSON line', () => {
        const result = parseNDJSONChunk('{"key":"value"}\n');
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({ key: 'value' });
    });

    it('parses multiple JSON lines', () => {
        const result = parseNDJSONChunk('{"a":1}\n{"b":2}\n{"c":3}\n');
        expect(result).toHaveLength(3);
        expect(result[0]).toEqual({ a: 1 });
        expect(result[1]).toEqual({ b: 2 });
        expect(result[2]).toEqual({ c: 3 });
    });

    it('skips empty lines', () => {
        const result = parseNDJSONChunk('{"a":1}\n\n{"b":2}\n');
        expect(result).toHaveLength(2);
    });

    it('skips malformed JSON lines without throwing', () => {
        const result = parseNDJSONChunk('{"valid":true}\nnot json\n{"also":true}\n');
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ valid: true });
        expect(result[1]).toEqual({ also: true });
    });

    it('returns empty array for empty string', () => {
        const result = parseNDJSONChunk('');
        expect(result).toHaveLength(0);
    });

    it('handles lines with only whitespace', () => {
        const result = parseNDJSONChunk('   \n  \n');
        expect(result).toHaveLength(0);
    });

    it('parses JSON arrays and primitives', () => {
        const result = parseNDJSONChunk('[1,2,3]\n"hello"\n42\n');
        expect(result).toHaveLength(3);
        expect(result[0]).toEqual([1, 2, 3]);
        expect(result[1]).toBe('hello');
        expect(result[2]).toBe(42);
    });
});

// ── createStreamAccumulator ──────────────────────────

describe('createStreamAccumulator', () => {
    it('accumulates complete events across feeds', () => {
        const acc = createStreamAccumulator();

        const events1 = acc.feed('data: hello\n\n');
        expect(events1).toHaveLength(1);
        expect(events1[0].data).toBe('hello');

        const events2 = acc.feed('data: world\n\n');
        expect(events2).toHaveLength(1);
        expect(events2[0].data).toBe('world');
    });

    it('buffers incomplete lines without trailing newline', () => {
        const acc = createStreamAccumulator();

        // No newline at end — should buffer everything
        const events = acc.feed('data: incomp');
        expect(events).toHaveLength(0);
    });

    it('prepends buffered content to next feed', () => {
        const acc = createStreamAccumulator();

        // First chunk: partial line — no newline
        const events1 = acc.feed('data: hel');
        expect(events1).toHaveLength(0);

        // Second chunk: completes the line and the event
        const events2 = acc.feed('lo\n\n');
        expect(events2).toHaveLength(1);
        expect(events2[0].data).toBe('hello');
    });

    it('handles event split across three chunks', () => {
        const acc = createStreamAccumulator();

        expect(acc.feed('event: m')).toHaveLength(0);
        expect(acc.feed('essage\nda')).toHaveLength(0);
        const events = acc.feed('ta: split\n\n');
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe('message');
        expect(events[0].data).toBe('split');
    });

    it('reset() clears the buffer', () => {
        const acc = createStreamAccumulator();

        acc.feed('data: partial');
        acc.reset();

        // After reset, the partial data is gone — a new complete event works fine
        const events = acc.feed('data: fresh\n\n');
        expect(events).toHaveLength(1);
        expect(events[0].data).toBe('fresh');
    });

    it('handles multiple events in a single chunk with partial at end', () => {
        const acc = createStreamAccumulator();

        const events = acc.feed('data: one\n\ndata: two\n\ndata: thr');
        expect(events).toHaveLength(2);
        expect(events[0].data).toBe('one');
        expect(events[1].data).toBe('two');

        // Complete the third event
        const events2 = acc.feed('ee\n\n');
        expect(events2).toHaveLength(1);
        expect(events2[0].data).toBe('three');
    });
});
