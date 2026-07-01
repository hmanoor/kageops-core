export type TerseSeverity = 'bug' | 'sec' | 'perf' | 'style' | 'nit' | 'info';

export interface TerseFinding {
  readonly file: string;
  readonly line: number | null;
  readonly severity: TerseSeverity;
  readonly message: string;
  readonly fix: string;
}

export interface TerseReviewOutput {
  readonly findings: readonly TerseFinding[];
  readonly summary: string;
  readonly passedGate: boolean;
}

export const SEVERITY_EMOJI: Record<TerseSeverity, string> = {
  bug: '🔴',
  sec: '🟠',
  perf: '🟡',
  style: '🔵',
  nit: '⚪',
  info: '💡',
};

export const SEVERITY_PRIORITY: Record<TerseSeverity, number> = {
  bug: 0,
  sec: 1,
  perf: 2,
  style: 3,
  nit: 4,
  info: 5,
};

const TERSE_SEVERITIES: readonly TerseSeverity[] = ['bug', 'sec', 'perf', 'style', 'nit', 'info'];

function isTerseSeverity(value: string): value is TerseSeverity {
  return (TERSE_SEVERITIES as readonly string[]).includes(value);
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen);
}

export function buildTerseReviewPrompt(taskTitle: string, codeContext: string): string {
  return `You are performing a code review for: ${taskTitle}

Code to review:
${codeContext}

Output findings in this exact format, one per line:
FILE: path/to/file.ts
L<line>: <severity>: <message>. <fix>.

Severity must be one of: bug, sec, perf, style, nit, info
Keep messages under 80 characters.
End with: GATE: PASSED or GATE: REJECTED`;
}

const FINDING_RE = /^L(\d+): (bug|sec|perf|style|nit|info): (.+?)\. (.+)\.?$/;
const FILE_RE = /^FILE: (.+)$/;

export function parseTerseFindings(aiOutput: string): readonly TerseFinding[] {
  const lines = aiOutput.split('\n');
  const findings: TerseFinding[] = [];
  let currentFile = 'unknown';

  for (const raw of lines) {
    const line = raw.trim();

    const fileMatch = FILE_RE.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1].trim();
      continue;
    }

    const findingMatch = FINDING_RE.exec(line);
    if (findingMatch) {
      const lineNum = parseInt(findingMatch[1], 10);
      const severityRaw = findingMatch[2];
      const message = findingMatch[3].trim();
      const fix = findingMatch[4].trim();

      if (!isTerseSeverity(severityRaw)) continue;

      findings.push({
        file: currentFile,
        line: lineNum,
        severity: severityRaw,
        message,
        fix: fix.replace(/\.$/, ''),
      });
    }
  }

  return findings;
}

export function parseTerseGate(aiOutput: string): boolean {
  if (/GATE:\s*PASSED/i.test(aiOutput)) return true;
  if (/GATE:\s*REJECTED/i.test(aiOutput)) return false;
  return false;
}

export function formatTerseOutput(
  findings: readonly TerseFinding[],
  passedGate: boolean,
): string {
  const byFile = new Map<string, TerseFinding[]>();

  for (const finding of findings) {
    const existing = byFile.get(finding.file) ?? [];
    byFile.set(finding.file, [...existing, finding]);
  }

  const sections: string[] = [];

  for (const [file, filefindings] of byFile) {
    const sorted = [...filefindings].sort(
      (a, b) => SEVERITY_PRIORITY[a.severity] - SEVERITY_PRIORITY[b.severity],
    );

    const lines = sorted.map((f) => {
      const loc = f.line !== null ? `L${f.line}: ` : '';
      return `${SEVERITY_EMOJI[f.severity]} ${loc}${f.severity}: ${f.message}. ${f.fix}.`;
    });

    sections.push(`## ${file}\n${lines.join('\n')}`);
  }

  const gateStr = passedGate ? 'GATE: PASSED ✅' : 'GATE: REJECTED ❌';
  return [...sections, '---', gateStr].join('\n\n');
}

export function buildTerseReviewResult(aiOutput: string): TerseReviewOutput {
  const findings = parseTerseFindings(aiOutput);
  const passedGate = parseTerseGate(aiOutput);

  const bugCount = findings.filter((f) => f.severity === 'bug').length;
  const secCount = findings.filter((f) => f.severity === 'sec').length;
  const total = findings.length;

  const summary =
    total === 0
      ? 'No findings.'
      : `${total} finding${total !== 1 ? 's' : ''}: ${bugCount} bug${bugCount !== 1 ? 's' : ''}, ${secCount} security issue${secCount !== 1 ? 's' : ''}.`;

  return { findings, summary, passedGate };
}

type VerboseSeverity = string;

export function convertToTerse(finding: {
  file: string;
  line: number | null;
  severity: VerboseSeverity;
  message: string;
  suggestion: string;
}): TerseFinding {
  const severityMap: Record<string, TerseSeverity> = {
    critical: 'bug',
    high: 'sec',
    medium: 'perf',
    low: 'style',
  };

  const severity: TerseSeverity = severityMap[finding.severity.toLowerCase()] ?? 'nit';

  return {
    file: finding.file,
    line: finding.line,
    severity,
    message: truncate(finding.message, 80),
    fix: truncate(finding.suggestion, 80),
  };
}
