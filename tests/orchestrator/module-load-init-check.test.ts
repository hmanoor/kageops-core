/**
 * Module-load init check tests (G5 — deploy-readiness).
 *
 * Driven by a generated app that shipped `new Stripe(process.env.X!)` and a
 * Drizzle/Neon client at module top level — `next build` crashed on a
 * secret-less host (Vercel) because module top-level code runs at build time
 * with no secrets present. The fix is lazy construction behind a function.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    detectModuleLoadInit,
    scanRepoForModuleLoadInit,
    formatModuleLoadInitWarning,
    stripStringsAndComments,
} from '../../src/orchestrator/module-load-init-check';

describe('detectModuleLoadInit()', () => {
    it('flags `new Stripe(process.env...)` at module scope', () => {
        const src = `import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);\n`;
        const findings = detectModuleLoadInit(src, 'lib/stripe.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0].ctor).toBe('Stripe');
        expect(findings[0].line).toBe(2);
        expect(findings[0].file).toBe('lib/stripe.ts');
    });

    it('flags a known factory call (`neon(process.env...)`) at module scope', () => {
        const src = `const sql = neon(process.env.DATABASE_URL!);\n`;
        const findings = detectModuleLoadInit(src, 'lib/db.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0].ctor).toBe('neon');
    });

    it('does NOT flag construction inside a function body (lazy/deferred)', () => {
        const src = [
            'let _s = null;',
            'export function getStripe() {',
            '  return _s ?? (_s = new Stripe(process.env.STRIPE_SECRET_KEY!));',
            '}',
        ].join('\n');
        expect(detectModuleLoadInit(src, 'lib/stripe.ts')).toHaveLength(0);
    });

    it('does NOT flag a module-scope construction that never reads process.env', () => {
        const src = `const m = new Map();\nconst d = new Date();\nconst u = new URL('https://x.test');\n`;
        expect(detectModuleLoadInit(src, 'lib/util.ts')).toHaveLength(0);
    });

    it('does NOT flag the lazy Proxy pattern (new Proxy with no env in args)', () => {
        const src = `export const stripe = new Proxy({}, { get(_t, p) { return getStripe()[p]; } });\n`;
        expect(detectModuleLoadInit(src, 'lib/stripe.ts')).toHaveLength(0);
    });

    it('ignores matches inside strings and comments', () => {
        const src = [
            '// const x = new Stripe(process.env.KEY)',
            'const note = "new Stripe(process.env.KEY)";',
            '/* new Pool(process.env.DATABASE_URL) */',
        ].join('\n');
        expect(detectModuleLoadInit(src, 'lib/x.ts')).toHaveLength(0);
    });

    it('flags a multi-line module-scope construction whose env read is on a later line', () => {
        const src = [
            'const client = new OpenAI({',
            '  apiKey: process.env.OPENAI_API_KEY,',
            '});',
        ].join('\n');
        const findings = detectModuleLoadInit(src, 'lib/ai.ts');
        expect(findings).toHaveLength(1);
        expect(findings[0].ctor).toBe('OpenAI');
    });
});

describe('stripStringsAndComments()', () => {
    it('preserves length and newlines while blanking string/comment contents', () => {
        const src = 'const a = "x{y}"; // {brace}\n';
        const out = stripStringsAndComments(src);
        expect(out.length).toBe(src.length);
        expect(out.split('\n').length).toBe(src.split('\n').length);
        // braces inside the string/comment are gone, so depth counting is safe
        expect(out).not.toContain('{');
    });
});

describe('formatModuleLoadInitWarning()', () => {
    it('returns null when there are no findings', () => {
        expect(formatModuleLoadInitWarning([])).toBeNull();
    });

    it('names each offending file:line', () => {
        const warning = formatModuleLoadInitWarning([
            { file: 'lib/stripe.ts', line: 2, ctor: 'Stripe', snippet: 'const s = new Stripe(process.env.K!)' },
        ]);
        expect(warning).toContain('lib/stripe.ts:2');
        expect(warning).toContain('getStripe()');
    });
});

describe('scanRepoForModuleLoadInit()', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-mli-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('finds offenders across nested source files and skips node_modules + tests', () => {
        fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'lib', 'stripe.ts'),
            'const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);\n',
        );
        // node_modules is skipped
        fs.writeFileSync(
            path.join(dir, 'node_modules', 'pkg', 'index.ts'),
            'const x = new Stripe(process.env.K!);\n',
        );
        // *.test.ts is skipped
        fs.writeFileSync(
            path.join(dir, 'lib', 'stripe.test.ts'),
            'const x = new Stripe(process.env.K!);\n',
        );

        const findings = scanRepoForModuleLoadInit(dir, fs);
        expect(findings).toHaveLength(1);
        expect(findings[0].file).toBe('lib/stripe.ts');
    });

    it('returns no findings for a clean (lazy) repo', () => {
        fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'lib', 'stripe.ts'),
            'export function getStripe() { return new Stripe(process.env.K!); }\n',
        );
        expect(scanRepoForModuleLoadInit(dir, fs)).toHaveLength(0);
    });
});
