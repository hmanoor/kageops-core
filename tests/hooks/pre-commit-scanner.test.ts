/**
 * Pre-commit secret scanner tests
 */

import { describe, it, expect } from 'vitest';
import {
    DEFAULT_SCAN_RULES,
    scanFileContent,
    shouldExcludeFile,
    runPreCommitScan,
    formatPreCommitReport,
    createDefaultConfig,
    hasBlockingFindings,
    generateGitHook,
    type PreCommitResult,
    type PreCommitConfig,
} from '../../src/hooks/pre-commit-scanner';

// ── scanFileContent ─────────────────────────────────

describe('scanFileContent', () => {
    it('detects AWS access key', () => {
        const content = 'const key = "AKIAIOSFODNN7EXAMPLE";';
        const findings = scanFileContent(content, 'config.ts', DEFAULT_SCAN_RULES);
        expect(findings.length).toBeGreaterThanOrEqual(1);
        expect(findings[0].rule).toBe('aws-access-key');
        expect(findings[0].severity).toBe('block');
    });

    it('detects GitHub personal access token', () => {
        const content = 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm";';
        const findings = scanFileContent(content, 'app.ts', DEFAULT_SCAN_RULES);
        expect(findings.some((f) => f.rule === 'github-token')).toBe(true);
    });

    it('detects Anthropic API key', () => {
        const content = 'ANTHROPIC_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz';
        const findings = scanFileContent(content, '.env', DEFAULT_SCAN_RULES);
        expect(findings.some((f) => f.rule === 'anthropic-api-key')).toBe(true);
    });

    it('detects OpenAI API key', () => {
        const content = 'const key = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";';
        const findings = scanFileContent(content, 'ai.ts', DEFAULT_SCAN_RULES);
        expect(findings.some((f) => f.rule === 'openai-api-key')).toBe(true);
    });

    it('detects Stripe live key', () => {
        const content = 'const stripe = "sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm";';
        const findings = scanFileContent(content, 'pay.ts', DEFAULT_SCAN_RULES);
        expect(findings.some((f) => f.rule === 'stripe-key')).toBe(true);
    });

    it('detects private keys', () => {
        const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...';
        const findings = scanFileContent(content, 'key.pem', DEFAULT_SCAN_RULES);
        expect(findings.some((f) => f.rule === 'private-key')).toBe(true);
    });

    it('detects connection strings as warnings', () => {
        const content = 'DATABASE_URL=postgres://user:pass@host:5432/db';
        const findings = scanFileContent(content, 'config.ts', DEFAULT_SCAN_RULES);
        const connFindings = findings.filter((f) => f.rule === 'connection-string');
        expect(connFindings.length).toBe(1);
        expect(connFindings[0].severity).toBe('warn');
    });

    it('returns empty array for clean files', () => {
        const content = 'const greeting = "hello world";\nexport default greeting;';
        const findings = scanFileContent(content, 'clean.ts', DEFAULT_SCAN_RULES);
        expect(findings).toEqual([]);
    });

    it('reports correct line numbers', () => {
        const content = 'line1\nline2\nconst key = "AKIAIOSFODNN7EXAMPLE";\nline4';
        const findings = scanFileContent(content, 'f.ts', DEFAULT_SCAN_RULES);
        expect(findings[0].line).toBe(3);
    });

    it('truncates long preview lines', () => {
        const longLine = 'const key = "AKIAIOSFODNN7EXAMPLE" // ' + 'x'.repeat(100);
        const findings = scanFileContent(longLine, 'f.ts', DEFAULT_SCAN_RULES);
        expect(findings[0].preview.length).toBeLessThanOrEqual(80);
    });

    it.each([
        ['slack-token', 'const t = "xoxb-1234567890-abcdef";'],
        ['hardcoded-password', 'password = "supersecret123"'],
    ])('detects %s pattern', (ruleName, content) => {
        const findings = scanFileContent(content, 'f.ts', DEFAULT_SCAN_RULES);
        expect(findings.some((f) => f.rule === ruleName)).toBe(true);
    });
});

// ── shouldExcludeFile ───────────────────────────────

describe('shouldExcludeFile', () => {
    const patterns = ['*.test.ts', 'node_modules/*', 'dist/*'];

    it.each([
        ['foo.test.ts', true],
        ['node_modules/pkg/index.js', true],
        ['src/main.ts', false],
        ['dist/bundle.js', true],
    ])('shouldExcludeFile(%s) => %s', (file, expected) => {
        expect(shouldExcludeFile(file, patterns)).toBe(expected);
    });
});

// ── runPreCommitScan ────────────────────────────────

describe('runPreCommitScan', () => {
    const config = createDefaultConfig();

    it('passes for clean files', () => {
        const files = [{ path: 'src/app.ts', content: 'export const x = 1;' }];
        const result = runPreCommitScan(files, config);
        expect(result.passed).toBe(true);
        expect(result.findings).toEqual([]);
        expect(result.scannedFiles).toBe(1);
    });

    it('blocks on secret detection', () => {
        // A non-allowlisted AWS key (AKIAIOSFODNN7EXAMPLE is now allowlisted as a doc key).
        const files = [{ path: 'src/config.ts', content: 'const k = "AKIA1234567890ABCDEF";' }];
        const result = runPreCommitScan(files, config);
        expect(result.passed).toBe(false);
    });

    it('excludes test files by default', () => {
        const files = [{ path: 'src/foo.test.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE";' }];
        const result = runPreCommitScan(files, config);
        expect(result.scannedFiles).toBe(0);
        expect(result.passed).toBe(true);
    });

    it('skips files exceeding maxFileSize', () => {
        const smallConfig: PreCommitConfig = { ...config, maxFileSize: 10 };
        const files = [{ path: 'src/big.ts', content: 'x'.repeat(100) }];
        const result = runPreCommitScan(files, smallConfig);
        expect(result.scannedFiles).toBe(0);
    });
});

// ── formatPreCommitReport ───────────────────────────

describe('formatPreCommitReport', () => {
    it('shows PASSED for clean results', () => {
        const result: PreCommitResult = { passed: true, findings: [], scannedFiles: 3, duration: 5 };
        const report = formatPreCommitReport(result);
        expect(report).toContain('PASSED');
    });

    it('shows BLOCKED for failed results', () => {
        const result: PreCommitResult = {
            passed: false,
            findings: [{ file: 'a.ts', line: 1, rule: 'aws-access-key', severity: 'block', preview: 'AKIA...' }],
            scannedFiles: 1,
            duration: 2,
        };
        const report = formatPreCommitReport(result);
        expect(report).toContain('BLOCKED');
        expect(report).toContain('aws-access-key');
    });
});

// ── hasBlockingFindings ─────────────────────────────

describe('hasBlockingFindings', () => {
    it('returns false when only warnings', () => {
        const result: PreCommitResult = {
            passed: true,
            findings: [{ file: 'a.ts', line: 1, rule: 'conn', severity: 'warn', preview: '...' }],
            scannedFiles: 1,
            duration: 1,
        };
        expect(hasBlockingFindings(result)).toBe(false);
    });

    it('returns true when block findings exist', () => {
        const result: PreCommitResult = {
            passed: false,
            findings: [{ file: 'a.ts', line: 1, rule: 'key', severity: 'block', preview: '...' }],
            scannedFiles: 1,
            duration: 1,
        };
        expect(hasBlockingFindings(result)).toBe(true);
    });
});

// ── generateGitHook ─────────────────────────────────

describe('generateGitHook', () => {
    it('generates valid shell script with config path', () => {
        const script = generateGitHook('.kageops/scan.json');
        expect(script).toContain('#!/bin/sh');
        expect(script).toContain('.kageops/scan.json');
        expect(script).toContain('git diff --cached');
    });
});

// ── DEFAULT_SCAN_RULES ──────────────────────────────

describe('DEFAULT_SCAN_RULES', () => {
    it('contains 11 rules', () => {
        expect(DEFAULT_SCAN_RULES.length).toBe(11);
    });

    it('all rules have required fields', () => {
        for (const rule of DEFAULT_SCAN_RULES) {
            expect(rule.name).toBeTruthy();
            expect(rule.pattern).toBeInstanceOf(RegExp);
            expect(['block', 'warn']).toContain(rule.severity);
            expect(rule.message).toBeTruthy();
        }
    });

    it('detects a real-shaped Anthropic key (underscores included — S1 regression)', () => {
        // Synthetic key with underscores — the case the old regex missed.
        const findings = scanFileContent(
            'ANTHROPIC_API_KEY=sk-ant-api03-AAAA_BBBB_CCCC_DDDD_EEEE_FFFF_GGGG',
            'config.ts',
            DEFAULT_SCAN_RULES,
        );
        expect(findings.some((f) => f.rule === 'anthropic-api-key')).toBe(true);
    });

    it('detects an OpenRouter key', () => {
        const findings = scanFileContent(
            'OPENROUTER_API_KEY=sk-or-v1-00000000000000000000000000000000000000000000000000000000000000ab',
            'config.ts',
            DEFAULT_SCAN_RULES,
        );
        expect(findings.some((f) => f.rule === 'openrouter-api-key')).toBe(true);
    });
});

describe('DEFAULT_ALLOWLIST', () => {
    it('skips documented placeholders / example keys', () => {
        const cfg = createDefaultConfig();
        const files = [
            { path: '.env.example', content: 'ANTHROPIC_API_KEY=sk-ant-api03-your-anthropic-key-here' },
            { path: 'bundle.yaml', content: 'KEY: "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k"' },
            { path: 'doc.md', content: 'aws AKIAIOSFODNN7EXAMPLE' },
        ];
        const result = runPreCommitScan(files, cfg);
        expect(result.passed).toBe(true);
        expect(result.findings).toEqual([]);
    });

    it('still blocks a genuine key on a non-allowlisted line', () => {
        const cfg = createDefaultConfig();
        const files = [{ path: 'src/x.ts', content: 'const k = "AKIA1234567890ABCDEF";' }];
        expect(runPreCommitScan(files, cfg).passed).toBe(false);
    });
});
