/**
 * Hook installer tests
 */

import { describe, it, expect } from 'vitest';
import {
    SUPPORTED_HOOKS,
    generateHookScript,
    getHookPath,
    buildInstallPlan,
    createHookRegistry,
    addInstalledHook,
    removeHook,
    isHookInstalled,
    parseGitStagedFiles,
    filterScannable,
    buildPreCommitPayload,
    simulateHookExecution,
    formatHookStatus,
    createDefaultHookConfigs,
    computeChecksum,
    type HookType,
    type InstalledHook,
    type HookRegistry,
    type GitStagedFile,
} from '../../src/hooks/hook-installer';

// ── SUPPORTED_HOOKS ─────────────────────────────────

describe('SUPPORTED_HOOKS', () => {
    it('contains all 4 hook types', () => {
        expect(SUPPORTED_HOOKS).toHaveLength(4);
        expect(SUPPORTED_HOOKS).toContain('pre-commit');
        expect(SUPPORTED_HOOKS).toContain('pre-push');
        expect(SUPPORTED_HOOKS).toContain('commit-msg');
        expect(SUPPORTED_HOOKS).toContain('post-merge');
    });
});

// ── generateHookScript ──────────────────────────────

describe('generateHookScript', () => {
    it('produces a script with shebang', () => {
        const script = generateHookScript('pre-commit', '/path/config.json');
        expect(script.startsWith('#!/bin/bash')).toBe(true);
    });

    it('includes set -e', () => {
        const script = generateHookScript('pre-commit', '/path/config.json');
        expect(script).toContain('set -e');
    });

    it('checks for node availability', () => {
        const script = generateHookScript('pre-commit', '/path/config.json');
        expect(script).toContain('command -v node');
    });

    it('includes the config path', () => {
        const script = generateHookScript('pre-commit', '/my/config.json');
        expect(script).toContain('/my/config.json');
    });

    it('exits with scanner exit code', () => {
        const script = generateHookScript('pre-commit', '/path/config.json');
        expect(script).toContain('exit $EXIT_CODE');
    });

    it.each([
        'pre-commit',
        'pre-push',
        'commit-msg',
        'post-merge',
    ] as const)('generates script for %s hook type', (hookType) => {
        const script = generateHookScript(hookType, '/cfg.json');
        expect(script).toContain(hookType);
        expect(script).toContain('#!/bin/bash');
    });
});

// ── getHookPath ─────────────────────────────────────

describe('getHookPath', () => {
    it('resolves to .git/hooks/<type>', () => {
        const p = getHookPath('/repo/.git', 'pre-commit');
        expect(p).toMatch(/\.git[/\\]hooks[/\\]pre-commit$/);
    });

    it.each([
        ['pre-commit'],
        ['pre-push'],
        ['commit-msg'],
        ['post-merge'],
    ] as const)('resolves path for %s', (hookType) => {
        const p = getHookPath('/repo/.git', hookType);
        expect(p).toContain(hookType);
    });
});

// ── buildInstallPlan ────────────────────────────────

describe('buildInstallPlan', () => {
    it('marks disabled hooks as skip', () => {
        const plan = buildInstallPlan('/repo/.git', [
            { hookType: 'pre-commit', enabled: false, scriptPath: '', timeout: 30000 },
        ]);
        expect(plan[0].action).toBe('skip');
    });

    it('marks enabled hooks without scriptPath as install', () => {
        const plan = buildInstallPlan('/repo/.git', [
            { hookType: 'pre-commit', enabled: true, scriptPath: '', timeout: 30000 },
        ]);
        expect(plan[0].action).toBe('install');
    });

    it('marks enabled hooks with scriptPath as update', () => {
        const plan = buildInstallPlan('/repo/.git', [
            { hookType: 'pre-commit', enabled: true, scriptPath: '/existing/hook', timeout: 30000 },
        ]);
        expect(plan[0].action).toBe('update');
    });

    it('sets correct targetPath', () => {
        const plan = buildInstallPlan('/repo/.git', [
            { hookType: 'pre-push', enabled: true, scriptPath: '', timeout: 30000 },
        ]);
        expect(plan[0].targetPath).toContain('pre-push');
    });
});

// ── Registry CRUD ───────────────────────────────────

describe('createHookRegistry', () => {
    it('creates empty registry', () => {
        const reg = createHookRegistry('/repo/.git');
        expect(reg.hooks).toHaveLength(0);
        expect(reg.gitDir).toBe('/repo/.git');
    });
});

describe('addInstalledHook', () => {
    const hook: InstalledHook = {
        hookType: 'pre-commit',
        path: '/repo/.git/hooks/pre-commit',
        installed: true,
        lastModified: '2026-01-01T00:00:00Z',
        checksum: 'abc123',
    };

    it('adds a hook immutably', () => {
        const reg = createHookRegistry('/repo/.git');
        const updated = addInstalledHook(reg, hook);
        expect(updated.hooks).toHaveLength(1);
        expect(reg.hooks).toHaveLength(0); // original unchanged
    });

    it('replaces existing hook of same type', () => {
        const reg = createHookRegistry('/repo/.git');
        const first = addInstalledHook(reg, hook);
        const replacement: InstalledHook = { ...hook, checksum: 'xyz789' };
        const second = addInstalledHook(first, replacement);
        expect(second.hooks).toHaveLength(1);
        expect(second.hooks[0].checksum).toBe('xyz789');
    });
});

describe('removeHook', () => {
    it('removes hook immutably', () => {
        const hook: InstalledHook = {
            hookType: 'pre-commit',
            path: '/p',
            installed: true,
            lastModified: '',
            checksum: '',
        };
        const reg = addInstalledHook(createHookRegistry('/g'), hook);
        const updated = removeHook(reg, 'pre-commit');
        expect(updated.hooks).toHaveLength(0);
        expect(reg.hooks).toHaveLength(1); // original unchanged
    });
});

describe('isHookInstalled', () => {
    it('returns true for installed hook', () => {
        const reg = addInstalledHook(createHookRegistry('/g'), {
            hookType: 'pre-commit',
            path: '/p',
            installed: true,
            lastModified: '',
            checksum: '',
        });
        expect(isHookInstalled(reg, 'pre-commit')).toBe(true);
    });

    it('returns false for missing hook', () => {
        const reg = createHookRegistry('/g');
        expect(isHookInstalled(reg, 'pre-commit')).toBe(false);
    });

    it('returns false when installed is false', () => {
        const reg = addInstalledHook(createHookRegistry('/g'), {
            hookType: 'pre-commit',
            path: '/p',
            installed: false,
            lastModified: '',
            checksum: '',
        });
        expect(isHookInstalled(reg, 'pre-commit')).toBe(false);
    });
});

// ── parseGitStagedFiles ─────────────────────────────

describe('parseGitStagedFiles', () => {
    it.each([
        ['A\tsrc/new.ts', 'added'],
        ['M\tsrc/mod.ts', 'modified'],
        ['D\tsrc/del.ts', 'deleted'],
    ] as const)('parses status %s as %s', (line, expected) => {
        const files = parseGitStagedFiles(line);
        expect(files).toHaveLength(1);
        expect(files[0].status).toBe(expected);
    });

    it('parses renamed files with R status', () => {
        const files = parseGitStagedFiles('R100\told.ts\tnew.ts');
        expect(files[0].status).toBe('renamed');
        expect(files[0].oldPath).toBe('old.ts');
        expect(files[0].path).toBe('new.ts');
    });

    it('parses multi-line output', () => {
        const output = 'A\tfile1.ts\nM\tfile2.ts\nD\tfile3.ts';
        const files = parseGitStagedFiles(output);
        expect(files).toHaveLength(3);
    });

    it('handles empty input', () => {
        const files = parseGitStagedFiles('');
        expect(files).toHaveLength(0);
    });
});

// ── filterScannable ─────────────────────────────────

describe('filterScannable', () => {
    it('excludes deleted files', () => {
        const files: readonly GitStagedFile[] = [
            { path: 'src/a.ts', status: 'deleted', oldPath: null },
        ];
        expect(filterScannable(files)).toHaveLength(0);
    });

    it('excludes binary files', () => {
        const files: readonly GitStagedFile[] = [
            { path: 'logo.png', status: 'added', oldPath: null },
            { path: 'font.woff2', status: 'added', oldPath: null },
        ];
        expect(filterScannable(files)).toHaveLength(0);
    });

    it('excludes lock files', () => {
        const files: readonly GitStagedFile[] = [
            { path: 'package-lock.json', status: 'modified', oldPath: null },
            { path: 'yarn.lock', status: 'modified', oldPath: null },
        ];
        expect(filterScannable(files)).toHaveLength(0);
    });

    it('keeps normal source files', () => {
        const files: readonly GitStagedFile[] = [
            { path: 'src/app.ts', status: 'added', oldPath: null },
            { path: 'README.md', status: 'modified', oldPath: null },
        ];
        expect(filterScannable(files)).toHaveLength(2);
    });

    it.each([
        ['.png', 0],
        ['.jpg', 0],
        ['.exe', 0],
        ['.ts', 1],
        ['.js', 1],
        ['.md', 1],
    ])('file with extension %s yields %d scannable', (ext, expected) => {
        const files: readonly GitStagedFile[] = [
            { path: `file${ext}`, status: 'added', oldPath: null },
        ];
        expect(filterScannable(files)).toHaveLength(expected);
    });
});

// ── buildPreCommitPayload ───────────────────────────

describe('buildPreCommitPayload', () => {
    it('builds payload with correct fields', () => {
        const files: readonly GitStagedFile[] = [
            { path: 'a.ts', status: 'added', oldPath: null },
        ];
        const payload = buildPreCommitPayload(files, 'main', 'dev@test.com');
        expect(payload.stagedFiles).toHaveLength(1);
        expect(payload.branch).toBe('main');
        expect(payload.author).toBe('dev@test.com');
    });
});

// ── simulateHookExecution ───────────────────────────

describe('simulateHookExecution', () => {
    it('returns exit code 0 when passed', () => {
        const payload = buildPreCommitPayload([], 'main', 'a');
        const result = simulateHookExecution(payload, { passed: true, findings: 0 });
        expect(result.exitCode).toBe(0);
        expect(result.passed).toBe(true);
        expect(result.stderr).toBe('');
    });

    it('returns exit code 1 when failed', () => {
        const payload = buildPreCommitPayload([], 'main', 'a');
        const result = simulateHookExecution(payload, { passed: false, findings: 3 });
        expect(result.exitCode).toBe(1);
        expect(result.passed).toBe(false);
        expect(result.stderr).toContain('secrets detected');
    });

    it('includes file count in stdout', () => {
        const files: readonly GitStagedFile[] = [
            { path: 'a.ts', status: 'added', oldPath: null },
            { path: 'b.ts', status: 'modified', oldPath: null },
        ];
        const payload = buildPreCommitPayload(files, 'main', 'a');
        const result = simulateHookExecution(payload, { passed: true, findings: 0 });
        expect(result.stdout).toContain('2');
    });

    it('sets hookType to pre-commit', () => {
        const payload = buildPreCommitPayload([], 'main', 'a');
        const result = simulateHookExecution(payload, { passed: true, findings: 0 });
        expect(result.hookType).toBe('pre-commit');
    });
});

// ── formatHookStatus ────────────────────────────────

describe('formatHookStatus', () => {
    it('produces markdown with header', () => {
        const reg = createHookRegistry('/repo/.git');
        const md = formatHookStatus(reg);
        expect(md).toContain('# Hook Status');
    });

    it('shows all 4 hook types in table', () => {
        const reg = createHookRegistry('/repo/.git');
        const md = formatHookStatus(reg);
        expect(md).toContain('pre-commit');
        expect(md).toContain('pre-push');
        expect(md).toContain('commit-msg');
        expect(md).toContain('post-merge');
    });

    it('shows Yes for installed hooks', () => {
        const reg = addInstalledHook(createHookRegistry('/g'), {
            hookType: 'pre-commit',
            path: '/g/hooks/pre-commit',
            installed: true,
            lastModified: '',
            checksum: '',
        });
        const md = formatHookStatus(reg);
        expect(md).toContain('Yes');
    });
});

// ── createDefaultHookConfigs ────────────────────────

describe('createDefaultHookConfigs', () => {
    it('returns 4 configs', () => {
        const configs = createDefaultHookConfigs();
        expect(configs).toHaveLength(4);
    });

    it('only pre-commit is enabled', () => {
        const configs = createDefaultHookConfigs();
        const enabled = configs.filter((c) => c.enabled);
        expect(enabled).toHaveLength(1);
        expect(enabled[0].hookType).toBe('pre-commit');
    });
});

// ── computeChecksum ─────────────────────────────────

describe('computeChecksum', () => {
    it('returns consistent hash for same input', () => {
        const a = computeChecksum('hello');
        const b = computeChecksum('hello');
        expect(a).toBe(b);
    });

    it('returns different hash for different input', () => {
        const a = computeChecksum('hello');
        const b = computeChecksum('world');
        expect(a).not.toBe(b);
    });
});
