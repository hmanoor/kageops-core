/**
 * project-github-push unit tests (B-427).
 *
 * Exercises the pure `handlePushProjectToGitHub` function — no Electron,
 * no git subprocess, no network.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    handlePushProjectToGitHub,
    type ProjectGitHubPushDeps,
    type ProjectGitHubRow,
} from '../../src/main/project-github-push';

// ── Helper: make a deps bundle with sensible happy-path defaults ──

interface DepsOverrides {
    readonly row?: ProjectGitHubRow | null;
    readonly rowError?: Error;
    readonly token?: string | null;
    readonly branch?: string;
    readonly branchError?: Error;
    readonly ensureError?: Error;
    readonly pushError?: Error;
}

function makeDeps(o: DepsOverrides = {}): {
    deps: ProjectGitHubPushDeps;
    pushBranch: ReturnType<typeof vi.fn>;
    getProjectRow: ReturnType<typeof vi.fn>;
} {
    const pushBranch = vi.fn(async () => {
        if (o.pushError !== undefined) throw o.pushError;
    });
    const row: ProjectGitHubRow = o.row ?? {
        github_owner: 'ninjas',
        github_repo: 'kage',
        repo_path: '/tmp/work',
    };
    const getProjectRow = vi.fn(async () => {
        if (o.rowError !== undefined) throw o.rowError;
        return o.row === null ? null : row;
    });
    const deps: ProjectGitHubPushDeps = {
        getProjectRow,
        getGitHubToken: async () => ('token' in o ? (o.token ?? null) : 'ghp_tok123'),
        getGitHubClient: () => ({ pushBranch } as never),
        getCurrentBranch: async () => {
            if (o.branchError !== undefined) throw o.branchError;
            return o.branch ?? 'main';
        },
        ensureCommitted: async () => {
            if (o.ensureError !== undefined) throw o.ensureError;
        },
    };
    return { deps, pushBranch, getProjectRow };
}

// ── Input validation ─────────────────────────────────

describe('handlePushProjectToGitHub input validation', () => {
    it('rejects non-string projectId', async () => {
        const { deps } = makeDeps();
        expect(await handlePushProjectToGitHub(deps, 42)).toEqual({ success: false, error: 'Invalid projectId' });
        expect(await handlePushProjectToGitHub(deps, null)).toEqual({ success: false, error: 'Invalid projectId' });
        expect(await handlePushProjectToGitHub(deps, undefined)).toEqual({ success: false, error: 'Invalid projectId' });
    });

    it('rejects blank / whitespace-only projectId', async () => {
        const { deps } = makeDeps();
        expect((await handlePushProjectToGitHub(deps, '')).success).toBe(false);
        expect((await handlePushProjectToGitHub(deps, '   ')).success).toBe(false);
    });
});

// ── Project row lookup ───────────────────────────────

describe('handlePushProjectToGitHub project lookup', () => {
    it('returns "Project not found" when the row is null', async () => {
        const { deps } = makeDeps({ row: null });
        const res = await handlePushProjectToGitHub(deps, 'proj-1');
        expect(res).toEqual({ success: false, error: 'Project not found' });
    });

    it('returns a structured error when the DB throws', async () => {
        const { deps } = makeDeps({ rowError: new Error('db down') });
        const res = await handlePushProjectToGitHub(deps, 'proj-1');
        expect(res).toEqual({ success: false, error: 'db down' });
    });

    it('rejects a project with no github_owner configured', async () => {
        const { deps } = makeDeps({
            row: { github_owner: null, github_repo: 'r', repo_path: '/tmp/w' },
        });
        const res = await handlePushProjectToGitHub(deps, 'proj-1');
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/GitHub repo not configured/);
    });

    it('rejects a project with empty-string github_repo', async () => {
        const { deps } = makeDeps({
            row: { github_owner: 'n', github_repo: '   ', repo_path: '/tmp/w' },
        });
        const res = await handlePushProjectToGitHub(deps, 'proj-1');
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/GitHub repo not configured/);
    });

    it('rejects a project with no repo_path', async () => {
        const { deps } = makeDeps({
            row: { github_owner: 'n', github_repo: 'r', repo_path: null },
        });
        const res = await handlePushProjectToGitHub(deps, 'proj-1');
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/no workspace path/i);
    });
});

// ── Token + branch + push pipeline ───────────────────

describe('handlePushProjectToGitHub pipeline', () => {
    it('rejects when no GitHub token is stored', async () => {
        const { deps, pushBranch } = makeDeps({ token: null });
        const res = await handlePushProjectToGitHub(deps, 'proj-1');
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/GitHub token not configured/);
        expect(pushBranch).not.toHaveBeenCalled();
    });

    it('rejects when the token is an empty string', async () => {
        const { deps } = makeDeps({ token: '' });
        const res = await handlePushProjectToGitHub(deps, 'proj-1');
        expect(res.success).toBe(false);
    });

    it('surfaces ensureCommitted errors before touching the network', async () => {
        const { deps, pushBranch } = makeDeps({ ensureError: new Error('commit refused') });
        const res = await handlePushProjectToGitHub(deps, 'proj-1');
        expect(res).toEqual({ success: false, error: 'commit refused' });
        expect(pushBranch).not.toHaveBeenCalled();
    });

    it('surfaces getCurrentBranch errors before touching the network', async () => {
        const { deps, pushBranch } = makeDeps({ branchError: new Error('detached head and recovery failed') });
        const res = await handlePushProjectToGitHub(deps, 'proj-1');
        expect(res.success).toBe(false);
        expect(res.error).toMatch(/detached head/);
        expect(pushBranch).not.toHaveBeenCalled();
    });

    it('rejects an empty branch name', async () => {
        const { deps, pushBranch } = makeDeps({ branch: '' });
        const res = await handlePushProjectToGitHub(deps, 'proj-1');
        expect(res.success).toBe(false);
        expect(pushBranch).not.toHaveBeenCalled();
    });

    it('surfaces pushBranch failures with the original message', async () => {
        const { deps } = makeDeps({ pushError: new Error('403 forbidden') });
        const res = await handlePushProjectToGitHub(deps, 'proj-1');
        expect(res).toEqual({ success: false, error: '403 forbidden' });
    });

    it('happy path: trims projectId, passes full config, returns branch + URL', async () => {
        const { deps, pushBranch, getProjectRow } = makeDeps({ branch: 'feature/x' });
        const res = await handlePushProjectToGitHub(deps, '  proj-1  ');

        expect(res.success).toBe(true);
        expect(res.branch).toBe('feature/x');
        expect(res.repoUrl).toBe('https://github.com/ninjas/kage/tree/feature%2Fx');

        expect(getProjectRow).toHaveBeenCalledWith('proj-1');
        expect(pushBranch).toHaveBeenCalledTimes(1);
        expect(pushBranch).toHaveBeenCalledWith(
            '/tmp/work',
            { owner: 'ninjas', repo: 'kage', token: 'ghp_tok123' },
            'feature/x',
        );
    });

    it('default branch is "main" when no override provided', async () => {
        const { deps, pushBranch } = makeDeps();
        const res = await handlePushProjectToGitHub(deps, 'proj-1');
        expect(res.success).toBe(true);
        expect(res.branch).toBe('main');
        expect(pushBranch).toHaveBeenCalledWith(
            '/tmp/work',
            expect.objectContaining({ owner: 'ninjas', repo: 'kage' }),
            'main',
        );
    });
});
