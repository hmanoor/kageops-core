/**
 * Secret-scan CLI (security gate S1).
 *
 * Wires the previously-unused `src/hooks/pre-commit-scanner.ts` into the
 * git pre-commit hook and CI, so the scanner that already existed actually
 * runs. Blocks a commit / fails CI on any `block`-severity finding.
 *
 * Modes:
 *   --staged  scan only git-staged files (pre-commit hook; fast)   [default]
 *   --all     scan every git-tracked file (CI; defense-in-depth)
 *
 * Exit code: 0 = clean, 1 = blocking secret found, 2 = internal error.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';

import {
    runPreCommitScan,
    formatPreCommitReport,
    hasBlockingFindings,
    createDefaultConfig,
} from '../src/hooks/pre-commit-scanner';

function listFiles(mode: 'staged' | 'all'): readonly string[] {
    const cmd =
        mode === 'staged'
            ? 'git diff --cached --name-only --diff-filter=ACM'
            : 'git ls-files';
    return execSync(cmd, { encoding: 'utf-8' })
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function main(): void {
    const mode: 'staged' | 'all' = process.argv.includes('--all') ? 'all' : 'staged';

    let paths: readonly string[];
    try {
        paths = listFiles(mode);
    } catch (err) {
        console.error(`secret-scan: failed to list ${mode} files: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(2);
    }

    const files = paths
        .filter((p) => {
            try {
                return existsSync(p) && statSync(p).isFile();
            } catch {
                return false;
            }
        })
        .map((p) => {
            try {
                return { path: p, content: readFileSync(p, 'utf-8') };
            } catch {
                return null;
            }
        })
        .filter((f): f is { path: string; content: string } => f !== null);

    if (files.length === 0) {
        console.log('secret-scan: no files to scan — clean.');
        process.exit(0);
    }

    const result = runPreCommitScan(files, createDefaultConfig());

    if (hasBlockingFindings(result)) {
        console.error(formatPreCommitReport(result));
        console.error(
            '\n✖ Secret scan BLOCKED. Remove the secret(s) above. ' +
                'If a match is a false positive (placeholder, test fixture, prefix-validation), ' +
                'add it to the exclude list / allowlist and re-commit.',
        );
        process.exit(1);
    }

    console.log(`✓ Secret scan clean (${mode}: ${result.scannedFiles} files, ${result.duration}ms).`);
    process.exit(0);
}

main();
