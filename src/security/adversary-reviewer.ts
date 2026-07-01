// B-140: Adversary Reviewer & B-141: Prompt Injection Detection

// ── Types ──────────────────────────────────────────────────────────

export type ThreatCategory =
  | 'prompt-injection'
  | 'data-exfiltration'
  | 'privilege-escalation'
  | 'resource-abuse'
  | 'unauthorized-access'
  | 'unsafe-output';

export interface ThreatDetail {
  readonly category: ThreatCategory;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly description: string;
  readonly evidence: string;
  readonly suggestedAction: string;
}

export interface AdversaryVerdict {
  readonly safe: boolean;
  readonly confidence: number;
  readonly threats: readonly ThreatDetail[];
  readonly reviewedAt: string;
}

export interface InjectionPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly category: ThreatCategory;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface AdversaryConfig {
  readonly enabled: boolean;
  readonly blockOnCritical: boolean;
  readonly logAllActions: boolean;
  readonly maxReviewTimeMs: number;
  readonly injectionPatterns: readonly InjectionPattern[];
}

export interface ReviewRequest {
  readonly agentId: string;
  readonly action: string;
  readonly content: string;
  readonly context: Readonly<Record<string, string>>;
}

export interface SanitizationResult {
  readonly original: string;
  readonly sanitized: string;
  readonly removedPatterns: readonly string[];
  readonly wasModified: boolean;
}

// ── Built-in Patterns ──────────────────────────────────────────────

export const INJECTION_PATTERNS: readonly InjectionPattern[] = [
  { name: 'ignore-previous', pattern: /ignore\s+(all\s+)?previous\s+instructions/i, category: 'prompt-injection', severity: 'critical' },
  { name: 'system-prompt-override', pattern: /system\s*prompt\s*[:=]/i, category: 'prompt-injection', severity: 'critical' },
  { name: 'you-are-now', pattern: /you\s+are\s+now\s+(a|an|the)\s+/i, category: 'prompt-injection', severity: 'high' },
  { name: 'roleplay-attack', pattern: /act\s+as\s+(a|an|the)?\s*(root|admin|system)/i, category: 'privilege-escalation', severity: 'critical' },
  { name: 'markdown-injection', pattern: /\[.*?\]\(javascript:/i, category: 'unsafe-output', severity: 'high' },
  { name: 'html-script-tag', pattern: /<script[\s>]/i, category: 'unsafe-output', severity: 'critical' },
  { name: 'html-event-handler', pattern: /on(load|error|click|mouseover)\s*=/i, category: 'unsafe-output', severity: 'high' },
  { name: 'base64-payload', pattern: /eval\s*\(\s*atob\s*\(/i, category: 'unsafe-output', severity: 'critical' },
  { name: 'data-uri', pattern: /data:\s*text\/html/i, category: 'unsafe-output', severity: 'high' },
  { name: 'eval-exec', pattern: /\b(eval|exec|Function)\s*\(/i, category: 'unsafe-output', severity: 'high' },
  { name: 'env-extraction', pattern: /process\.env\b/i, category: 'data-exfiltration', severity: 'high' },
  { name: 'secret-extraction', pattern: /(api[_-]?key|secret|token|password)\s*[:=]/i, category: 'data-exfiltration', severity: 'high' },
  { name: 'fetch-exfil', pattern: /fetch\s*\(\s*['"]https?:\/\/(?!localhost)/i, category: 'data-exfiltration', severity: 'medium' },
  { name: 'new-instructions', pattern: /new\s+instructions?\s*:/i, category: 'prompt-injection', severity: 'high' },
  { name: 'disregard', pattern: /disregard\s+(all\s+)?(previous|prior|above)/i, category: 'prompt-injection', severity: 'critical' },
] as const;

// ── Unicode attack characters ──────────────────────────────────────

const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;
const RTL_OVERRIDE_RE = /[\u202A-\u202E\u2066-\u2069]/g;
const INVISIBLE_SEPARATOR_RE = /[\u2060-\u2064\u2028\u2029]/g;
const HOMOGLYPH_MAP: Readonly<Record<string, string>> = {
  '\u0410': 'A', '\u0412': 'B', '\u0421': 'C', '\u0415': 'E',
  '\u041D': 'H', '\u041A': 'K', '\u041C': 'M', '\u041E': 'O',
  '\u0420': 'P', '\u0422': 'T', '\u0425': 'X',
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p',
  '\u0441': 'c', '\u0443': 'y', '\u0445': 'x',
};

// ── Functions ──────────────────────────────────────────────────────

export function detectPromptInjection(
  text: string,
  patterns: readonly InjectionPattern[],
): readonly ThreatDetail[] {
  const threats: ThreatDetail[] = [];
  for (const p of patterns) {
    const match = p.pattern.exec(text);
    if (match) {
      threats.push({
        category: p.category,
        severity: p.severity,
        description: `Detected pattern: ${p.name}`,
        evidence: match[0],
        suggestedAction: p.severity === 'critical' ? 'Block action immediately' : 'Review before proceeding',
      });
    }
  }
  return threats;
}

export function stripUnicodeAttacks(text: string): SanitizationResult {
  const removed: string[] = [];
  let result = text;

  if (ZERO_WIDTH_RE.test(result)) {
    removed.push('zero-width characters');
    result = result.replace(ZERO_WIDTH_RE, '');
  }
  if (RTL_OVERRIDE_RE.test(result)) {
    removed.push('RTL override characters');
    result = result.replace(RTL_OVERRIDE_RE, '');
  }
  if (INVISIBLE_SEPARATOR_RE.test(result)) {
    removed.push('invisible separators');
    result = result.replace(INVISIBLE_SEPARATOR_RE, '');
  }

  let homoglyphFound = false;
  result = result.replace(/./g, (ch) => {
    const replacement = HOMOGLYPH_MAP[ch];
    if (replacement) { homoglyphFound = true; return replacement; }
    return ch;
  });
  if (homoglyphFound) removed.push('homoglyph characters');

  return { original: text, sanitized: result, removedPatterns: removed, wasModified: result !== text };
}

export function detectHiddenInstructions(text: string): readonly ThreatDetail[] {
  const threats: ThreatDetail[] = [];

  // Base64-encoded instructions
  const b64Re = /[A-Za-z0-9+/]{20,}={0,2}/g;
  let b64Match: RegExpExecArray | null;
  while ((b64Match = b64Re.exec(text)) !== null) {
    try {
      const decoded = atob(b64Match[0]);
      if (/instruction|execute|ignore|override|system/i.test(decoded)) {
        threats.push({
          category: 'prompt-injection', severity: 'critical',
          description: 'Base64-encoded instruction detected',
          evidence: b64Match[0].slice(0, 40),
          suggestedAction: 'Block action and review encoded content',
        });
      }
    } catch { /* not valid base64, skip */ }
  }

  // HTML comments with instructions
  const commentRe = /<!--[\s\S]*?-->/g;
  let commentMatch: RegExpExecArray | null;
  while ((commentMatch = commentRe.exec(text)) !== null) {
    if (/instruct|execute|ignore|override|system|prompt/i.test(commentMatch[0])) {
      threats.push({
        category: 'prompt-injection', severity: 'high',
        description: 'HTML comment with suspicious instructions',
        evidence: commentMatch[0].slice(0, 60),
        suggestedAction: 'Strip HTML comments before processing',
      });
    }
  }

  // Hidden markdown links
  const mdLinkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  let mdMatch: RegExpExecArray | null;
  while ((mdMatch = mdLinkRe.exec(text)) !== null) {
    if (/javascript:|data:/i.test(mdMatch[2])) {
      threats.push({
        category: 'unsafe-output', severity: 'high',
        description: 'Markdown link with dangerous scheme',
        evidence: mdMatch[0].slice(0, 60),
        suggestedAction: 'Remove or neutralize dangerous link',
      });
    }
  }

  return threats;
}

export function sanitizeAgentOutput(output: string): SanitizationResult {
  const removed: string[] = [];
  let result = output;

  // Strip script tags
  if (/<script[\s\S]*?<\/script>/i.test(result)) {
    removed.push('script tags');
    result = result.replace(/<script[\s\S]*?<\/script>/gi, '');
  }

  // Strip event handlers
  if (/\bon\w+\s*=/i.test(result)) {
    removed.push('event handlers');
    result = result.replace(/\bon\w+\s*=\s*(['"])[\s\S]*?\1/gi, '');
  }

  // Strip javascript: URIs
  if (/javascript:/i.test(result)) {
    removed.push('javascript URIs');
    result = result.replace(/javascript:[^\s"')]+/gi, '#blocked');
  }

  // Strip data: text/html URIs
  if (/data:\s*text\/html/i.test(result)) {
    removed.push('data URIs');
    result = result.replace(/data:\s*text\/html[^\s"')]+/gi, '#blocked');
  }

  const unicodeResult = stripUnicodeAttacks(result);
  if (unicodeResult.wasModified) {
    removed.push(...unicodeResult.removedPatterns);
    result = unicodeResult.sanitized;
  }

  return { original: output, sanitized: result, removedPatterns: removed, wasModified: result !== output };
}

export function assessThreatSeverity(
  threats: readonly ThreatDetail[],
): 'critical' | 'high' | 'medium' | 'low' | 'none' {
  if (threats.length === 0) return 'none';
  const order: readonly string[] = ['critical', 'high', 'medium', 'low'];
  for (const level of order) {
    if (threats.some((t) => t.severity === level)) return level as 'critical' | 'high' | 'medium' | 'low';
  }
  return 'none';
}

export function shouldBlockAction(verdict: AdversaryVerdict, config: AdversaryConfig): boolean {
  if (!config.blockOnCritical) return false;
  return verdict.threats.some((t) => t.severity === 'critical');
}

export function reviewAgentAction(request: ReviewRequest, config: AdversaryConfig): AdversaryVerdict {
  if (!config.enabled) {
    return { safe: true, confidence: 1, threats: [], reviewedAt: new Date().toISOString() };
  }

  const textToScan = `${request.action} ${request.content}`;
  const injectionThreats = detectPromptInjection(textToScan, config.injectionPatterns);
  const hiddenThreats = detectHiddenInstructions(request.content);
  const allThreats: readonly ThreatDetail[] = [...injectionThreats, ...hiddenThreats];

  const severity = assessThreatSeverity(allThreats);
  const safe = severity === 'none' || severity === 'low';
  const confidence = allThreats.length === 0 ? 0.95 : Math.max(0.3, 0.9 - allThreats.length * 0.1);

  return { safe, confidence, threats: allThreats, reviewedAt: new Date().toISOString() };
}

export function formatThreatReport(verdict: AdversaryVerdict): string {
  const lines: string[] = [
    `# Adversary Review Report`,
    ``,
    `**Status:** ${verdict.safe ? 'SAFE' : 'THREATS DETECTED'}`,
    `**Confidence:** ${(verdict.confidence * 100).toFixed(0)}%`,
    `**Reviewed at:** ${verdict.reviewedAt}`,
    ``,
  ];

  if (verdict.threats.length === 0) {
    lines.push('No threats detected.');
  } else {
    lines.push(`## Threats (${verdict.threats.length})`);
    lines.push('');
    for (const t of verdict.threats) {
      lines.push(`### [${t.severity.toUpperCase()}] ${t.category}`);
      lines.push(`- **Description:** ${t.description}`);
      lines.push(`- **Evidence:** \`${t.evidence}\``);
      lines.push(`- **Action:** ${t.suggestedAction}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function createDefaultConfig(): AdversaryConfig {
  return {
    enabled: true,
    blockOnCritical: true,
    logAllActions: true,
    maxReviewTimeMs: 5000,
    injectionPatterns: INJECTION_PATTERNS,
  };
}

export function mergeConfigs(base: AdversaryConfig, overrides: Partial<AdversaryConfig>): AdversaryConfig {
  return {
    enabled: overrides.enabled ?? base.enabled,
    blockOnCritical: overrides.blockOnCritical ?? base.blockOnCritical,
    logAllActions: overrides.logAllActions ?? base.logAllActions,
    maxReviewTimeMs: overrides.maxReviewTimeMs ?? base.maxReviewTimeMs,
    injectionPatterns: overrides.injectionPatterns ?? base.injectionPatterns,
  };
}

export function visualizeAction(action: string, content: string): string {
  const preview = content.length > 200 ? `${content.slice(0, 200)}...` : content;
  return `[Action: ${action}]\n---\n${preview}\n---`;
}
