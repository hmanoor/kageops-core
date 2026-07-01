import { describe, it, expect } from 'vitest';
import {
  renderTraceDetailHtml,
  renderTimingSection,
  renderTokenSection,
  renderInputOutputSection,
  renderMetadataSection,
  renderErrorSection,
  formatTimestamp,
  formatTokenCount,
  escapeHtml,
  DEFAULT_DETAIL_OPTIONS,
  type TraceDetailData,
} from '../../src/renderer/command-center/trace-detail-panel';

// ── Fixtures ──────────────────────────────────────────

function makeData(overrides?: Partial<TraceDetailData>): TraceDetailData {
  return {
    id: 'span-1',
    traceId: 'trace-abc',
    operationName: 'forge.askAI',
    agentName: 'forge',
    runType: 'ai-call',
    status: 'completed',
    startTime: new Date('2025-01-01T14:32:05.123Z').getTime(),
    endTime: new Date('2025-01-01T14:32:07.423Z').getTime(),
    durationMs: 2300,
    input: 'Build a REST API',
    output: 'Here is a plan...',
    tokenCount: 1801,
    tokensIn: 1234,
    tokensOut: 567,
    cost: 0.032,
    model: 'claude-sonnet-4-20250514',
    error: null,
    metadata: { phase: 'development', priority: 1 },
    childCount: 3,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────

describe('renderTraceDetailHtml', () => {
  it('includes operation name', () => {
    const html = renderTraceDetailHtml(makeData());
    expect(html).toContain('forge.askAI');
  });

  it('includes status badge', () => {
    const html = renderTraceDetailHtml(makeData({ status: 'completed' }));
    expect(html).toContain('status-completed');
    expect(html).toContain('Completed');
  });

  it('includes timing section', () => {
    const html = renderTraceDetailHtml(makeData());
    expect(html).toContain('Timing');
    expect(html).toContain('2.3s');
  });

  it('includes token section', () => {
    const html = renderTraceDetailHtml(makeData());
    expect(html).toContain('Tokens');
    expect(html).toContain('1,234 tokens');
  });

  it('includes error section when error exists', () => {
    const html = renderTraceDetailHtml(makeData({ error: 'Something went wrong' }));
    expect(html).toContain('Something went wrong');
    expect(html).toContain('trace-detail-error');
  });

  it('omits error section when no error', () => {
    const html = renderTraceDetailHtml(makeData({ error: null }));
    expect(html).not.toContain('trace-detail-error');
  });
});

describe('renderTimingSection', () => {
  it('formats start time', () => {
    const data = makeData({ startTime: new Date('2025-06-15T10:05:03.042Z').getTime() });
    const html = renderTimingSection(data);
    // Seconds + ms are timezone-invariant (offsets are always whole minutes,
    // never sub-minute), so match on `:SS.mmm` and skip the hour/minute parts
    // that shift under +5:30 / +5:45 / +8:45 offsets.
    expect(html).toMatch(/:03\.042/);
  });

  it('shows duration', () => {
    const html = renderTimingSection(makeData({ durationMs: 1500 }));
    expect(html).toContain('1.5s');
  });
});

describe('renderTokenSection', () => {
  it('shows input and output counts', () => {
    const html = renderTokenSection(makeData());
    expect(html).toContain('1,234 tokens');
    expect(html).toContain('567 tokens');
  });
});

describe('renderInputOutputSection', () => {
  it('truncates long output', () => {
    const longText = 'x'.repeat(600);
    const html = renderInputOutputSection(null, longText, 500);
    expect(html).toContain('data-truncated="true"');
    expect(html).toContain('Show more');
  });

  it('shows full short output', () => {
    const shortText = 'short response';
    const html = renderInputOutputSection(null, shortText, 500);
    expect(html).toContain('short response');
    expect(html).not.toContain('Show more');
  });

  it('handles null input/output', () => {
    const html = renderInputOutputSection(null, null, 500);
    expect(html).toContain('None');
    expect(html).not.toContain('<pre');
  });
});

describe('renderMetadataSection', () => {
  it('renders JSON', () => {
    const html = renderMetadataSection({ key: 'value', count: 42 });
    // JSON keys/values are HTML-escaped in the pre block
    expect(html).toContain('&quot;key&quot;');
    expect(html).toContain('&quot;value&quot;');
    expect(html).toContain('42');
  });
});

describe('renderErrorSection', () => {
  it('renders red box for error', () => {
    const html = renderErrorSection('Something failed');
    expect(html).toContain('trace-detail-error');
    expect(html).toContain('Something failed');
  });

  it('returns empty string when no error', () => {
    expect(renderErrorSection(null)).toBe('');
  });
});

describe('formatTimestamp', () => {
  it('formats correctly', () => {
    // Use a fixed UTC offset by checking the pattern HH:MM:SS.mmm
    const ts = new Date('2025-01-01T00:00:01.999Z').getTime();
    const result = formatTimestamp(ts);
    // Match pattern regardless of timezone
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(result).toContain('999');
  });
});

describe('formatTokenCount', () => {
  it('formats thousands', () => {
    expect(formatTokenCount(1234)).toBe('1,234 tokens');
  });

  it('formats large numbers with K', () => {
    expect(formatTokenCount(12300)).toBe('12.3K tokens');
  });
});

describe('escapeHtml', () => {
  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });
});

describe('DEFAULT_DETAIL_OPTIONS', () => {
  it('has expected values', () => {
    expect(DEFAULT_DETAIL_OPTIONS.showRawMetadata).toBe(true);
    expect(DEFAULT_DETAIL_OPTIONS.truncateOutput).toBe(500);
    expect(DEFAULT_DETAIL_OPTIONS.showTimestamps).toBe(true);
  });
});
