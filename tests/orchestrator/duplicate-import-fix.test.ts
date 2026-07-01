/**
 * BPF-17 — duplicate-import dedup (deterministic pre-build source repair).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { dedupeImportsInSource, autofixRepoDuplicateImports } from '../../src/orchestrator/duplicate-import-fix';

describe('dedupeImportsInSource', () => {
    it('collapses N identical named imports to one (the observed ClubHubOSS case)', () => {
        const src = [
            `import { eq } from 'drizzle-orm';`,
            `import { eq } from 'drizzle-orm';`,
            `import { eq } from 'drizzle-orm';`,
            ``,
            `export const x = eq;`,
        ].join('\n');
        const out = dedupeImportsInSource(src);
        expect(out).not.toBeNull();
        // exactly one `eq` import remains
        expect((out!.match(/import \{ eq \} from 'drizzle-orm';/g) ?? []).length).toBe(1);
        expect(out).toContain('export const x = eq;');
    });

    it('merges overlapping named imports from the same module (unions specifiers)', () => {
        const src = [
            `import { eq } from 'drizzle-orm';`,
            `import { eq, and } from 'drizzle-orm';`,
            `import { sql } from 'drizzle-orm';`,
        ].join('\n');
        const out = dedupeImportsInSource(src);
        expect(out).not.toBeNull();
        // one merged statement, union of {eq, and, sql}, first-seen order
        const importLines = (out!.match(/^import .*drizzle-orm.*;$/gm) ?? []);
        expect(importLines.length).toBe(1);
        expect(importLines[0]).toBe(`import { eq, and, sql } from 'drizzle-orm';`);
    });

    it('keeps value and type-only imports as SEPARATE merged statements', () => {
        const src = [
            `import { eq } from 'drizzle-orm';`,
            `import type { SQL } from 'drizzle-orm';`,
            `import { and } from 'drizzle-orm';`,
            `import type { Table } from 'drizzle-orm';`,
        ].join('\n');
        const out = dedupeImportsInSource(src);
        expect(out).not.toBeNull();
        expect(out).toContain(`import { eq, and } from 'drizzle-orm';`);
        expect(out).toContain(`import type { SQL, Table } from 'drizzle-orm';`);
    });

    it('dedupes exact-duplicate side-effect imports but does not merge them', () => {
        const src = [`import './globals.css';`, `import './globals.css';`].join('\n');
        const out = dedupeImportsInSource(src);
        expect(out).not.toBeNull();
        expect((out!.match(/import '\.\/globals\.css';/g) ?? []).length).toBe(1);
    });

    it('leaves distinct imports from different modules untouched', () => {
        const src = [
            `import { eq } from 'drizzle-orm';`,
            `import { z } from 'zod';`,
            `import { auth } from '@clerk/nextjs/server';`,
        ].join('\n');
        expect(dedupeImportsInSource(src)).toBeNull();
    });

    it('returns null for a single clean import (no churn)', () => {
        expect(dedupeImportsInSource(`import { eq, and } from 'drizzle-orm';\n`)).toBeNull();
    });

    it('does not touch default or namespace imports (merge-unsafe) beyond exact dups', () => {
        const src = [
            `import Stripe from 'stripe';`,
            `import * as React from 'react';`,
            `import { useState } from 'react';`,
        ].join('\n');
        // No exact dups, no pure-named merge opportunity (react named is single) → unchanged.
        expect(dedupeImportsInSource(src)).toBeNull();
    });

    it('ignores import-like text inside strings/comments', () => {
        const src = [
            `import { eq } from 'drizzle-orm';`,
            `// import { eq } from 'drizzle-orm';`,
            `const s = "import { eq } from 'drizzle-orm';";`,
        ].join('\n');
        // Only the one real import — nothing to dedupe.
        expect(dedupeImportsInSource(src)).toBeNull();
    });

    it('does not confuse dynamic import() or import.meta with a statement', () => {
        const src = [
            `import { eq } from 'drizzle-orm';`,
            `const m = await import('./x');`,
            `const u = import.meta.url;`,
        ].join('\n');
        expect(dedupeImportsInSource(src)).toBeNull();
    });
});

describe('autofixRepoDuplicateImports', () => {
    let repo: string;
    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-bpf17-'));
    });
    afterEach(() => {
        fs.rmSync(repo, { recursive: true, force: true });
    });

    it('rewrites files with duplicate imports and leaves clean files byte-identical', () => {
        const dirty = path.join(repo, 'app', 'api', 'x', 'route.ts');
        fs.mkdirSync(path.dirname(dirty), { recursive: true });
        fs.writeFileSync(
            dirty,
            `import { eq } from 'drizzle-orm';\nimport { eq } from 'drizzle-orm';\nexport const GET = () => eq;\n`,
            'utf-8',
        );
        const clean = path.join(repo, 'lib', 'util.ts');
        fs.mkdirSync(path.dirname(clean), { recursive: true });
        const cleanBody = `import { z } from 'zod';\nexport const s = z;\n`;
        fs.writeFileSync(clean, cleanBody, 'utf-8');

        const result = autofixRepoDuplicateImports(repo, fs);

        expect(result.filesFixed).toContain('app/api/x/route.ts');
        expect((fs.readFileSync(dirty, 'utf-8').match(/import \{ eq \}/g) ?? []).length).toBe(1);
        expect(fs.readFileSync(clean, 'utf-8')).toBe(cleanBody);
    });
});
