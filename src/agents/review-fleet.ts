/**
 * Review Fleet — Parallel Specialized Sub-Reviewer System (B-203)
 *
 * Provides a fleet of specialized review roles that each hunt for
 * different categories of issues. Findings are deduplicated, ranked,
 * and aggregated into a single FleetReviewResult.
 */

// ── Types ────────────────────────────────────────────

export type ReviewerRole = 'logic-bugs' | 'security' | 'edge-cases' | 'regression' | 'performance';

export interface FleetFinding {
    readonly id: string;           // deterministic hash of file+line+message
    readonly role: ReviewerRole;
    readonly file: string;
    readonly line: number | null;
    readonly severity: 'critical' | 'high' | 'medium' | 'low';
    readonly message: string;
    readonly suggestion: string;
}

export interface FleetReviewResult {
    readonly findings: readonly FleetFinding[];
    readonly totalByRole: Readonly<Record<ReviewerRole, number>>;
    readonly totalBySeverity: Readonly<Record<string, number>>;
    readonly deduplicatedCount: number;
    readonly originalCount: number;
}

// ── Constants ────────────────────────────────────────

export const DEFAULT_FLEET_ROLES: readonly ReviewerRole[] = [
    'logic-bugs',
    'security',
    'edge-cases',
    'regression',
    'performance',
];

const SEVERITY_ORDER: Readonly<Record<string, number>> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
};

// ── Role Descriptions ─────────────────────────────────

const ROLE_FOCUS: Readonly<Record<ReviewerRole, string>> = {
    'logic-bugs': [
        'You are a logic bug hunter. Focus ONLY on:',
        '- Off-by-one errors (loop bounds, slice indices, comparisons)',
        '- Null/undefined dereferences',
        '- Race conditions and concurrency hazards',
        '- Wrong comparisons (== vs ===, < vs <=, wrong variable used)',
        '- Incorrect boolean logic (flipped conditions, missing negation)',
        '- Dead code paths or unreachable branches',
    ].join('\n'),

    security: [
        'You are a security expert. Focus ONLY on:',
        '- Injection vulnerabilities (SQL, command, LDAP, template)',
        '- Cross-site scripting (XSS) — unsanitized HTML output',
        '- Hardcoded secrets (API keys, passwords, tokens in source)',
        '- Authentication/authorization bypass vulnerabilities',
        '- Path traversal attacks (../.. patterns, unvalidated file paths)',
        '- Sensitive data exposure (PII in logs, error messages, responses)',
        '- Missing input validation on security-sensitive boundaries',
    ].join('\n'),

    'edge-cases': [
        'You are an edge case specialist. Focus ONLY on:',
        '- Empty inputs (empty string, empty array, empty object)',
        '- Boundary values (0, -1, MAX_INT, first/last element)',
        '- Unicode and special characters (emoji, RTL text, null bytes)',
        '- Large payloads (very long strings, huge arrays, deeply nested objects)',
        '- Missing null/undefined checks before property access',
        '- Type coercion surprises (NaN, Infinity, falsy values)',
    ].join('\n'),

    regression: [
        'You are a regression detector. Focus ONLY on:',
        '- Breaking changes to public APIs (renamed/removed exports)',
        '- Removed features that callers may depend on',
        '- Changed function signatures (different parameter order, removed params)',
        '- API contract violations (different return type, changed error behavior)',
        '- Database schema incompatibilities (dropped columns, changed types)',
        '- Event channel renames or payload structure changes',
    ].join('\n'),

    performance: [
        'You are a performance analyst. Focus ONLY on:',
        '- O(n²) or worse algorithms (nested loops over same dataset)',
        '- Memory leaks (event listeners not removed, growing caches)',
        '- Unnecessary allocations in hot paths (object creation in loops)',
        '- Blocking I/O in async contexts (sync file reads, sync DB queries)',
        '- N+1 query patterns (DB query inside a loop)',
        '- Missing pagination on potentially large result sets',
    ].join('\n'),
};

// ── Public Functions ──────────────────────────────────

/**
 * Build a focused prompt for a specific sub-reviewer role.
 */
export function buildFleetPrompt(role: ReviewerRole, taskTitle: string, code: string): string {
    return [
        `FLEET REVIEW: ${role.toUpperCase()} SPECIALIST`,
        '',
        ROLE_FOCUS[role],
        '',
        `Task under review: ${taskTitle}`,
        '',
        'For EACH finding output EXACTLY this block (one block per finding):',
        '--- FINDING ---',
        'FILE: path/to/file.ts',
        'LINE: <line number or UNKNOWN>',
        'SEVERITY: critical | high | medium | low',
        'MESSAGE: <clear description of the issue>',
        'SUGGESTION: <how to fix it>',
        '--- END FINDING ---',
        '',
        'If you find no issues in your area, output: NO FINDINGS',
        '',
        '## Code to Review',
        '',
        code,
    ].join('\n');
}

/**
 * Parse structured finding blocks from a sub-reviewer AI response.
 * Falls back to loose parsing when structured blocks are absent.
 */
export function parseFleetFindings(
    aiOutput: string,
    role: ReviewerRole
): readonly FleetFinding[] {
    const structured = parseStructuredBlocks(aiOutput, role);
    if (structured.length > 0) return structured;

    // Fallback: check for "NO FINDINGS" explicit signal
    if (/no findings/i.test(aiOutput)) return [];

    // Fallback: loose parsing — look for severity keywords with context
    return parseLooseFindings(aiOutput, role);
}

/**
 * Remove duplicate findings (same deterministic id).
 * When duplicates exist, keep the one with highest severity.
 */
export function deduplicateFindings(
    allFindings: readonly FleetFinding[]
): readonly FleetFinding[] {
    const byId = new Map<string, FleetFinding>();

    for (const finding of allFindings) {
        const existing = byId.get(finding.id);
        if (existing === undefined) {
            byId.set(finding.id, finding);
        } else {
            // Keep the higher severity one
            const existingSev = SEVERITY_ORDER[existing.severity] ?? 99;
            const newSev = SEVERITY_ORDER[finding.severity] ?? 99;
            if (newSev < existingSev) {
                byId.set(finding.id, finding);
            }
        }
    }

    return Array.from(byId.values());
}

/**
 * Sort findings by severity (critical first), then file, then line.
 */
export function rankFindings(findings: readonly FleetFinding[]): readonly FleetFinding[] {
    return [...findings].sort((a, b) => {
        const sevDiff = (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
        if (sevDiff !== 0) return sevDiff;

        const fileDiff = a.file.localeCompare(b.file);
        if (fileDiff !== 0) return fileDiff;

        const aLine = a.line ?? Infinity;
        const bLine = b.line ?? Infinity;
        return aLine - bLine;
    });
}

/**
 * Aggregate findings into a FleetReviewResult with counts by role and severity.
 */
export function buildFleetResult(
    findings: readonly FleetFinding[],
    originalCount: number
): FleetReviewResult {
    const totalByRole: Record<ReviewerRole, number> = {
        'logic-bugs': 0,
        security: 0,
        'edge-cases': 0,
        regression: 0,
        performance: 0,
    };

    const totalBySeverity: Record<string, number> = {};

    for (const finding of findings) {
        totalByRole[finding.role] = (totalByRole[finding.role] ?? 0) + 1;
        totalBySeverity[finding.severity] = (totalBySeverity[finding.severity] ?? 0) + 1;
    }

    return {
        findings,
        totalByRole,
        totalBySeverity,
        deduplicatedCount: findings.length,
        originalCount,
    };
}

// ── Private Helpers ───────────────────────────────────

/**
 * Generate a deterministic ID from file + line + message.
 * Uses a simple djb2-style hash — no crypto needed.
 */
function hashFindingId(file: string, line: number | null, message: string): string {
    const input = `${file}:${line ?? 'null'}:${message}`;
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
        hash = hash >>> 0; // keep unsigned 32-bit
    }
    return hash.toString(16).padStart(8, '0');
}

function normalizeSeverity(raw: string): 'critical' | 'high' | 'medium' | 'low' {
    const lower = raw.trim().toLowerCase();
    if (lower === 'critical') return 'critical';
    if (lower === 'high') return 'high';
    if (lower === 'medium') return 'medium';
    return 'low';
}

function parseStructuredBlocks(
    aiOutput: string,
    role: ReviewerRole
): readonly FleetFinding[] {
    const blockPattern = /--- FINDING ---\s*([\s\S]*?)--- END FINDING ---/g;
    const findings: FleetFinding[] = [];
    let match: RegExpExecArray | null;

    while ((match = blockPattern.exec(aiOutput)) !== null) {
        const block = match[1];

        const fileMatch = block.match(/FILE:\s*(.+)/);
        const lineMatch = block.match(/LINE:\s*(\d+|UNKNOWN)/i);
        const severityMatch = block.match(/SEVERITY:\s*(\w+)/i);
        const messageMatch = block.match(/MESSAGE:\s*(.+)/);
        const suggestionMatch = block.match(/SUGGESTION:\s*([\s\S]*?)(?=\n[A-Z]+:|$)/);

        if (fileMatch === null || messageMatch === null) continue;

        const file = fileMatch[1].trim();
        const rawLine = lineMatch !== null ? lineMatch[1] : 'UNKNOWN';
        const line = rawLine.toUpperCase() === 'UNKNOWN' ? null : parseInt(rawLine, 10);
        const severity = severityMatch !== null ? normalizeSeverity(severityMatch[1]) : 'low';
        const message = messageMatch[1].trim();
        const suggestion = suggestionMatch !== null ? suggestionMatch[1].trim() : '';

        const id = hashFindingId(file, line, message);

        findings.push({ id, role, file, line, severity, message, suggestion });
    }

    return findings;
}

function parseLooseFindings(
    aiOutput: string,
    role: ReviewerRole
): readonly FleetFinding[] {
    const findings: FleetFinding[] = [];
    const lines = aiOutput.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const severityMatch = line.match(/\b(critical|high|medium|low)\b/i);
        if (severityMatch === null) continue;

        const severity = normalizeSeverity(severityMatch[1]);
        const message = line.trim();
        if (message.length < 10) continue;

        const id = hashFindingId('unknown', null, message);
        findings.push({
            id,
            role,
            file: 'unknown',
            line: null,
            severity,
            message,
            suggestion: '',
        });
    }

    return findings;
}
