/**
 * B-160: Prompt Playground (Isolated Testing)
 * B-161: Prompt Versioning (Commit-Hashed)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PromptTemplate {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly variables: readonly string[];
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly systemPrompt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PromptVersion {
  readonly versionId: string;
  readonly promptId: string;
  readonly content: string;
  readonly hash: string;
  readonly parentHash: string | null;
  readonly author: string;
  readonly message: string;
  readonly createdAt: string;
}

export interface PlaygroundRun {
  readonly runId: string;
  readonly promptId: string;
  readonly versionId: string | null;
  readonly model: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly output: string;
  readonly tokenCount: number;
  readonly cost: number;
  readonly durationMs: number;
  readonly timestamp: string;
}

export interface PlaygroundComparison {
  readonly runs: readonly PlaygroundRun[];
  readonly bestRunId: string | null;
  readonly worstRunId: string | null;
  readonly avgCost: number;
  readonly avgDuration: number;
  readonly avgTokens: number;
}

export interface DiffHunk {
  readonly startLine: number;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
}

export interface PromptDiff {
  readonly oldContent: string;
  readonly newContent: string;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let idCounter = 0;

function generateId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

function nowISO(): string {
  return new Date().toISOString();
}

// ─── Functions ───────────────────────────────────────────────────────────────

export function extractVariables(content: string): readonly string[] {
  const regex = /\{\{(\w+)\}\}/g;
  const seen = new Set<string>();
  let match: RegExpExecArray | null = regex.exec(content);
  while (match !== null) {
    seen.add(match[1]);
    match = regex.exec(content);
  }
  return Array.from(seen);
}

export function createPromptTemplate(
  name: string,
  content: string,
  overrides?: Partial<Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'>>
): PromptTemplate {
  const now = nowISO();
  return {
    id: generateId('prompt'),
    name,
    content,
    variables: extractVariables(content),
    model: 'claude-sonnet-4-20250514',
    temperature: 0.7,
    maxTokens: 1024,
    systemPrompt: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function renderPrompt(
  template: PromptTemplate,
  variables: Readonly<Record<string, string>>
): string {
  const required = extractVariables(template.content);
  const missing = required.filter((v) => !(v in variables));
  if (missing.length > 0) {
    throw new Error(`Missing variables: ${missing.join(', ')}`);
  }
  return template.content.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    return variables[key] ?? '';
  });
}

export function hashPromptContent(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function createVersion(
  prompt: PromptTemplate,
  author: string,
  message: string,
  parentHash: string | null
): PromptVersion {
  return {
    versionId: generateId('ver'),
    promptId: prompt.id,
    content: prompt.content,
    hash: hashPromptContent(prompt.content),
    parentHash,
    author,
    message,
    createdAt: nowISO(),
  };
}

export function diffPrompts(oldContent: string, newContent: string): PromptDiff {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  const maxLen = Math.max(oldLines.length, newLines.length);

  let i = 0;
  while (i < maxLen) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine !== newLine) {
      const hunkStart = i + 1;
      const hunkOld: string[] = [];
      const hunkNew: string[] = [];
      while (i < maxLen) {
        const ol = i < oldLines.length ? oldLines[i] : undefined;
        const nl = i < newLines.length ? newLines[i] : undefined;
        if (ol === nl) break;
        if (ol !== undefined) { hunkOld.push(ol); deletions += 1; }
        if (nl !== undefined) { hunkNew.push(nl); additions += 1; }
        i += 1;
      }
      hunks.push({ startLine: hunkStart, oldLines: hunkOld, newLines: hunkNew });
    } else {
      i += 1;
    }
  }

  return { oldContent, newContent, additions, deletions, hunks };
}

export function runPlayground(
  template: PromptTemplate,
  variables: Readonly<Record<string, string>>,
  model: string,
  simulatedOutput: string,
  tokenCount: number,
  cost: number,
  durationMs: number
): PlaygroundRun {
  return {
    runId: generateId('run'),
    promptId: template.id,
    versionId: null,
    model,
    variables,
    output: simulatedOutput,
    tokenCount,
    cost,
    durationMs,
    timestamp: nowISO(),
  };
}

export function compareRuns(runs: readonly PlaygroundRun[]): PlaygroundComparison {
  if (runs.length === 0) {
    return { runs, bestRunId: null, worstRunId: null, avgCost: 0, avgDuration: 0, avgTokens: 0 };
  }
  const totalCost = runs.reduce((s, r) => s + r.cost, 0);
  const totalDur = runs.reduce((s, r) => s + r.durationMs, 0);
  const totalTok = runs.reduce((s, r) => s + r.tokenCount, 0);
  const best = runs.reduce((a, b) => (b.cost < a.cost ? b : a));
  const worst = runs.reduce((a, b) => (b.cost > a.cost ? b : a));
  return {
    runs,
    bestRunId: best.runId,
    worstRunId: worst.runId,
    avgCost: totalCost / runs.length,
    avgDuration: totalDur / runs.length,
    avgTokens: totalTok / runs.length,
  };
}

export function formatRunReport(run: PlaygroundRun): string {
  return [
    `## Run: ${run.runId}`,
    '',
    `| Field | Value |`,
    `|-------|-------|`,
    `| Model | ${run.model} |`,
    `| Tokens | ${run.tokenCount} |`,
    `| Cost | $${run.cost.toFixed(4)} |`,
    `| Duration | ${run.durationMs}ms |`,
    `| Timestamp | ${run.timestamp} |`,
    '',
    '### Output',
    '',
    run.output,
  ].join('\n');
}

export function formatComparisonReport(comparison: PlaygroundComparison): string {
  const header = [
    `## Comparison Report`,
    '',
    `| Run | Model | Tokens | Cost | Duration |`,
    `|-----|-------|--------|------|----------|`,
  ];
  const rows = comparison.runs.map((r) =>
    `| ${r.runId} | ${r.model} | ${r.tokenCount} | $${r.cost.toFixed(4)} | ${r.durationMs}ms |`
  );
  const summary = [
    '',
    `**Best run:** ${comparison.bestRunId ?? 'N/A'}`,
    `**Worst run:** ${comparison.worstRunId ?? 'N/A'}`,
    `**Avg cost:** $${comparison.avgCost.toFixed(4)}`,
    `**Avg duration:** ${comparison.avgDuration.toFixed(0)}ms`,
    `**Avg tokens:** ${comparison.avgTokens.toFixed(0)}`,
  ];
  return [...header, ...rows, ...summary].join('\n');
}

export function formatVersionHistory(versions: readonly PromptVersion[]): string {
  const header = [
    `## Version History`,
    '',
    `| Hash | Author | Message | Date |`,
    `|------|--------|---------|------|`,
  ];
  const rows = versions.map((v) =>
    `| ${v.hash} | ${v.author} | ${v.message} | ${v.createdAt} |`
  );
  return [...header, ...rows].join('\n');
}

export function getVersionChain(
  versions: readonly PromptVersion[],
  headHash: string
): readonly PromptVersion[] {
  const byHash = new Map(versions.map((v) => [v.hash, v]));
  const chain: PromptVersion[] = [];
  let current: string | null = headHash;
  while (current !== null) {
    const ver = byHash.get(current);
    if (!ver) break;
    chain.push(ver);
    current = ver.parentHash;
  }
  return chain;
}
