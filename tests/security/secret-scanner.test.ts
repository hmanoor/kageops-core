import { describe, it, expect } from 'vitest';
import {
  scanContent,
  scanFiles,
  maskSecret,
  formatScanReport,
  isAllowlisted,
  DEFAULT_SECRET_PATTERNS,
  createDefaultScanConfig,
  checkSandboxPolicy,
  createDefaultSandboxPolicy,
  isPathAllowed,
  isCommandBlocked,
  formatSandboxReport,
  mergeSandboxPolicies,
  type SecretFinding,
  type ScanResult,
  type SandboxPolicy,
} from '../../src/security/secret-scanner';

describe('Secret Scanner', () => {
  describe('scanContent', () => {
    it.each([
      ['AWS Access Key', 'const key = "AKIAIOSFODNN7EXAMPLE1";', 'AKIAIOSFODNN7EXAMPLE1'],
      ['GitHub Token', 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', 'ghp_'],
      ['Anthropic API Key', 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrst', 'sk-ant-'],
      ['Private Key', '-----BEGIN RSA PRIVATE KEY-----', 'PRIVATE KEY'],
      ['Stripe Key', 'sk_live_ABCDEFGHIJKLMNOPQRSTu', 'sk_live_'],
      ['OpenAI API Key', 'OPENAI_KEY=sk-abc123def456ghi789jkl012mno', 'sk-'],
      ['Slack Token', 'SLACK=xoxb-1234567890-abcdefghij', 'xoxb-'],
      ['npm Token', 'NPM_TOKEN=npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', 'npm_'],
    ])('finds %s pattern', (patternName, content, _marker) => {
      const findings = scanContent(content, 'test.ts', DEFAULT_SECRET_PATTERNS);
      expect(findings.length).toBeGreaterThanOrEqual(1);
      expect(findings.some((f) => f.pattern === patternName)).toBe(true);
    });

    it('returns empty findings for clean content', () => {
      const clean = 'const greeting = "hello world";\nconst x = 42;';
      const findings = scanContent(clean, 'clean.ts', DEFAULT_SECRET_PATTERNS);
      expect(findings).toEqual([]);
    });

    it('reports correct line and column numbers', () => {
      const content = 'line1\nconst k = "AKIAIOSFODNN7EXAMPLE1";\nline3';
      const findings = scanContent(content, 'test.ts', DEFAULT_SECRET_PATTERNS);
      expect(findings[0].line).toBe(2);
      expect(findings[0].column).toBeGreaterThan(0);
      expect(findings[0].file).toBe('test.ts');
    });

    it('truncates long preview lines', () => {
      const longLine = 'x'.repeat(90) + ' AKIAIOSFODNN7EXAMPLE1';
      const findings = scanContent(longLine, 'f.ts', DEFAULT_SECRET_PATTERNS);
      expect(findings[0].preview.length).toBeLessThanOrEqual(83); // 80 + '...'
    });
  });

  describe('maskSecret', () => {
    it('hides middle of secret preview', () => {
      const finding: SecretFinding = {
        pattern: 'test', file: 'f.ts', line: 1, column: 1,
        preview: 'AKIAIOSFODNN7EXAMPLE1', severity: 'critical',
      };
      const masked = maskSecret(finding);
      expect(masked.startsWith('AKI')).toBe(true);
      expect(masked.endsWith('LE1')).toBe(true);
      expect(masked).toContain('***');
    });

    it('handles short values', () => {
      const finding: SecretFinding = {
        pattern: 'test', file: 'f.ts', line: 1, column: 1,
        preview: 'abc', severity: 'medium',
      };
      expect(maskSecret(finding)).toBe('***');
    });
  });

  describe('isAllowlisted', () => {
    it('matches allowlisted preview content', () => {
      const finding: SecretFinding = {
        pattern: 'Anthropic API Key', file: 'test.ts', line: 1, column: 1,
        preview: 'key=sk-ant-test-1234567890abcdef', severity: 'critical',
      };
      expect(isAllowlisted(finding, ['sk-ant-test'])).toBe(true);
    });

    it('returns false when not allowlisted', () => {
      const finding: SecretFinding = {
        pattern: 'AWS', file: 'prod.ts', line: 1, column: 1,
        preview: 'AKIAIOSFODNN7REAL_KEY', severity: 'critical',
      };
      expect(isAllowlisted(finding, ['sk-ant-test'])).toBe(false);
    });
  });

  describe('scanFiles', () => {
    const config = createDefaultScanConfig();

    it('respects excludePaths', () => {
      const files = [
        { path: 'node_modules/pkg/index.js', content: 'key=AKIAIOSFODNN7EXAMPLE1' },
        { path: 'src/app.ts', content: 'const x = 1;' },
      ];
      const result = scanFiles(files, config);
      expect(result.scannedFiles).toBe(1);
      expect(result.passed).toBe(true);
    });

    it('respects maxFileSize', () => {
      const bigContent = 'AKIAIOSFODNN7EXAMPLE1\n' + 'x'.repeat(2_000_000);
      const files = [{ path: 'big.ts', content: bigContent }];
      const result = scanFiles(files, { ...config, maxFileSize: 100 });
      expect(result.scannedFiles).toBe(0);
    });

    it('filters allowlisted findings', () => {
      const files = [{ path: 'test.ts', content: 'key=AKIAIOSFODNN7EXAMPLE' }];
      const result = scanFiles(files, config);
      // AKIAIOSFODNN7EXAMPLE is in default allowlist
      expect(result.passed).toBe(true);
    });

    it('reports non-allowlisted findings', () => {
      const files = [{ path: 'src/config.ts', content: 'key=AKIAIOSFODNN7REALKEY1' }];
      const result = scanFiles(files, config);
      expect(result.passed).toBe(false);
      expect(result.findings.length).toBeGreaterThan(0);
    });
  });

  describe('formatScanReport', () => {
    it('produces readable markdown for passing scan', () => {
      const result: ScanResult = { findings: [], scannedFiles: 5, duration: 10, passed: true };
      const report = formatScanReport(result);
      expect(report).toContain('# Secret Scan Report');
      expect(report).toContain('PASSED');
      expect(report).toContain('Files scanned');
    });

    it('includes findings in failing report', () => {
      const result: ScanResult = {
        findings: [{
          pattern: 'AWS Access Key', file: 'x.ts', line: 1, column: 1,
          preview: 'AKIAIOSFODNN7EXAMPLE1', severity: 'critical',
        }],
        scannedFiles: 1, duration: 5, passed: false,
      };
      const report = formatScanReport(result);
      expect(report).toContain('FAILED');
      expect(report).toContain('AWS Access Key');
    });
  });

  describe('DEFAULT_SECRET_PATTERNS', () => {
    it('has at least 12 patterns', () => {
      expect(DEFAULT_SECRET_PATTERNS.length).toBeGreaterThanOrEqual(12);
    });

    it.each(
      DEFAULT_SECRET_PATTERNS.map((p) => [p.name, p])
    )('pattern "%s" has valid regex', (_name, pat) => {
      const p = pat as typeof DEFAULT_SECRET_PATTERNS[number];
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(p.severity).toMatch(/^(critical|high|medium)$/);
      expect(p.description.length).toBeGreaterThan(0);
    });
  });
});

describe('Agent Action Sandboxing', () => {
  describe('checkSandboxPolicy', () => {
    const policy = createDefaultSandboxPolicy('/repo/project');

    it('blocks network when not allowed', () => {
      const result = checkSandboxPolicy('network', ['https://evil.com'], policy);
      expect(result.allowed).toBe(false);
      expect(result.violations[0].policy).toBe('allowNetwork');
    });

    it('allows file write inside repo', () => {
      const result = checkSandboxPolicy('file_write', ['/repo/project/src/file.ts'], policy);
      expect(result.allowed).toBe(true);
    });

    it('blocks file write outside allowed paths', () => {
      const writePolicy: SandboxPolicy = { ...policy, allowFileWrite: true };
      const result = checkSandboxPolicy('file_write', ['/etc/passwd'], writePolicy);
      expect(result.allowed).toBe(false);
      expect(result.violations[0].policy).toBe('allowedPaths');
    });

    it('blocks shell when not allowed', () => {
      const result = checkSandboxPolicy('shell', ['ls'], policy);
      expect(result.allowed).toBe(false);
    });

    it.each([
      ['rm -rf /', 'blockedCommands'],
      ['format C:', 'blockedCommands'],
      ['shutdown -h now', 'blockedCommands'],
    ])('blocks dangerous command "%s"', (cmd, expectedPolicy) => {
      const shellPolicy: SandboxPolicy = { ...policy, allowShell: true };
      const result = checkSandboxPolicy('shell', [cmd], shellPolicy);
      expect(result.allowed).toBe(false);
      expect(result.violations[0].policy).toBe(expectedPolicy);
    });

    it('reports checkedPolicies count', () => {
      const result = checkSandboxPolicy('network', [], policy);
      expect(result.checkedPolicies).toBeGreaterThanOrEqual(3);
    });
  });

  describe('isPathAllowed', () => {
    it('allows paths within allowed directories', () => {
      expect(isPathAllowed('/repo/src/file.ts', ['/repo'])).toBe(true);
    });

    it('prevents path traversal with ../', () => {
      expect(isPathAllowed('/repo/../etc/passwd', ['/repo'])).toBe(false);
    });

    it('rejects paths outside allowed list', () => {
      expect(isPathAllowed('/etc/shadow', ['/repo'])).toBe(false);
    });

    it('normalizes backslashes', () => {
      expect(isPathAllowed('C:\\repo\\src\\file.ts', ['C:/repo'])).toBe(true);
    });
  });

  describe('isCommandBlocked', () => {
    it.each([
      ['rm -rf /', true],
      ['format C:', true],
      ['shutdown -h now', true],
      ['ls -la', false],
      ['git status', false],
    ])('command "%s" blocked=%s', (cmd, expected) => {
      const blocked = ['rm -rf /', 'format', 'shutdown', 'reboot', 'mkfs', 'dd if='];
      expect(isCommandBlocked(cmd, blocked)).toBe(expected);
    });
  });

  describe('createDefaultSandboxPolicy', () => {
    it('scopes allowed paths to repo', () => {
      const policy = createDefaultSandboxPolicy('/my/repo');
      expect(policy.allowedPaths).toContain('/my/repo');
      expect(policy.allowNetwork).toBe(false);
      expect(policy.allowShell).toBe(false);
    });

    it('normalizes backslashes in repo path', () => {
      const policy = createDefaultSandboxPolicy('C:\\Users\\repo');
      expect(policy.allowedPaths[0]).toBe('C:/Users/repo');
    });
  });

  describe('mergeSandboxPolicies', () => {
    it('overrides specific fields immutably', () => {
      const base = createDefaultSandboxPolicy('/repo');
      const merged = mergeSandboxPolicies(base, { allowNetwork: true });
      expect(merged.allowNetwork).toBe(true);
      expect(base.allowNetwork).toBe(false); // original unchanged
      expect(merged.allowShell).toBe(false); // non-overridden preserved
    });
  });

  describe('formatSandboxReport', () => {
    it('produces readable markdown', () => {
      const result: import('../../src/security/secret-scanner').SandboxResult = {
        allowed: false,
        violations: [{ policy: 'allowNetwork', action: 'network', detail: 'blocked', timestamp: '2026-01-01T00:00:00Z' }],
        checkedPolicies: 4,
      };
      const report = formatSandboxReport(result);
      expect(report).toContain('# Sandbox Check Report');
      expect(report).toContain('NO');
      expect(report).toContain('allowNetwork');
    });
  });
});
