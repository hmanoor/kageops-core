/**
 * KageOps SSE / NDJSON Streaming Parser
 *
 * Parses Server-Sent Events (SSE) and Newline-Delimited JSON (NDJSON)
 * streams from AI provider APIs. Handles partial chunks across TCP
 * boundaries via the stream accumulator.
 */

// ── Types ────────────────────────────────────────────

export interface SSEEvent {
    readonly event?: string;
    readonly data: string;
    readonly id?: string;
}

interface MutableSSEFields {
    event?: string;
    data?: string;
    id?: string;
}

// ── SSE Parsing ──────────────────────────────────────

/**
 * Parse a complete SSE chunk into an array of events.
 *
 * SSE format rules:
 * - `data:` lines contain the payload (strip prefix + optional leading space)
 * - Multiple consecutive `data:` lines before an empty line are concatenated with \n
 * - Empty lines are event separators (emit the accumulated event)
 * - Lines starting with `:` are comments (ignored)
 * - `event:` sets the event type
 * - `id:` sets the event ID
 * - `[DONE]` is a special data value (returned as-is)
 * - Malformed lines are silently skipped
 */
export function parseSSEChunk(chunk: string): readonly SSEEvent[] {
    if (chunk === '') {
        return [];
    }

    const lines = chunk.split('\n');
    const events: SSEEvent[] = [];
    let current: MutableSSEFields = {};
    let hasData = false;

    for (const line of lines) {
        if (line.startsWith(':')) {
            // Comment line — skip
            continue;
        }

        if (line === '' || line === '\r') {
            // Empty line = event separator
            if (hasData && current.data !== undefined) {
                events.push({
                    event: current.event,
                    data: current.data,
                    id: current.id,
                });
            }
            current = {};
            hasData = false;
            continue;
        }

        if (line.startsWith('data:')) {
            const value = stripFieldPrefix(line, 'data:');
            if (hasData && current.data !== undefined) {
                current = { ...current, data: current.data + '\n' + value };
            } else {
                current = { ...current, data: value };
                hasData = true;
            }
            continue;
        }

        if (line.startsWith('event:')) {
            const value = stripFieldPrefix(line, 'event:');
            current = { ...current, event: value };
            continue;
        }

        if (line.startsWith('id:')) {
            const value = stripFieldPrefix(line, 'id:');
            current = { ...current, id: value };
            continue;
        }

        // Malformed line — skip silently
    }

    // If the chunk ends without a trailing empty line but has accumulated data,
    // do NOT emit it (it may be incomplete). The accumulator handles this.
    return events;
}

/**
 * Strip a field prefix (e.g. "data:") from a line, also removing a single
 * leading space after the colon if present.
 */
function stripFieldPrefix(line: string, prefix: string): string {
    const rest = line.slice(prefix.length);
    if (rest.startsWith(' ')) {
        return rest.slice(1);
    }
    return rest;
}

// ── NDJSON Parsing ───────────────────────────────────

/**
 * Parse a chunk of newline-delimited JSON into an array of parsed objects.
 * Malformed lines are silently skipped.
 */
export function parseNDJSONChunk(chunk: string): readonly unknown[] {
    if (chunk === '') {
        return [];
    }

    const lines = chunk.split('\n');
    const results: unknown[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') {
            continue;
        }

        try {
            results.push(JSON.parse(trimmed));
        } catch {
            // Malformed JSON — skip silently
        }
    }

    return results;
}

// ── Stream Accumulator ───────────────────────────────

/**
 * Create a stateful accumulator that handles SSE events split across
 * TCP chunk boundaries.
 *
 * - Buffers incomplete lines (when a chunk doesn't end with a newline)
 * - On next `feed()`, prepends the buffer to the new chunk
 * - `reset()` clears the internal buffer
 */
export function createStreamAccumulator(): {
    feed(chunk: string): readonly SSEEvent[];
    reset(): void;
} {
    let buffer = '';

    return {
        feed(chunk: string): readonly SSEEvent[] {
            const combined = buffer + chunk;

            // Find the last event separator (empty line = \n\n).
            // Everything before the last separator contains complete events.
            // Everything after is a partial event or partial line — buffer it.
            const lastSeparatorIdx = combined.lastIndexOf('\n\n');

            if (lastSeparatorIdx === -1) {
                // No event separator found — buffer everything
                buffer = combined;
                return [];
            }

            // Include the separator itself in the complete portion
            const complete = combined.slice(0, lastSeparatorIdx + 2);
            buffer = combined.slice(lastSeparatorIdx + 2);

            return parseSSEChunk(complete);
        },

        reset(): void {
            buffer = '';
        },
    };
}
