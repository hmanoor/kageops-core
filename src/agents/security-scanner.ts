/**
 * Pre-write security scanner for agent output.
 * Scans code for 8 common vulnerability patterns before writing to disk.
 * Session-scoped: each pattern warned only once per agent session.
 * Inspired by: Claude Security Guidance Plugin (107K installs).
 *
 * B-205
 */

// ── Types ───────────────────────────────────────────

export interface SecurityFinding {
    readonly pattern: string;
    readonly severity: 'critical' | 'high' | 'medium';
    readonly file: string;
    readonly line: number;
    readonly match: string;
    readonly remediation: string;
}

export interface ScanResult {
    readonly findings: readonly SecurityFinding[];
    readonly scannedFiles: number;
    readonly blocked: boolean;
}

// ── Vulnerability Patterns ──────────────────────────

interface VulnerabilityPattern {
    readonly name: string;
    readonly regex: RegExp;
    readonly severity: 'critical' | 'high' | 'medium';
    readonly remediation: string;
}

const VULNERABILITY_PATTERNS: readonly VulnerabilityPattern[] = [
    {
        name: 'child_process.exec',
        regex: /child_process.*\.exec\b/,
        severity: 'high',
        remediation: 'Use execFile() or execFileSync() instead',
    },
    {
        name: 'eval()',
        regex: /\beval\s*\(/,
        severity: 'high',
        remediation: 'Remove eval, use JSON.parse or safe alternatives',
    },
    {
        name: 'new Function()',
        regex: /new\s+Function\s*\(/,
        severity: 'medium',
        remediation: 'Avoid dynamic function construction',
    },
    {
        name: 'dangerouslySetInnerHTML',
        regex: /dangerouslySetInnerHTML/,
        severity: 'high',
        remediation: 'Use safe rendering, sanitize HTML',
    },
    {
        name: 'innerHTML assignment',
        regex: /\.innerHTML\s*=/,
        severity: 'high',
        remediation: 'Use textContent or DOM APIs',
    },
    {
        name: 'pickle.load/loads',
        regex: /pickle\.(load|loads)\s*\(/,
        severity: 'critical',
        remediation: 'Use json.load or safe deserializer',
    },
    {
        name: 'os.system()',
        regex: /os\.system\s*\(/,
        severity: 'high',
        remediation: 'Use subprocess.run with shell=False',
    },
    {
        name: 'GitHub Actions injection',
        regex: /\$\{\{\s*github\.event\.(issue|pull_request|comment)\./,
        severity: 'high',
        remediation: 'Use environment variables instead of direct interpolation',
    },
];

// ── Core Scan Function ──────────────────────────────

/**
 * Scan a single file's content for vulnerability patterns.
 */
export function scanContent(
    content: string,
    filePath: string
): readonly SecurityFinding[] {
    const lines = content.split('\n');
    const findings: SecurityFinding[] = [];

    for (const pattern of VULNERABILITY_PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
            const lineContent = lines[i];
            const match = pattern.regex.exec(lineContent);
            if (match) {
                findings.push({
                    pattern: pattern.name,
                    severity: pattern.severity,
                    file: filePath,
                    line: i + 1,
                    match: match[0],
                    remediation: pattern.remediation,
                });
            }
        }
    }

    return findings;
}

// ── Multi-file Scan ─────────────────────────────────

/**
 * Scan multiple files and return an aggregate result.
 */
export function scanForVulnerabilities(
    files: ReadonlyMap<string, string>
): ScanResult {
    const allFindings: SecurityFinding[] = [];

    for (const [filePath, content] of files) {
        const findings = scanContent(content, filePath);
        allFindings.push(...findings);
    }

    return {
        findings: allFindings,
        scannedFiles: files.size,
        blocked: allFindings.some((f) => f.severity === 'critical'),
    };
}

// ── Session-Scoped Scanner ──────────────────────────

export class SessionScanner {
    private warnedPatterns: Set<string> = new Set();

    /**
     * Scan content and return only NEW findings (patterns not yet warned about).
     */
    scan(content: string, filePath: string): readonly SecurityFinding[] {
        const allFindings = scanContent(content, filePath);
        const newFindings = allFindings.filter(
            (f) => !this.warnedPatterns.has(f.pattern)
        );

        for (const f of newFindings) {
            this.warnedPatterns.add(f.pattern);
        }

        return newFindings;
    }

    /** Clear the warned-patterns set. */
    reset(): void {
        this.warnedPatterns = new Set();
    }
}

/**
 * Factory for session-scoped scanner instances.
 */
export function createSessionScanner(): SessionScanner {
    return new SessionScanner();
}
