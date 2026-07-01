/**
 * KageOps Pre-Commit Secret Scanner
 *
 * Scans staged files for hardcoded secrets, API keys, and
 * sensitive patterns. Pure functions — no file I/O.
 */

// ── Types ────────────────────────────────────────────

export interface ScanRule {
    readonly name: string;
    readonly pattern: RegExp;
    readonly severity: 'block' | 'warn';
    readonly message: string;
}

export interface ScanFinding {
    readonly file: string;
    readonly line: number;
    readonly rule: string;
    readonly severity: 'block' | 'warn';
    readonly preview: string;
}

export interface PreCommitResult {
    readonly passed: boolean;
    readonly findings: readonly ScanFinding[];
    readonly scannedFiles: number;
    readonly duration: number;
}

export interface PreCommitConfig {
    readonly rules: readonly ScanRule[];
    readonly excludePatterns: readonly string[];
    readonly maxFileSize: number;
    /**
     * Lines matching any of these are skipped — for documented placeholders,
     * docs examples, and the scanner's own allowlist literals. A real secret
     * never contains "placeholder"/"example"/"CHANGE_ME", so this clears the
     * known false positives without weakening detection of actual secrets.
     */
    readonly allowlist: readonly RegExp[];
}

// ── Default Rules ────────────────────────────────────

export const DEFAULT_SCAN_RULES: readonly ScanRule[] = [
    {
        name: 'aws-access-key',
        pattern: /AKIA[0-9A-Z]{16}/,
        severity: 'block',
        message: 'AWS Access Key ID detected',
    },
    {
        name: 'aws-secret-key',
        pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*\S{20,}/,
        severity: 'block',
        message: 'AWS Secret Access Key detected',
    },
    {
        name: 'github-token',
        pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/,
        severity: 'block',
        message: 'GitHub personal access token detected',
    },
    {
        name: 'anthropic-api-key',
        // Real keys contain underscores (sk-ant-api03-_…); the old class omitted
        // `_`, so a genuine key in .env.example evaded the scanner. (S1 fix.)
        pattern: /sk-ant-[A-Za-z0-9_-]{20,}/,
        severity: 'block',
        message: 'Anthropic API key detected',
    },
    {
        name: 'openai-api-key',
        pattern: /sk-proj-[A-Za-z0-9_-]{20,}/,
        severity: 'block',
        message: 'OpenAI API key detected',
    },
    {
        name: 'openrouter-api-key',
        pattern: /sk-or-v1-[A-Za-z0-9]{32,}/,
        severity: 'block',
        message: 'OpenRouter API key detected',
    },
    {
        name: 'slack-token',
        pattern: /xox[bporas]-[A-Za-z0-9-]{10,}/,
        severity: 'block',
        message: 'Slack token detected',
    },
    {
        name: 'stripe-key',
        pattern: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/,
        severity: 'block',
        message: 'Stripe API key detected',
    },
    {
        name: 'private-key',
        pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
        severity: 'block',
        message: 'Private key detected',
    },
    {
        name: 'connection-string',
        pattern: /(?:postgres|mysql|mongodb):\/\/[^:]+:[^@]+@[^\s]+/,
        severity: 'warn',
        message: 'Database connection string with credentials detected',
    },
    {
        name: 'hardcoded-password',
        pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"][^'"]{8,}['"]/i,
        severity: 'warn',
        message: 'Possible hardcoded password detected',
    },
];

const DEFAULT_EXCLUDES: readonly string[] = [
    '*.test.ts',
    '*.test.js',
    '*.spec.ts',
    '*.spec.js',
    'node_modules/*',
    'dist/*',
    '*.lock',
    '*.snap',
];

/**
 * Lines containing any of these tokens are treated as documented non-secrets
 * (placeholders, docs examples, the scanner's own allowlist literals). Kept
 * deliberately narrow to "this is obviously not a real value" markers.
 */
export const DEFAULT_ALLOWLIST: readonly RegExp[] = [
    /placeholder/i,
    /\bexample\b/i,
    /EXAMPLE/, // AWS's canonical AKIAIOSFODNN7EXAMPLE doc key
    /change[_-]?me/i,
    /your[_-][a-z0-9-]*(?:key|token|secret|password|api)/i, // your-anthropic-key-here etc.
    /xxxx+/i,
    /Y2xlcmsuZXhhbXBsZS5jb20k/, // Clerk's public example key (base64 "clerk.example.com$")
];

/** True when a line matches any allowlist pattern (documented non-secret). */
export function isAllowlistedLine(line: string, allowlist: readonly RegExp[]): boolean {
    return allowlist.some((re) => re.test(line));
}

// ── Functions ────────────────────────────────────────

/**
 * Scan a single file's content against a set of rules, returning findings.
 */
export function scanFileContent(
    content: string,
    fileName: string,
    rules: readonly ScanRule[],
    allowlist: readonly RegExp[] = [],
): readonly ScanFinding[] {
    const lines = content.split('\n');
    const findings: ScanFinding[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (isAllowlistedLine(line, allowlist)) {
            continue;
        }
        for (const rule of rules) {
            if (rule.pattern.test(line)) {
                const preview = line.length > 80 ? line.slice(0, 77) + '...' : line;
                findings.push({
                    file: fileName,
                    line: i + 1,
                    rule: rule.name,
                    severity: rule.severity,
                    preview: preview.trim(),
                });
            }
        }
    }

    return findings;
}

/**
 * Check whether a file should be excluded from scanning.
 * Supports simple glob patterns: *.ext and dir/* style.
 */
export function shouldExcludeFile(
    fileName: string,
    excludePatterns: readonly string[],
): boolean {
    for (const pattern of excludePatterns) {
        if (pattern.startsWith('*')) {
            // Extension match: *.test.ts
            const suffix = pattern.slice(1);
            if (fileName.endsWith(suffix)) {
                return true;
            }
        } else if (pattern.endsWith('/*')) {
            // Directory match: node_modules/*
            const prefix = pattern.slice(0, -1);
            if (fileName.startsWith(prefix) || fileName.includes('/' + prefix)) {
                return true;
            }
        } else if (fileName === pattern) {
            return true;
        }
    }
    return false;
}

/**
 * Run a pre-commit scan across multiple files.
 */
export function runPreCommitScan(
    files: readonly { readonly path: string; readonly content: string }[],
    config: PreCommitConfig,
): PreCommitResult {
    const start = Date.now();
    const allFindings: ScanFinding[] = [];
    let scannedFiles = 0;

    for (const file of files) {
        if (shouldExcludeFile(file.path, config.excludePatterns)) {
            continue;
        }
        if (file.content.length > config.maxFileSize) {
            continue;
        }
        scannedFiles++;
        const findings = scanFileContent(file.content, file.path, config.rules, config.allowlist);
        allFindings.push(...findings);
    }

    const hasBlocking = allFindings.some((f) => f.severity === 'block');

    return {
        passed: !hasBlocking,
        findings: allFindings,
        scannedFiles,
        duration: Date.now() - start,
    };
}

/**
 * Format scan results as a markdown report.
 */
export function formatPreCommitReport(result: PreCommitResult): string {
    const header = result.passed ? '# PASSED' : '# BLOCKED';
    const lines: string[] = [
        header,
        '',
        `**Scanned:** ${result.scannedFiles} files | **Findings:** ${result.findings.length} | **Duration:** ${result.duration}ms`,
    ];

    if (result.findings.length > 0) {
        lines.push('', '| File | Line | Rule | Severity | Preview |');
        lines.push('|------|------|------|----------|---------|');
        for (const f of result.findings) {
            lines.push(`| ${f.file} | ${f.line} | ${f.rule} | ${f.severity} | ${f.preview} |`);
        }
    }

    return lines.join('\n');
}

/**
 * Create a default pre-commit config.
 */
export function createDefaultConfig(): PreCommitConfig {
    return {
        rules: DEFAULT_SCAN_RULES,
        excludePatterns: DEFAULT_EXCLUDES,
        maxFileSize: 1_000_000,
        allowlist: DEFAULT_ALLOWLIST,
    };
}

/**
 * Check whether a result contains any blocking findings.
 */
export function hasBlockingFindings(result: PreCommitResult): boolean {
    return result.findings.some((f) => f.severity === 'block');
}

/**
 * Generate shell script content for a .git/hooks/pre-commit hook.
 */
export function generateGitHook(configPath: string): string {
    return [
        '#!/bin/sh',
        '# KageOps pre-commit secret scanner',
        '# Auto-generated — do not edit manually',
        '',
        'set -e',
        '',
        `CONFIG_PATH="${configPath}"`,
        '',
        '# Get staged files',
        'STAGED=$(git diff --cached --name-only --diff-filter=ACM)',
        '',
        'if [ -z "$STAGED" ]; then',
        '  exit 0',
        'fi',
        '',
        '# Run scanner via npx',
        'npx ts-node --transpile-only scripts/pre-commit-scan.ts "$CONFIG_PATH" $STAGED',
        '',
        'exit $?',
    ].join('\n');
}
