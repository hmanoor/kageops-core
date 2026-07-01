/**
 * Verification gate for agent task completion.
 * Agents must provide evidence of completion — not just claim "done".
 * Inspired by Superpowers: "NO COMPLETION CLAIMS WITHOUT VERIFICATION"
 */

import * as fs from 'fs';
import * as path from 'path';
import { isLikelyArtifactContent } from './output-parser';

/** Types of verification evidence an agent can provide */
export type VerificationKind =
    | 'tests_passed'      // Test suite output showing pass
    | 'build_succeeded'   // Build output showing success
    | 'linter_clean'      // Linter output showing no errors
    | 'files_written'     // List of files created/modified
    | 'review_completed'  // Review verdict with score
    | 'command_output'    // Shell command output proving work
    | 'manual_check';     // Human verified (for non-automatable tasks)

export interface VerificationEvidence {
    readonly kind: VerificationKind;
    readonly summary: string;      // Brief description of what was verified
    readonly output: string;       // Actual output/proof (truncated if needed)
    readonly passed: boolean;      // Did the verification pass?
    readonly timestamp: Date;
}

export interface VerificationResult {
    readonly verified: boolean;       // Overall: can we mark this task done?
    readonly evidence: readonly VerificationEvidence[];
    readonly missingChecks: readonly string[];  // What's still needed
    readonly summary: string;
}

/** Required verification checks by task type */
const REQUIRED_CHECKS: Readonly<Record<string, readonly VerificationKind[]>> = {
    'implement':           ['files_written', 'build_succeeded'],
    'fix-bug':             ['files_written', 'tests_passed'],
    'refactor':            ['files_written', 'build_succeeded'],
    'create-api':          ['files_written', 'build_succeeded'],
    'create-ui':           ['files_written'],
    'database-migration':  ['files_written'],
    'write-tests':         ['files_written', 'tests_passed'],
    'code-review':         ['review_completed'],
    'security-review':     ['review_completed'],
    'quality-gate':        ['build_succeeded', 'tests_passed', 'linter_clean'],
    'run-tests':           ['tests_passed'],
    'documentation':       ['files_written'],
};

const DEFAULT_CHECKS: readonly VerificationKind[] = ['files_written'];

/** Get required checks for a task type */
export function getRequiredChecks(taskType: string): readonly VerificationKind[] {
    return REQUIRED_CHECKS[taskType] ?? DEFAULT_CHECKS;
}

/** Evaluate whether collected evidence satisfies requirements */
export function evaluateVerification(
    taskType: string,
    evidence: readonly VerificationEvidence[]
): VerificationResult {
    const required = getRequiredChecks(taskType);
    const passedKinds = new Set(
        evidence.filter(e => e.passed).map(e => e.kind)
    );

    const missingChecks = required.filter(check => !passedKinds.has(check));
    const verified = missingChecks.length === 0 && evidence.length > 0;

    const summary = verified
        ? `Verified: ${evidence.filter(e => e.passed).length}/${required.length} checks passed`
        : `Not verified: missing ${missingChecks.join(', ')}`;

    return { verified, evidence, missingChecks, summary };
}

/** Create a verification evidence record from a shell command result */
export function evidenceFromShell(
    kind: VerificationKind,
    summary: string,
    stdout: string,
    stderr: string,
    exitCode: number
): VerificationEvidence {
    return {
        kind,
        summary,
        output: (exitCode === 0 ? stdout : stderr).slice(0, 2000),
        passed: exitCode === 0,
        timestamp: new Date(),
    };
}

/**
 * Create a verification evidence record for files written.
 *
 * Two modes:
 *
 * 1. **Path-only (legacy, no repoPath)** — passes if any file paths
 *    were recorded. Used by callers that only have a string list.
 *
 * 2. **Content-aware (F-391, when repoPath is given)** — reads each
 *    file from disk and runs the same `isLikelyArtifactContent` shape
 *    oracle that F-390 uses at write time. Any file that fails the
 *    shape check (1-line prose stub in a `.ts` file, HTML described in
 *    prose, etc.) flips the entire evidence to `passed: false` with a
 *    summary that lists the offending paths. This is the verifier
 *    blind-spot fix from #165 stage 2 smoke (GPS Delivery Tracker v2)
 *    where Forge wrote stub prose into `.ts` files and the original
 *    path-only check reported "Verified: 4/2 checks passed".
 *
 * Layered with F-390: writeOutputFiles in autonaut-agent.ts already
 * rejects stub blocks at write time, so under normal flow only real
 * files reach this evidence step. F-391 is defense-in-depth in case
 * a future agent writes files outside writeOutputFiles or the F-390
 * regex is broadened too far.
 */
export function evidenceFromFiles(
    filesPaths: readonly string[],
    options?: { readonly repoPath?: string }
): VerificationEvidence {
    const ts = new Date();
    if (filesPaths.length === 0) {
        return {
            kind: 'files_written',
            summary: '0 file(s) written',
            output: '',
            passed: false,
            timestamp: ts,
        };
    }

    if (options?.repoPath === undefined || options.repoPath === '') {
        return {
            kind: 'files_written',
            summary: `${filesPaths.length} file(s) written`,
            output: filesPaths.join('\n'),
            passed: true,
            timestamp: ts,
        };
    }

    // F-391: content-aware mode — read each file and validate shape.
    const stubs: { path: string; preview: string }[] = [];
    const ok: string[] = [];

    for (const relPath of filesPaths) {
        const abs = path.isAbsolute(relPath) ? relPath : path.join(options.repoPath, relPath);
        try {
            const content = fs.readFileSync(abs, 'utf-8');
            if (!isLikelyArtifactContent(content, relPath)) {
                stubs.push({
                    path: relPath,
                    preview: content.replace(/\s+/g, ' ').slice(0, 120),
                });
            } else {
                ok.push(relPath);
            }
        } catch {
            // Unreadable file — treat as stub for safety. Likely a path
            // that was reported as written but disappeared, or a perms
            // issue; either way we don't want to count it as evidence.
            stubs.push({ path: relPath, preview: '(unreadable)' });
        }
    }

    if (stubs.length === 0) {
        return {
            kind: 'files_written',
            summary: `${filesPaths.length} file(s) written, all pass shape check`,
            output: filesPaths.join('\n'),
            passed: true,
            timestamp: ts,
        };
    }

    const detail = stubs
        .map((s) => `  - ${s.path}: "${s.preview}${s.preview.length >= 120 ? '…' : ''}"`)
        .join('\n');
    return {
        kind: 'files_written',
        summary: `F-391: ${stubs.length} of ${filesPaths.length} file(s) failed shape check (likely stub/prose)`,
        output: `Passed shape check (${ok.length}):\n${ok.join('\n')}\n\nFailed shape check (${stubs.length}):\n${detail}`,
        passed: false,
        timestamp: ts,
    };
}

/** Create a verification evidence for a review verdict */
export function evidenceFromReview(
    qualityScore: number,
    passed: boolean,
    summary: string
): VerificationEvidence {
    return {
        kind: 'review_completed',
        summary,
        output: `Quality: ${qualityScore}/10, Verdict: ${passed ? 'PASSED' : 'REJECTED'}`,
        passed,
        timestamp: new Date(),
    };
}
