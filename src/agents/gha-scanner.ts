/**
 * GitHub Actions injection scanner for KageOps (B-217)
 * Detects command injection vectors in CI workflow files.
 */

export type GhaRiskLevel = 'critical' | 'high' | 'medium' | 'info';

export interface GhaFinding {
  readonly line: number;
  readonly riskLevel: GhaRiskLevel;
  readonly pattern: string;
  readonly context: string;
  readonly remediation: string;
}

export interface GhaScanResult {
  readonly filePath?: string;
  readonly findings: readonly GhaFinding[];
  readonly safe: boolean;
  readonly summary: string;
}

interface GhaPatternDef {
  readonly pattern: RegExp;
  readonly riskLevel: GhaRiskLevel;
  readonly name: string;
  readonly remediation: string;
  readonly multiline?: boolean;
}

export const GHA_PATTERNS: readonly GhaPatternDef[] = [
  {
    pattern: /run:.*\$\{\{\s*github\.event\.(issue|pull_request|comment)\.(title|body|label)/,
    riskLevel: 'critical',
    name: 'expression-injection-run',
    remediation: 'Use an environment variable instead: env: TITLE: ${{ github.event.issue.title }}',
  },
  {
    pattern: /run:.*\$\{\{\s*github\.event\.inputs\./,
    riskLevel: 'high',
    name: 'workflow-dispatch-injection',
    remediation: 'Validate inputs before use or use environment variables',
  },
  {
    pattern: /run:.*\$\{\{\s*github\.head_ref/,
    riskLevel: 'high',
    name: 'head-ref-injection',
    remediation: 'Use github.event.pull_request.head.sha instead',
  },
  {
    pattern: /pull_request_target[\s\S]*?actions\/checkout[\s\S]*?ref:.*\$\{\{\s*github\.event\.pull_request\.head/,
    riskLevel: 'critical',
    name: 'pr-target-checkout',
    remediation: 'Never checkout PR code in pull_request_target — use pull_request trigger instead',
    multiline: true,
  },
  {
    pattern: /permissions:\s*write-all/,
    riskLevel: 'medium',
    name: 'write-all-permissions',
    remediation: 'Use least-privilege permissions per job',
  },
  {
    pattern: /uses:\s+[^@\n]+@[^v\d]/,
    riskLevel: 'medium',
    name: 'unpinned-action',
    remediation: 'Pin actions to a specific SHA or version tag',
  },
  {
    pattern: /env:[\s\S]*?\$\{\{\s*secrets\./,
    riskLevel: 'info',
    name: 'secret-in-env',
    remediation: 'Ensure secrets are not logged — add masking if needed',
  },
  {
    pattern: /run:.*curl.*\|.*sh/,
    riskLevel: 'high',
    name: 'curl-pipe-shell',
    remediation: 'Download script first, verify checksum, then execute',
  },
];

function buildSummary(findings: readonly GhaFinding[], filePath?: string): string {
  if (findings.length === 0) {
    return filePath ? `${filePath}: No vulnerabilities found.` : 'No vulnerabilities found.';
  }
  const counts: Record<GhaRiskLevel, number> = { critical: 0, high: 0, medium: 0, info: 0 };
  for (const f of findings) {
    counts[f.riskLevel]++;
  }
  const parts = (['critical', 'high', 'medium', 'info'] as GhaRiskLevel[])
    .filter((l) => counts[l] > 0)
    .map((l) => `${counts[l]} ${l}`);
  const label = filePath ? `${filePath}: ` : '';
  return `${label}${findings.length} finding(s): ${parts.join(', ')}`;
}

/**
 * Scans a YAML workflow file content against all patterns.
 */
export function scanWorkflowContent(content: string, filePath?: string): GhaScanResult {
  const lines = content.split('\n');
  const findings: GhaFinding[] = [];

  for (const def of GHA_PATTERNS) {
    if (def.multiline) {
      // Test the full content for multiline patterns; report on the triggering line
      if (def.pattern.test(content)) {
        // Find the line that contains 'pull_request_target' as the anchor
        const triggerLine = lines.findIndex((l) => /pull_request_target/.test(l));
        findings.push({
          line: triggerLine >= 0 ? triggerLine + 1 : 1,
          riskLevel: def.riskLevel,
          pattern: def.name,
          context: triggerLine >= 0 ? lines[triggerLine].trim() : content.slice(0, 80),
          remediation: def.remediation,
        });
      }
    } else {
      lines.forEach((line, idx) => {
        if (def.pattern.test(line)) {
          findings.push({
            line: idx + 1,
            riskLevel: def.riskLevel,
            pattern: def.name,
            context: line.trim(),
            remediation: def.remediation,
          });
        }
      });
    }
  }

  const safe = !findings.some((f) => f.riskLevel === 'critical' || f.riskLevel === 'high');

  return {
    filePath,
    findings,
    safe,
    summary: buildSummary(findings, filePath),
  };
}

/**
 * Reads a file and scans it. Returns empty safe result on read failure.
 */
export function scanWorkflowFile(
  repoPath: string,
  filePath: string,
  readFileFn: (repo: string, file: string) => string,
): GhaScanResult {
  try {
    const content = readFileFn(repoPath, filePath);
    return scanWorkflowContent(content, filePath);
  } catch {
    return {
      filePath,
      findings: [],
      safe: true,
      summary: `${filePath}: Could not read file.`,
    };
  }
}

/**
 * Scans all .yml/.yaml files in .github/workflows/.
 */
export function scanAllWorkflows(
  repoPath: string,
  listFilesFn: (repo: string, pattern: string) => string[],
  readFileFn: (repo: string, file: string) => string,
): readonly GhaScanResult[] {
  const ymlFiles = listFilesFn(repoPath, '.github/workflows/*.yml');
  const yamlFiles = listFilesFn(repoPath, '.github/workflows/*.yaml');
  const allFiles = [...new Set([...ymlFiles, ...yamlFiles])];
  return allFiles.map((file) => scanWorkflowFile(repoPath, file, readFileFn));
}

const RISK_ORDER: readonly GhaRiskLevel[] = ['critical', 'high', 'medium', 'info'];

/**
 * Formats a Markdown report grouped by risk level with remediation guidance.
 */
export function formatGhaScanReport(results: readonly GhaScanResult[]): string {
  const allFindings = results.flatMap((r) =>
    r.findings.map((f) => ({ ...f, filePath: r.filePath ?? 'unknown' })),
  );

  if (allFindings.length === 0) {
    return '## GitHub Actions Security Scan\n\nNo vulnerabilities found.\n';
  }

  const lines: string[] = ['## GitHub Actions Security Scan\n'];

  for (const level of RISK_ORDER) {
    const group = allFindings.filter((f) => f.riskLevel === level);
    if (group.length === 0) continue;

    lines.push(`### ${level.toUpperCase()} (${group.length})\n`);
    for (const f of group) {
      lines.push(`**[${f.filePath}:${f.line}]** \`${f.pattern}\``);
      lines.push(`\`\`\`\n${f.context}\n\`\`\``);
      lines.push(`> **Remediation:** ${f.remediation}\n`);
    }
  }

  const safeCount = results.filter((r) => r.safe).length;
  lines.push(`---\n${safeCount}/${results.length} workflow(s) are safe.`);

  return lines.join('\n');
}
