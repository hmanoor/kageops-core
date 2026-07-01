import { describe, it, expect } from 'vitest';
import {
  scanWorkflowContent,
  scanWorkflowFile,
  formatGhaScanReport,
  GHA_PATTERNS,
} from '../../src/agents/gha-scanner';

// Use string concatenation so esbuild doesn't misparse ${{ as template expressions
const EXPR = '$' + '{{';
const END = '}}';

// ---- helpers ----

const cleanWorkflow = [
  'name: CI',
  'on: [push]',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v3',
  '      - run: echo "hello"',
].join('\n');

// ---- tests ----

describe('scanWorkflowContent', () => {
  it('detects expression injection in run blocks', () => {
    const content = [
      'jobs:',
      '  greet:',
      '    steps:',
      `      - run: echo "${EXPR} github.event.issue.title ${END}"`,
    ].join('\n');
    const result = scanWorkflowContent(content);
    expect(result.safe).toBe(false);
    const finding = result.findings.find((f) => f.pattern === 'expression-injection-run');
    expect(finding).toBeDefined();
    expect(finding?.riskLevel).toBe('critical');
  });

  it('detects workflow dispatch injection', () => {
    const content = [
      'jobs:',
      '  deploy:',
      '    steps:',
      `      - run: echo "${EXPR} github.event.inputs.target ${END}"`,
    ].join('\n');
    const result = scanWorkflowContent(content);
    expect(result.safe).toBe(false);
    const finding = result.findings.find((f) => f.pattern === 'workflow-dispatch-injection');
    expect(finding).toBeDefined();
    expect(finding?.riskLevel).toBe('high');
  });

  it('detects head-ref injection', () => {
    const content = [
      'jobs:',
      '  check:',
      '    steps:',
      `      - run: git checkout "${EXPR} github.head_ref ${END}"`,
    ].join('\n');
    const result = scanWorkflowContent(content);
    expect(result.safe).toBe(false);
    const finding = result.findings.find((f) => f.pattern === 'head-ref-injection');
    expect(finding).toBeDefined();
    expect(finding?.riskLevel).toBe('high');
  });

  it('detects write-all permissions', () => {
    const content = [
      'permissions: write-all',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo hi',
    ].join('\n');
    const result = scanWorkflowContent(content);
    const finding = result.findings.find((f) => f.pattern === 'write-all-permissions');
    expect(finding).toBeDefined();
    expect(finding?.riskLevel).toBe('medium');
  });

  it('detects curl pipe to shell', () => {
    const content = [
      'jobs:',
      '  setup:',
      '    steps:',
      '      - run: curl https://example.com/install.sh | sh',
    ].join('\n');
    const result = scanWorkflowContent(content);
    expect(result.safe).toBe(false);
    const finding = result.findings.find((f) => f.pattern === 'curl-pipe-shell');
    expect(finding).toBeDefined();
    expect(finding?.riskLevel).toBe('high');
  });

  it('returns safe=true for clean workflows', () => {
    const result = scanWorkflowContent(cleanWorkflow);
    expect(result.safe).toBe(true);
    const dangerous = result.findings.filter(
      (f) => f.riskLevel === 'critical' || f.riskLevel === 'high',
    );
    expect(dangerous).toHaveLength(0);
  });

  it('reports correct line numbers', () => {
    const content = [
      'name: CI',
      'on: [push]',
      'jobs:',
      '  build:',
      '    steps:',
      `      - run: echo "${EXPR} github.event.issue.title ${END}"`,
    ].join('\n');
    const result = scanWorkflowContent(content);
    const finding = result.findings.find((f) => f.pattern === 'expression-injection-run');
    expect(finding?.line).toBe(6);
  });

  it('handles multiple findings in one file', () => {
    const content = [
      'jobs:',
      '  bad:',
      '    steps:',
      `      - run: echo "${EXPR} github.event.issue.title ${END}"`,
      '      - run: curl https://example.com/script.sh | sh',
      `      - run: git checkout "${EXPR} github.head_ref ${END}"`,
    ].join('\n');
    const result = scanWorkflowContent(content);
    expect(result.findings.length).toBeGreaterThanOrEqual(3);
    expect(result.safe).toBe(false);
  });

  it('detects pull_request_target + unsafe checkout (multiline)', () => {
    const content = [
      'on:',
      '  pull_request_target:',
      '',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v3',
      '        with:',
      `          ref: ${EXPR} github.event.pull_request.head.sha ${END}`,
    ].join('\n');
    const result = scanWorkflowContent(content);
    const finding = result.findings.find((f) => f.pattern === 'pr-target-checkout');
    expect(finding).toBeDefined();
    expect(finding?.riskLevel).toBe('critical');
  });
});

describe('scanWorkflowFile', () => {
  it('handles read failure gracefully', () => {
    const readFileFn = (_repo: string, _file: string): string => {
      throw new Error('File not found');
    };
    const result = scanWorkflowFile('/repo', 'missing.yml', readFileFn);
    expect(result.safe).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toContain('Could not read file');
  });

  it('scans file content when read succeeds', () => {
    const line = `      - run: echo "${EXPR} github.event.issue.title ${END}"`;
    const readFileFn = (_repo: string, _file: string): string =>
      ['jobs:', '  x:', '    steps:', line].join('\n');
    const result = scanWorkflowFile('/repo', 'ci.yml', readFileFn);
    expect(result.safe).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
  });
});

describe('formatGhaScanReport', () => {
  it('groups by risk level', () => {
    const content = [
      'jobs:',
      '  x:',
      '    steps:',
      `      - run: echo "${EXPR} github.event.issue.title ${END}"`,
      '      - run: curl https://example.com/install.sh | sh',
    ].join('\n');
    const results = [scanWorkflowContent(content, 'ci.yml')];
    const report = formatGhaScanReport(results);
    expect(report).toContain('CRITICAL');
    expect(report).toContain('HIGH');
  });

  it('includes remediation text', () => {
    const line = `      - run: echo "${EXPR} github.event.issue.title ${END}"`;
    const content = ['jobs:', '  x:', '    steps:', line].join('\n');
    const results = [scanWorkflowContent(content, 'ci.yml')];
    const report = formatGhaScanReport(results);
    expect(report).toContain('Remediation');
    expect(report).toContain('environment variable');
  });

  it('returns clean message when no findings', () => {
    const results = [scanWorkflowContent(cleanWorkflow, 'ci.yml')];
    const report = formatGhaScanReport(results);
    expect(report).toMatch(/No vulnerabilities found|0\/1 workflow/);
  });
});

describe('GHA_PATTERNS', () => {
  it('has at least 7 patterns', () => {
    expect(GHA_PATTERNS.length).toBeGreaterThanOrEqual(7);
  });

  it('each pattern includes remediation string', () => {
    for (const p of GHA_PATTERNS) {
      expect(typeof p.remediation).toBe('string');
      expect(p.remediation.length).toBeGreaterThan(0);
    }
  });
});
