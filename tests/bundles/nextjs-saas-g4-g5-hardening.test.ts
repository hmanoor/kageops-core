/**
 * G4 + G5 hardening tests for the nextjs-saas bundle.
 *
 * Locks in the fixes for two delivery gaps the MCC benchmark exposed:
 *   G4 — generated test suites must run green: the scaffold ships a jsdom
 *        setup file (polyfills) wired into vitest, and the Forge prompts warn
 *        about the exact vitest pitfalls we hit (alias require, jsdom gaps,
 *        over-broad matchers, userEvent.upload accept).
 *   G5 — deploy-readiness: no SDK client is constructed at module load. The
 *        scaffold's stripe + db clients are lazy, and the prompts forbid eager
 *        module-scope construction.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { detectModuleLoadInit } from '../../src/orchestrator/module-load-init-check';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE = path.join(REPO_ROOT, 'bundles', 'stacks', 'nextjs-saas');
const SCAFFOLD = path.join(BUNDLE, 'scaffold');

function read(rel: string): string {
    return fs.readFileSync(path.join(BUNDLE, rel), 'utf-8');
}

describe('G4 — generated tests must run green (scaffold)', () => {
    it('ships a jsdom setup file with the polyfills we needed', () => {
        const setup = fs.readFileSync(path.join(SCAFFOLD, 'tests', 'setup.ts'), 'utf-8');
        expect(setup).toContain('createObjectURL');
        expect(setup).toContain('matchMedia');
        expect(setup).toContain('ResizeObserver');
    });

    it('wires the setup file + clearMocks into vitest.config.ts', () => {
        const cfg = fs.readFileSync(path.join(SCAFFOLD, 'vitest.config.ts'), 'utf-8');
        expect(cfg).toContain('./tests/setup.ts');
        expect(cfg).toContain('clearMocks');
    });

    it('declares the setup file in the bundle scaffold manifest so it is copied', () => {
        const manifest = fs.readFileSync(path.join(BUNDLE, 'bundle.yaml'), 'utf-8');
        expect(manifest).toContain('scaffold/tests/setup.ts');
    });

    it('both Forge prompts warn about the vitest pitfalls', () => {
        for (const rel of ['prompts/forge-create-ui.md', 'prompts/forge-implement-feature.md']) {
            const prompt = read(rel);
            expect(prompt, rel).toContain('GENERATED TESTS MUST PASS');
            // alias-require pitfall
            expect(prompt, rel).toMatch(/require\(["'`]@\//);
            // jsdom polyfill awareness
            expect(prompt, rel).toContain('tests/setup.ts');
            // over-broad matcher pitfall
            expect(prompt, rel).toContain('getByRole');
        }
    });
});

describe('G5 — deploy-readiness (no module-load SDK init)', () => {
    it('scaffold lib/stripe.ts constructs lazily (no module-load init)', () => {
        const src = fs.readFileSync(path.join(SCAFFOLD, 'lib', 'stripe.ts'), 'utf-8');
        expect(src).toContain('getStripe');
        expect(detectModuleLoadInit(src, 'lib/stripe.ts')).toHaveLength(0);
    });

    it('scaffold lib/db/index.ts constructs lazily (no module-load init)', () => {
        const src = fs.readFileSync(path.join(SCAFFOLD, 'lib', 'db', 'index.ts'), 'utf-8');
        expect(src).toContain('getDb');
        expect(detectModuleLoadInit(src, 'lib/db/index.ts')).toHaveLength(0);
    });

    it('both Forge prompts forbid eager module-scope SDK construction', () => {
        for (const rel of ['prompts/forge-create-ui.md', 'prompts/forge-implement-feature.md']) {
            const prompt = read(rel);
            expect(prompt, rel).toContain('LAZY SDK INIT');
            expect(prompt, rel).toContain('getStripe()');
        }
    });
});
