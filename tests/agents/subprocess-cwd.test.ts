/**
 * RG-1 — CLI subprocess cwd isolation: a missing cwd must never inherit the
 * parent (KageOps repo) cwd; it redirects to an isolated scratch dir.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import {
    safeSubprocessCwd,
    subprocessScratchDir,
    _resetSubprocessScratchForTests,
} from '../../src/agents/ai-adapter/subprocess-cwd';

describe('safeSubprocessCwd', () => {
    beforeEach(() => _resetSubprocessScratchForTests());

    it('honours a valid workspace cwd verbatim (no redirect)', () => {
        const r = safeSubprocessCwd('C:/work/proj-123');
        expect(r).toEqual({ cwd: 'C:/work/proj-123', redirected: false });
    });

    it('redirects undefined cwd to the scratch dir', () => {
        const r = safeSubprocessCwd(undefined);
        expect(r.redirected).toBe(true);
        expect(r.cwd).toBe(subprocessScratchDir());
    });

    it('redirects an empty / whitespace cwd to the scratch dir', () => {
        expect(safeSubprocessCwd('').redirected).toBe(true);
        expect(safeSubprocessCwd('   ').redirected).toBe(true);
    });

    it('the scratch dir is outside cwd (the repo) and actually exists', () => {
        const dir = subprocessScratchDir();
        expect(dir.startsWith(os.tmpdir())).toBe(true);
        expect(dir).not.toBe(process.cwd());
        expect(fs.existsSync(dir)).toBe(true);
    });

    it('never returns an empty cwd (the spawn can never inherit process.cwd())', () => {
        for (const input of [undefined, '', '   ']) {
            expect(safeSubprocessCwd(input).cwd.trim()).not.toBe('');
        }
    });
});
