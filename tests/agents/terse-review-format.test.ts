import { describe, it, expect } from 'vitest';
import {
  SEVERITY_EMOJI,
  SEVERITY_PRIORITY,
  buildTerseReviewPrompt,
  parseTerseFindings,
  parseTerseGate,
  formatTerseOutput,
  buildTerseReviewResult,
  convertToTerse,
  type TerseSeverity,
} from '../../src/agents/terse-review-format';

describe('SEVERITY_EMOJI', () => {
  it('has all 6 entries', () => {
    const keys: TerseSeverity[] = ['bug', 'sec', 'perf', 'style', 'nit', 'info'];
    for (const key of keys) {
      expect(SEVERITY_EMOJI[key]).toBeDefined();
      expect(typeof SEVERITY_EMOJI[key]).toBe('string');
    }
    expect(Object.keys(SEVERITY_EMOJI)).toHaveLength(6);
  });
});

describe('SEVERITY_PRIORITY', () => {
  it('has all 6 entries with correct order', () => {
    expect(SEVERITY_PRIORITY.bug).toBe(0);
    expect(SEVERITY_PRIORITY.sec).toBe(1);
    expect(SEVERITY_PRIORITY.perf).toBe(2);
    expect(SEVERITY_PRIORITY.style).toBe(3);
    expect(SEVERITY_PRIORITY.nit).toBe(4);
    expect(SEVERITY_PRIORITY.info).toBe(5);
    expect(Object.keys(SEVERITY_PRIORITY)).toHaveLength(6);
  });
});

describe('buildTerseReviewPrompt', () => {
  it('includes format instructions', () => {
    const prompt = buildTerseReviewPrompt('Fix auth bug', 'const x = null;');
    expect(prompt).toContain('FILE: path/to/file.ts');
    expect(prompt).toContain('L<line>: <severity>: <message>. <fix>.');
    expect(prompt).toContain('GATE: PASSED or GATE: REJECTED');
    expect(prompt).toContain('bug, sec, perf, style, nit, info');
    expect(prompt).toContain('Fix auth bug');
    expect(prompt).toContain('const x = null;');
  });
});

describe('parseTerseFindings', () => {
  it('parses valid terse lines', () => {
    const output = `FILE: src/foo.ts\nL42: bug: user is null. Add null guard.`;
    const findings = parseTerseFindings(output);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'src/foo.ts',
      line: 42,
      severity: 'bug',
      message: 'user is null',
      fix: 'Add null guard',
    });
  });

  it('tracks FILE context', () => {
    const output = [
      'FILE: src/a.ts',
      'L1: nit: unused var. Remove it.',
      'FILE: src/b.ts',
      'L5: bug: crash. Fix it.',
    ].join('\n');
    const findings = parseTerseFindings(output);
    expect(findings[0].file).toBe('src/a.ts');
    expect(findings[1].file).toBe('src/b.ts');
  });

  it('skips malformed lines', () => {
    const output = [
      'FILE: src/foo.ts',
      'this is not a finding',
      'L10: unknown: msg. fix.',
      'L12: bug: real issue. Fix it.',
    ].join('\n');
    const findings = parseTerseFindings(output);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(12);
  });

  it('handles all 6 severities', () => {
    const lines = [
      'FILE: src/x.ts',
      'L1: bug: b. F.',
      'L2: sec: s. F.',
      'L3: perf: p. F.',
      'L4: style: st. F.',
      'L5: nit: n. F.',
      'L6: info: i. F.',
    ].join('\n');
    const findings = parseTerseFindings(lines);
    expect(findings).toHaveLength(6);
    const severities = findings.map((f) => f.severity);
    expect(severities).toContain('bug');
    expect(severities).toContain('sec');
    expect(severities).toContain('perf');
    expect(severities).toContain('style');
    expect(severities).toContain('nit');
    expect(severities).toContain('info');
  });
});

describe('parseTerseGate', () => {
  it('returns true for PASSED', () => {
    expect(parseTerseGate('GATE: PASSED')).toBe(true);
  });

  it('returns false for REJECTED', () => {
    expect(parseTerseGate('GATE: REJECTED')).toBe(false);
  });

  it('defaults to false for missing gate', () => {
    expect(parseTerseGate('some output with no gate line')).toBe(false);
  });
});

describe('formatTerseOutput', () => {
  const findings = [
    { file: 'src/a.ts', line: 89, severity: 'perf' as TerseSeverity, message: 'slow loop', fix: 'Use Map' },
    { file: 'src/a.ts', line: 42, severity: 'bug' as TerseSeverity, message: 'null ref', fix: 'Add guard' },
    { file: 'src/b.ts', line: 15, severity: 'sec' as TerseSeverity, message: 'SQL concat', fix: 'Use params' },
  ];

  it('groups by file', () => {
    const output = formatTerseOutput(findings, true);
    expect(output).toContain('## src/a.ts');
    expect(output).toContain('## src/b.ts');
  });

  it('prepends correct emoji', () => {
    const output = formatTerseOutput(findings, true);
    expect(output).toContain('🔴');
    expect(output).toContain('🟡');
    expect(output).toContain('🟠');
  });

  it('sorts by severity within file', () => {
    const output = formatTerseOutput(findings, true);
    const aSection = output.split('## src/b.ts')[0];
    const bugIdx = aSection.indexOf('🔴');
    const perfIdx = aSection.indexOf('🟡');
    expect(bugIdx).toBeLessThan(perfIdx);
  });

  it('shows PASSED with checkmark and REJECTED with cross', () => {
    const passed = formatTerseOutput([], true);
    expect(passed).toContain('GATE: PASSED ✅');

    const rejected = formatTerseOutput([], false);
    expect(rejected).toContain('GATE: REJECTED ❌');
  });
});

describe('buildTerseReviewResult', () => {
  it('combines parsing correctly', () => {
    const aiOutput = [
      'FILE: src/foo.ts',
      'L10: bug: null deref. Add guard.',
      'L20: sec: unvalidated input. Sanitize it.',
      'GATE: PASSED',
    ].join('\n');

    const result = buildTerseReviewResult(aiOutput);
    expect(result.passedGate).toBe(true);
    expect(result.findings).toHaveLength(2);
    expect(result.summary).toContain('2 findings');
  });
});

describe('convertToTerse', () => {
  it('maps critical to bug', () => {
    const result = convertToTerse({
      file: 'src/x.ts',
      line: 5,
      severity: 'critical',
      message: 'crash on null',
      suggestion: 'Add null check',
    });
    expect(result.severity).toBe('bug');
  });

  it('maps high to sec', () => {
    const result = convertToTerse({ file: 'src/x.ts', line: 1, severity: 'high', message: 'sql injection', suggestion: 'use params' });
    expect(result.severity).toBe('sec');
  });

  it('maps medium to perf', () => {
    const result = convertToTerse({ file: 'src/x.ts', line: 1, severity: 'medium', message: 'slow', suggestion: 'cache it' });
    expect(result.severity).toBe('perf');
  });

  it('maps low to style', () => {
    const result = convertToTerse({ file: 'src/x.ts', line: 1, severity: 'low', message: 'style', suggestion: 'fix it' });
    expect(result.severity).toBe('style');
  });

  it('maps unknown severity to nit', () => {
    const result = convertToTerse({ file: 'src/x.ts', line: 1, severity: 'whatever', message: 'meh', suggestion: 'ok' });
    expect(result.severity).toBe('nit');
  });

  it('truncates long messages to 80 chars', () => {
    const longMsg = 'a'.repeat(100);
    const longFix = 'b'.repeat(100);
    const result = convertToTerse({
      file: 'src/x.ts',
      line: 1,
      severity: 'critical',
      message: longMsg,
      suggestion: longFix,
    });
    expect(result.message.length).toBe(80);
    expect(result.fix.length).toBe(80);
  });
});
