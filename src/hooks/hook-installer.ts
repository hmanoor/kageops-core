/**
 * KageOps Git Hook Installer
 *
 * Manages git hook installation, registry, and execution simulation.
 * Pure functions — no file I/O or shell execution.
 */

import * as path from 'path';
import * as crypto from 'crypto';

// ── Types ────────────────────────────────────────────

export type HookType = 'pre-commit' | 'pre-push' | 'commit-msg' | 'post-merge';

export interface HookConfig {
    readonly hookType: HookType;
    readonly enabled: boolean;
    readonly scriptPath: string;
    readonly timeout: number;
}

export interface InstalledHook {
    readonly hookType: HookType;
    readonly path: string;
    readonly installed: boolean;
    readonly lastModified: string;
    readonly checksum: string;
}

export interface HookExecutionResult {
    readonly hookType: HookType;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly durationMs: number;
    readonly passed: boolean;
}

export interface HookRegistry {
    readonly hooks: readonly InstalledHook[];
    readonly gitDir: string;
    readonly lastChecked: string;
}

export interface GitStagedFile {
    readonly path: string;
    readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
    readonly oldPath: string | null;
}

export interface PreCommitPayload {
    readonly stagedFiles: readonly GitStagedFile[];
    readonly branch: string;
    readonly author: string;
}

// ── Constants ────────────────────────────────────────

export const SUPPORTED_HOOKS: readonly HookType[] = [
    'pre-commit',
    'pre-push',
    'commit-msg',
    'post-merge',
] as const;

const BINARY_EXTENSIONS: readonly string[] = [
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2',
    '.ttf', '.eot', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll',
    '.so', '.dylib', '.bin', '.dat',
];

const LOCK_FILES: readonly string[] = [
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock',
];

// ── Functions ────────────────────────────────────────

export function generateHookScript(hookType: HookType, configPath: string): string {
    return [
        '#!/bin/bash',
        `# KageOps ${hookType} hook`,
        '# Auto-generated — do not edit manually',
        '',
        'set -e',
        '',
        '# Verify node is available',
        'if ! command -v node &> /dev/null; then',
        '  echo "ERROR: node not found. Install Node.js to use KageOps hooks."',
        '  exit 1',
        'fi',
        '',
        `CONFIG_PATH="${configPath}"`,
        '',
        `node "$(dirname "$0")/../../scripts/${hookType}-scan.js" "$CONFIG_PATH"`,
        'EXIT_CODE=$?',
        '',
        'exit $EXIT_CODE',
    ].join('\n');
}

export function getHookPath(gitDir: string, hookType: HookType): string {
    return path.join(gitDir, 'hooks', hookType);
}

export function buildInstallPlan(
    gitDir: string,
    hooks: readonly HookConfig[],
): readonly { readonly hookType: HookType; readonly targetPath: string; readonly action: 'install' | 'update' | 'skip' }[] {
    return hooks.map((hook) => {
        const targetPath = getHookPath(gitDir, hook.hookType);
        if (!hook.enabled) {
            return { hookType: hook.hookType, targetPath, action: 'skip' as const };
        }
        // If scriptPath is provided, it implies an existing hook that may need updating
        if (hook.scriptPath.length > 0) {
            return { hookType: hook.hookType, targetPath, action: 'update' as const };
        }
        return { hookType: hook.hookType, targetPath, action: 'install' as const };
    });
}

export function createHookRegistry(gitDir: string): HookRegistry {
    return {
        hooks: [],
        gitDir,
        lastChecked: new Date().toISOString(),
    };
}

export function addInstalledHook(registry: HookRegistry, hook: InstalledHook): HookRegistry {
    const filtered = registry.hooks.filter((h) => h.hookType !== hook.hookType);
    return {
        ...registry,
        hooks: [...filtered, hook],
        lastChecked: new Date().toISOString(),
    };
}

export function removeHook(registry: HookRegistry, hookType: HookType): HookRegistry {
    return {
        ...registry,
        hooks: registry.hooks.filter((h) => h.hookType !== hookType),
        lastChecked: new Date().toISOString(),
    };
}

export function isHookInstalled(registry: HookRegistry, hookType: HookType): boolean {
    return registry.hooks.some((h) => h.hookType === hookType && h.installed);
}

export function parseGitStagedFiles(gitStatusOutput: string): readonly GitStagedFile[] {
    const lines = gitStatusOutput.trim().split('\n').filter((l) => l.length > 0);
    return lines.map((line) => {
        const parts = line.split('\t');
        const statusCode = parts[0].trim();
        const filePath = parts[1] ?? '';

        if (statusCode.startsWith('R')) {
            return {
                path: parts[2] ?? filePath,
                status: 'renamed' as const,
                oldPath: parts[1] ?? null,
            };
        }

        const statusMap: Record<string, GitStagedFile['status']> = {
            'A': 'added',
            'M': 'modified',
            'D': 'deleted',
        };

        return {
            path: filePath,
            status: statusMap[statusCode] ?? 'modified',
            oldPath: null,
        };
    });
}

export function filterScannable(files: readonly GitStagedFile[]): readonly GitStagedFile[] {
    return files.filter((file) => {
        if (file.status === 'deleted') return false;
        const ext = path.extname(file.path).toLowerCase();
        if (BINARY_EXTENSIONS.includes(ext)) return false;
        const basename = path.basename(file.path);
        if (LOCK_FILES.includes(basename)) return false;
        return true;
    });
}

export function buildPreCommitPayload(
    files: readonly GitStagedFile[],
    branch: string,
    author: string,
): PreCommitPayload {
    return { stagedFiles: files, branch, author };
}

export function simulateHookExecution(
    payload: PreCommitPayload,
    scanResults: { readonly passed: boolean; readonly findings: number },
): HookExecutionResult {
    const passed = scanResults.passed;
    return {
        hookType: 'pre-commit',
        exitCode: passed ? 0 : 1,
        stdout: passed
            ? `Scanned ${payload.stagedFiles.length} files — no secrets found.`
            : `Scanned ${payload.stagedFiles.length} files — ${scanResults.findings} finding(s) detected.`,
        stderr: passed ? '' : 'Pre-commit hook failed: secrets detected in staged files.',
        durationMs: 0,
        passed,
    };
}

export function formatHookStatus(registry: HookRegistry): string {
    const lines: string[] = [
        '# Hook Status',
        '',
        `**Git directory:** ${registry.gitDir}`,
        `**Last checked:** ${registry.lastChecked}`,
        '',
        '| Hook | Installed | Path |',
        '|------|-----------|------|',
    ];

    for (const hookType of SUPPORTED_HOOKS) {
        const hook = registry.hooks.find((h) => h.hookType === hookType);
        const installed = hook?.installed ? 'Yes' : 'No';
        const hookPath = hook?.path ?? '—';
        lines.push(`| ${hookType} | ${installed} | ${hookPath} |`);
    }

    return lines.join('\n');
}

export function createDefaultHookConfigs(): readonly HookConfig[] {
    return [
        { hookType: 'pre-commit', enabled: true, scriptPath: '', timeout: 30_000 },
        { hookType: 'pre-push', enabled: false, scriptPath: '', timeout: 60_000 },
        { hookType: 'commit-msg', enabled: false, scriptPath: '', timeout: 10_000 },
        { hookType: 'post-merge', enabled: false, scriptPath: '', timeout: 30_000 },
    ];
}

export function computeChecksum(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}
