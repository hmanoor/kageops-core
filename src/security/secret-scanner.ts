/**
 * B-142: Pre-Commit Secret Scanning Hook
 * B-143: Agent Action Sandboxing
 */

// --- Types ---

export interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly severity: 'critical' | 'high' | 'medium';
  readonly description: string;
}

export interface SecretFinding {
  readonly pattern: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
  readonly severity: 'critical' | 'high' | 'medium';
}

export interface ScanResult {
  readonly findings: readonly SecretFinding[];
  readonly scannedFiles: number;
  readonly duration: number;
  readonly passed: boolean;
}

export interface ScanConfig {
  readonly patterns: readonly SecretPattern[];
  readonly excludePaths: readonly string[];
  readonly maxFileSize: number;
  readonly allowlist: readonly string[];
}

export interface SandboxPolicy {
  readonly allowNetwork: boolean;
  readonly allowFileWrite: boolean;
  readonly allowShell: boolean;
  readonly allowedPaths: readonly string[];
  readonly blockedCommands: readonly string[];
  readonly maxExecutionMs: number;
  readonly maxMemoryMb: number;
}

export interface SandboxViolation {
  readonly policy: string;
  readonly action: string;
  readonly detail: string;
  readonly timestamp: string;
}

export interface SandboxResult {
  readonly allowed: boolean;
  readonly violations: readonly SandboxViolation[];
  readonly checkedPolicies: number;
}

// --- Default Patterns ---

export const DEFAULT_SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/, severity: 'critical', description: 'AWS access key ID' },
  { name: 'AWS Secret Key', pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/, severity: 'critical', description: 'AWS secret access key' },
  { name: 'GitHub Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,255}/, severity: 'critical', description: 'GitHub personal access token' },
  { name: 'Anthropic API Key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/, severity: 'critical', description: 'Anthropic API key' },
  { name: 'OpenAI API Key', pattern: /sk-[A-Za-z0-9]{20,}/, severity: 'critical', description: 'OpenAI API key' },
  { name: 'Generic API Key', pattern: /(?:api_key|apikey|api-key)\s*[=:]\s*["']([A-Za-z0-9_\-]{20,})["']/, severity: 'high', description: 'Generic API key in config' },
  { name: 'JWT Token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-+/=]{10,}/, severity: 'high', description: 'JSON Web Token' },
  { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, severity: 'critical', description: 'Private key header' },
  { name: 'Connection String', pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^\s"']{10,}/, severity: 'high', description: 'Database connection string' },
  { name: 'Basic Auth URL', pattern: /https?:\/\/[^:\s]+:[^@\s]+@[^\s"']+/, severity: 'high', description: 'URL with embedded credentials' },
  { name: 'Slack Token', pattern: /xox[bpras]-[0-9]{10,}-[A-Za-z0-9-]+/, severity: 'high', description: 'Slack API token' },
  { name: 'Stripe Key', pattern: /[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/, severity: 'critical', description: 'Stripe API key' },
  { name: 'npm Token', pattern: /npm_[A-Za-z0-9]{36}/, severity: 'high', description: 'npm access token' },
] as const;

// --- Secret Scanning ---

export function scanContent(
  content: string,
  fileName: string,
  patterns: readonly SecretPattern[]
): readonly SecretFinding[] {
  const lines = content.split('\n');
  const findings: SecretFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of patterns) {
      const match = pat.pattern.exec(line);
      if (match) {
        const preview = line.length > 80 ? line.slice(0, 80) + '...' : line;
        findings.push({
          pattern: pat.name,
          file: fileName,
          line: i + 1,
          column: match.index + 1,
          preview,
          severity: pat.severity,
        });
      }
    }
  }

  return findings;
}

export function isAllowlisted(
  finding: SecretFinding,
  allowlist: readonly string[]
): boolean {
  return allowlist.some(
    (entry) =>
      finding.preview.includes(entry) ||
      finding.file.includes(entry) ||
      finding.pattern.includes(entry)
  );
}

export function scanFiles(
  files: readonly { readonly path: string; readonly content: string }[],
  config: ScanConfig
): ScanResult {
  const start = Date.now();
  let scannedFiles = 0;
  const allFindings: SecretFinding[] = [];

  for (const file of files) {
    if (config.excludePaths.some((ep) => file.path.includes(ep))) continue;
    if (file.content.length > config.maxFileSize) continue;
    scannedFiles++;
    const findings = scanContent(file.content, file.path, config.patterns);
    for (const f of findings) {
      if (!isAllowlisted(f, config.allowlist)) {
        allFindings.push(f);
      }
    }
  }

  return {
    findings: allFindings,
    scannedFiles,
    duration: Date.now() - start,
    passed: allFindings.length === 0,
  };
}

export function maskSecret(finding: SecretFinding): string {
  const match = finding.preview.trim();
  if (match.length <= 6) return '***';
  return match.slice(0, 3) + '*'.repeat(Math.max(match.length - 6, 3)) + match.slice(-3);
}

export function formatScanReport(result: ScanResult): string {
  const lines: string[] = [
    `# Secret Scan Report`,
    '',
    `- **Status**: ${result.passed ? 'PASSED' : 'FAILED'}`,
    `- **Files scanned**: ${result.scannedFiles}`,
    `- **Findings**: ${result.findings.length}`,
    `- **Duration**: ${result.duration}ms`,
  ];

  if (result.findings.length > 0) {
    lines.push('', '## Findings', '');
    for (const f of result.findings) {
      lines.push(`### ${f.severity.toUpperCase()}: ${f.pattern}`);
      lines.push(`- **File**: ${f.file}:${f.line}:${f.column}`);
      lines.push(`- **Preview**: \`${f.preview}\``);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function createDefaultScanConfig(): ScanConfig {
  return {
    patterns: DEFAULT_SECRET_PATTERNS,
    excludePaths: ['node_modules', '.git', 'dist', 'coverage'],
    maxFileSize: 1_000_000,
    allowlist: ['sk-ant-test', 'sk-test-', 'AKIAIOSFODNN7EXAMPLE'],
  };
}

// --- Sandbox ---

export function isPathAllowed(
  path: string,
  allowedPaths: readonly string[]
): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.includes('..')) return false;
  return allowedPaths.some((ap) => normalized.startsWith(ap.replace(/\\/g, '/')));
}

export function isCommandBlocked(
  command: string,
  blockedCommands: readonly string[]
): boolean {
  const lower = command.toLowerCase().trim();
  return blockedCommands.some((bc) => lower.includes(bc.toLowerCase()));
}

function violation(policy: string, action: string, detail: string): SandboxViolation {
  return { policy, action, detail, timestamp: new Date().toISOString() };
}

export function checkSandboxPolicy(
  action: string,
  args: readonly string[],
  policy: SandboxPolicy
): SandboxResult {
  const violations: SandboxViolation[] = [];
  let checkedPolicies = 0;

  // Network check
  checkedPolicies++;
  if (action === 'network' && !policy.allowNetwork) {
    violations.push(violation('allowNetwork', action, `Network access denied: ${args[0] ?? ''}`));
  }

  // File write check
  checkedPolicies++;
  if (action === 'file_write') {
    if (!policy.allowFileWrite) {
      violations.push(violation('allowFileWrite', action, 'File write not allowed'));
    } else if (args[0] && !isPathAllowed(args[0], policy.allowedPaths)) {
      violations.push(violation('allowedPaths', action, `Path not allowed: ${args[0]}`));
    }
  }

  // Shell check
  checkedPolicies++;
  if (action === 'shell') {
    if (!policy.allowShell) {
      violations.push(violation('allowShell', action, 'Shell access not allowed'));
    } else if (args[0] && isCommandBlocked(args[0], policy.blockedCommands)) {
      violations.push(violation('blockedCommands', action, `Command blocked: ${args[0]}`));
    }
  }

  // File read path check
  checkedPolicies++;
  if (action === 'file_read' && args[0] && !isPathAllowed(args[0], policy.allowedPaths)) {
    violations.push(violation('allowedPaths', action, `Read path not allowed: ${args[0]}`));
  }

  return {
    allowed: violations.length === 0,
    violations,
    checkedPolicies,
  };
}

export function createDefaultSandboxPolicy(repoPath: string): SandboxPolicy {
  const normalized = repoPath.replace(/\\/g, '/');
  return {
    allowNetwork: false,
    allowFileWrite: true,
    allowShell: false,
    allowedPaths: [normalized],
    blockedCommands: ['rm -rf /', 'format', 'shutdown', 'reboot', 'mkfs', 'dd if='],
    maxExecutionMs: 30_000,
    maxMemoryMb: 512,
  };
}

export function mergeSandboxPolicies(
  base: SandboxPolicy,
  override: Partial<SandboxPolicy>
): SandboxPolicy {
  return {
    ...base,
    ...override,
    allowedPaths: override.allowedPaths ?? base.allowedPaths,
    blockedCommands: override.blockedCommands ?? base.blockedCommands,
  };
}

export function formatSandboxReport(result: SandboxResult): string {
  const lines: string[] = [
    `# Sandbox Check Report`,
    '',
    `- **Allowed**: ${result.allowed ? 'YES' : 'NO'}`,
    `- **Policies checked**: ${result.checkedPolicies}`,
    `- **Violations**: ${result.violations.length}`,
  ];

  if (result.violations.length > 0) {
    lines.push('', '## Violations', '');
    for (const v of result.violations) {
      lines.push(`- **${v.policy}**: ${v.detail} (action: ${v.action})`);
    }
  }

  return lines.join('\n');
}
