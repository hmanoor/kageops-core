/**
 * P1-08a — revision-staging module.
 *
 * Covers the pure-ish helpers that own the staging-dir lifecycle:
 * stageFile (writes proposal, computes shas), listProposed (reads
 * back), acceptProposal (moves into workspace via injected writer +
 * cleans up), rejectProposal (delete staging dir).
 *
 * Uses a real temp dir + real fs so path-traversal + sha + cleanup
 * behaviour is exercised end-to-end. No db/network mocks needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
    stagingDirFor,
    stageFile,
    listProposed,
    acceptProposal,
    rejectProposal,
} from '../../src/agents/revision-staging';

const PROJECT_ID = 'proj-1';
const TASK_ID = 'task-1';

let stagingRoot: string;
let repoDir: string;

beforeEach(() => {
    stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-staging-'));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-repo-'));
});

afterEach(() => {
    try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function sha(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// ── stagingDirFor ──

describe('stagingDirFor()', () => {
    it('uses the configured stagingRoot when provided', () => {
        const dir = stagingDirFor(PROJECT_ID, TASK_ID, { stagingRoot });
        expect(dir).toBe(path.join(stagingRoot, PROJECT_ID, TASK_ID));
    });

    it('defaults to KAGEOPS_DATA_DIR/staging when no config given', () => {
        const original = process.env['KAGEOPS_DATA_DIR'];
        process.env['KAGEOPS_DATA_DIR'] = '/tmp/some-data-dir';
        try {
            const dir = stagingDirFor(PROJECT_ID, TASK_ID);
            expect(dir).toBe(path.join('/tmp/some-data-dir', 'staging', PROJECT_ID, TASK_ID));
        } finally {
            if (original === undefined) delete process.env['KAGEOPS_DATA_DIR'];
            else process.env['KAGEOPS_DATA_DIR'] = original;
        }
    });
});

// ── stageFile ──

describe('stageFile()', () => {
    it('writes the proposed content + returns ProposedFile with shas', () => {
        const result = stageFile(PROJECT_ID, TASK_ID, repoDir, 'index.html', '<h1>Hello</h1>', { stagingRoot });

        expect(result.path).toBe('index.html');
        expect(result.sizeBytes).toBe(Buffer.byteLength('<h1>Hello</h1>', 'utf-8'));
        expect(result.proposedSha256).toBe(sha('<h1>Hello</h1>'));
        expect(result.currentSha256).toBeNull(); // file doesn't exist in repo
        expect(result.unchanged).toBe(false);

        // File should be on disk under staging dir.
        const staged = fs.readFileSync(path.join(stagingDirFor(PROJECT_ID, TASK_ID, { stagingRoot }), 'index.html'), 'utf-8');
        expect(staged).toBe('<h1>Hello</h1>');
    });

    it('marks unchanged=true when staged content matches what is on disk', () => {
        fs.writeFileSync(path.join(repoDir, 'index.html'), '<p>same</p>', 'utf-8');
        const result = stageFile(PROJECT_ID, TASK_ID, repoDir, 'index.html', '<p>same</p>', { stagingRoot });
        expect(result.unchanged).toBe(true);
        expect(result.currentSha256).toBe(result.proposedSha256);
    });

    it('writes nested paths under the staging dir', () => {
        const result = stageFile(PROJECT_ID, TASK_ID, repoDir, 'src/components/Foo.tsx', 'export {};', { stagingRoot });
        expect(result.path).toBe('src/components/Foo.tsx');
        const staged = fs.readFileSync(path.join(stagingDirFor(PROJECT_ID, TASK_ID, { stagingRoot }), 'src/components/Foo.tsx'), 'utf-8');
        expect(staged).toBe('export {};');
    });

    it('rejects path traversal attempts (../../../evil.txt)', () => {
        expect(() =>
            stageFile(PROJECT_ID, TASK_ID, repoDir, '../../../evil.txt', 'malicious', { stagingRoot }),
        ).toThrow(/[Pp]ath traversal/);
    });

    it('rejects a sibling task-dir that merely shares the task dir as a string prefix (KO-SEC-007/008/016)', () => {
        // Regression guard: the staging-dir guard used to check
        // `absStaged.startsWith(path.resolve(dir))` with no path-separator
        // boundary, so a sibling dir like `<TASK_ID>-evil` (which shares
        // `<TASK_ID>` as a string prefix but is NOT nested inside it)
        // passed the check.
        expect(() =>
            stageFile(PROJECT_ID, TASK_ID, repoDir, `../${TASK_ID}-evil/secret.txt`, 'malicious', { stagingRoot }),
        ).toThrow(/[Pp]ath traversal/);
    });

    it('overwrites a re-staged file with new content (sha changes)', () => {
        const first = stageFile(PROJECT_ID, TASK_ID, repoDir, 'a.txt', 'version 1', { stagingRoot });
        const second = stageFile(PROJECT_ID, TASK_ID, repoDir, 'a.txt', 'version 2', { stagingRoot });
        expect(first.proposedSha256).not.toBe(second.proposedSha256);
        const staged = fs.readFileSync(path.join(stagingDirFor(PROJECT_ID, TASK_ID, { stagingRoot }), 'a.txt'), 'utf-8');
        expect(staged).toBe('version 2');
    });
});

// ── listProposed ──

describe('listProposed()', () => {
    it('returns null when the staging dir does not exist', () => {
        expect(listProposed('no-such-project', 'no-such-task', repoDir, { stagingRoot })).toBeNull();
    });

    it('returns a proposal with sorted file list + per-file shas', () => {
        stageFile(PROJECT_ID, TASK_ID, repoDir, 'index.html', '<html></html>', { stagingRoot });
        stageFile(PROJECT_ID, TASK_ID, repoDir, 'styles.css', 'body{}', { stagingRoot });

        const proposal = listProposed(PROJECT_ID, TASK_ID, repoDir, { stagingRoot });
        expect(proposal).not.toBeNull();
        expect(proposal!.files.map((f) => f.path)).toEqual(['index.html', 'styles.css']);
        expect(proposal!.files[0].proposedSha256).toBe(sha('<html></html>'));
        expect(proposal!.files[1].proposedSha256).toBe(sha('body{}'));
    });

    it('detects unchanged files by comparing against live workspace', () => {
        fs.writeFileSync(path.join(repoDir, 'a.html'), 'same', 'utf-8');
        stageFile(PROJECT_ID, TASK_ID, repoDir, 'a.html', 'same', { stagingRoot });
        stageFile(PROJECT_ID, TASK_ID, repoDir, 'b.html', 'new', { stagingRoot });

        const proposal = listProposed(PROJECT_ID, TASK_ID, repoDir, { stagingRoot });
        const aFile = proposal!.files.find((f) => f.path === 'a.html')!;
        const bFile = proposal!.files.find((f) => f.path === 'b.html')!;
        expect(aFile.unchanged).toBe(true);
        expect(bFile.unchanged).toBe(false);
        expect(bFile.currentSha256).toBeNull();
    });

    it('re-computes currentSha256 from the live workspace (not staging-time snapshot)', () => {
        // Stage when repo has version A on disk.
        fs.writeFileSync(path.join(repoDir, 'a.html'), 'version A', 'utf-8');
        stageFile(PROJECT_ID, TASK_ID, repoDir, 'a.html', 'version B', { stagingRoot });

        // Operator hand-edits the workspace between propose + review.
        fs.writeFileSync(path.join(repoDir, 'a.html'), 'version C — hand-edited', 'utf-8');

        const proposal = listProposed(PROJECT_ID, TASK_ID, repoDir, { stagingRoot });
        expect(proposal!.files[0].currentSha256).toBe(sha('version C — hand-edited'));
        expect(proposal!.files[0].proposedSha256).toBe(sha('version B'));
        expect(proposal!.files[0].unchanged).toBe(false);
    });
});

// ── acceptProposal ──

describe('acceptProposal()', () => {
    it('writes each staged file via the injected writer, returns list of accepted paths', async () => {
        stageFile(PROJECT_ID, TASK_ID, repoDir, 'a.html', 'A', { stagingRoot });
        stageFile(PROJECT_ID, TASK_ID, repoDir, 'b.css', 'B', { stagingRoot });
        const writes: Array<{ path: string; content: string }> = [];
        const writer = async (p: string, c: string): Promise<void> => { writes.push({ path: p, content: c }); };

        const accepted = await acceptProposal(PROJECT_ID, TASK_ID, repoDir, writer, { stagingRoot });
        expect(accepted.sort()).toEqual(['a.html', 'b.css']);
        expect(writes.length).toBe(2);
        expect(writes.find((w) => w.path === 'a.html')?.content).toBe('A');
    });

    it('skips unchanged files on accept (no spurious writer calls)', async () => {
        fs.writeFileSync(path.join(repoDir, 'same.html'), 'identical', 'utf-8');
        stageFile(PROJECT_ID, TASK_ID, repoDir, 'same.html', 'identical', { stagingRoot });
        stageFile(PROJECT_ID, TASK_ID, repoDir, 'changed.html', 'new', { stagingRoot });
        const writes: string[] = [];
        const writer = async (p: string, _c: string): Promise<void> => { writes.push(p); };

        const accepted = await acceptProposal(PROJECT_ID, TASK_ID, repoDir, writer, { stagingRoot });
        expect(accepted).toEqual(['changed.html']);
        expect(writes).toEqual(['changed.html']);
    });

    it('cleans up the staging dir on success', async () => {
        stageFile(PROJECT_ID, TASK_ID, repoDir, 'a.html', 'A', { stagingRoot });
        const dir = stagingDirFor(PROJECT_ID, TASK_ID, { stagingRoot });
        expect(fs.existsSync(dir)).toBe(true);

        await acceptProposal(PROJECT_ID, TASK_ID, repoDir, async () => {}, { stagingRoot });

        expect(fs.existsSync(dir)).toBe(false);
    });

    it('no-ops + returns [] when there is no staged proposal', async () => {
        const result = await acceptProposal('no-such', 'no-such', repoDir, async () => {}, { stagingRoot });
        expect(result).toEqual([]);
    });
});

// ── rejectProposal ──

describe('rejectProposal()', () => {
    it('deletes the staging dir', () => {
        stageFile(PROJECT_ID, TASK_ID, repoDir, 'a.html', 'A', { stagingRoot });
        const dir = stagingDirFor(PROJECT_ID, TASK_ID, { stagingRoot });
        expect(fs.existsSync(dir)).toBe(true);

        rejectProposal(PROJECT_ID, TASK_ID, { stagingRoot });
        expect(fs.existsSync(dir)).toBe(false);
    });

    it('is idempotent — no-op when nothing is staged', () => {
        expect(() => rejectProposal('no-such', 'no-such', { stagingRoot })).not.toThrow();
    });

    it('also cleans up the empty project-level parent dir', () => {
        stageFile(PROJECT_ID, TASK_ID, repoDir, 'a.html', 'A', { stagingRoot });
        rejectProposal(PROJECT_ID, TASK_ID, { stagingRoot });
        expect(fs.existsSync(path.join(stagingRoot, PROJECT_ID))).toBe(false);
    });

    it('does NOT cascade-delete the project dir when other tasks are still staged', () => {
        stageFile(PROJECT_ID, 'task-a', repoDir, 'a.html', 'A', { stagingRoot });
        stageFile(PROJECT_ID, 'task-b', repoDir, 'b.html', 'B', { stagingRoot });
        rejectProposal(PROJECT_ID, 'task-a', { stagingRoot });
        // task-a gone, task-b survives, project dir survives.
        expect(fs.existsSync(stagingDirFor(PROJECT_ID, 'task-a', { stagingRoot }))).toBe(false);
        expect(fs.existsSync(stagingDirFor(PROJECT_ID, 'task-b', { stagingRoot }))).toBe(true);
        expect(fs.existsSync(path.join(stagingRoot, PROJECT_ID))).toBe(true);
    });
});
