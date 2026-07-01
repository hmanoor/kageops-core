/**
 * Payment-vertical (Phase 2) — the nextjs-saas scaffold ships a working,
 * parameterized membership/payment slice so Forge customizes rather than
 * authors the money path. These tests lock in the files + manifest + prompt and
 * cross-validate the scaffold against KageOps's OWN gates (G3 no-orphaned-half,
 * G5 no-module-load-init) — i.e. the shipped scaffold passes the very checks a
 * generated app must pass.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { scanRepoForModuleLoadInit } from '../../src/orchestrator/module-load-init-check';
import { scanRepoForOrphanedHalves } from '../../src/orchestrator/vertical-slice-check';

const BUNDLE = path.resolve(__dirname, '..', '..', 'bundles', 'stacks', 'nextjs-saas');
const SCAFFOLD = path.join(BUNDLE, 'scaffold');

const VERTICAL_FILES = [
    'lib/db/schema.ts',
    'lib/payments/checkout-params.ts',
    'lib/payments/checkout.ts',
    'lib/payments/webhook-handlers.ts',
    'lib/payments/membership-repo.ts',
    'app/membership/page.tsx',
    'app/(protected)/members/page.tsx',
    'app/api/stripe/webhook/route.ts',
    'tests/membership.test.ts',
];

describe('payment vertical — files + manifest + prompt', () => {
    it('ships every vertical file in the scaffold', () => {
        for (const rel of VERTICAL_FILES) {
            expect(fs.existsSync(path.join(SCAFFOLD, rel)), rel).toBe(true);
        }
    });

    it('declares the vertical files + new files in the bundle manifest', () => {
        const manifest = fs.readFileSync(path.join(BUNDLE, 'bundle.yaml'), 'utf-8');
        for (const rel of ['lib/payments/checkout.ts', 'lib/payments/webhook-handlers.ts', 'app/membership/page.tsx', 'tests/membership.test.ts']) {
            expect(manifest, rel).toContain(`scaffold/${rel}`);
        }
        // the protected members page needs quoting due to the (group) segment
        expect(manifest).toContain('scaffold/app/(protected)/members/page.tsx');
        // runtime config for the slice
        expect(manifest).toContain('STRIPE_PRICE_ID');
        expect(manifest).toContain('NEXT_PUBLIC_APP_URL');
    });

    it('schema ships the memberships table with the access flag', () => {
        const schema = fs.readFileSync(path.join(SCAFFOLD, 'lib', 'db', 'schema.ts'), 'utf-8');
        expect(schema).toContain('memberships');
        expect(schema).toContain('clerk_id');
        expect(schema).toContain('status');
    });

    it('the create-ui prompt tells Forge to customise (not rebuild) the wired slice', () => {
        const prompt = fs.readFileSync(path.join(BUNDLE, 'prompts', 'forge-create-ui.md'), 'utf-8');
        expect(prompt).toContain('PAYMENT SLICE IS ALREADY WIRED');
        expect(prompt).toContain('do NOT rebuild');
    });
});

describe('the shipped scaffold passes KageOps own gates', () => {
    it('G5: no module-load-time SDK construction reading process.env', () => {
        expect(scanRepoForModuleLoadInit(SCAFFOLD, fs)).toEqual([]);
    });

    it('G3: no orphaned half-feature — both checkout halves are present', () => {
        // webhook-handlers.ts handles checkout.session.completed AND checkout.ts
        // calls getStripe().checkout.sessions.create — receiver + sender wired.
        expect(scanRepoForOrphanedHalves(SCAFFOLD, fs)).toEqual([]);
    });
});
