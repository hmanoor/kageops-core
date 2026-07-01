/**
 * G7 — ship the deploy runbook into the generated app.
 *
 * The biggest gap the MCC build exposed: KageOps generated an app but gave the
 * operator no path to deploy it. The cheap, high-value fix is to template the
 * proven deploy runbook (SETUP.md + AGENTS.md) into the nextjs-saas scaffold so
 * every generated app ships with ordered, stack-accurate deploy instructions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadBundles } from '../../src/bundles/bundle-loader';
import { copyBundleScaffold } from '../../src/bundles/scaffold-copier';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLES_ROOT = path.join(REPO_ROOT, 'bundles');
const BUNDLE = path.join(BUNDLES_ROOT, 'stacks', 'nextjs-saas');
const TEST_HOST_VERSION = '0.3.0';

function readScaffold(rel: string): string {
    return fs.readFileSync(path.join(BUNDLE, 'scaffold', rel), 'utf-8');
}

describe('G7 — nextjs-saas deploy runbook templates', () => {
    it('SETUP.md is stack-accurate (Clerk + Neon + Stripe) with the real webhook path', () => {
        const setup = readScaffold('SETUP.md');
        expect(setup).toContain('Clerk');
        expect(setup).toContain('Neon');
        expect(setup).toContain('Vercel');
        // the scaffold's actual webhook route — NOT the MCC /api/webhooks/stripe
        expect(setup).toContain('/api/stripe/webhook');
        // the proven gotchas carry over
        expect(setup).toContain('BLOCKED');
        expect(setup).toContain('db:push');
        expect(setup).toMatch(/whsec/);
    });

    it('AGENTS.md lists the non-negotiable deploy gotchas', () => {
        const agents = readScaffold('AGENTS.md');
        expect(agents).toContain('No SDK client at module load');
        expect(agents).toContain('authoritative payment signal');
        expect(agents).toContain('SETUP.md');
    });

    it('declares both runbooks in the bundle scaffold manifest', () => {
        const manifest = fs.readFileSync(path.join(BUNDLE, 'bundle.yaml'), 'utf-8');
        expect(manifest).toContain('scaffold/SETUP.md');
        expect(manifest).toContain('scaffold/AGENTS.md');
    });

    describe('copyBundleScaffold ships them into a workspace', () => {
        let workDir: string;
        beforeEach(() => {
            workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-g7-'));
        });
        afterEach(() => {
            fs.rmSync(workDir, { recursive: true, force: true });
        });

        it('copies SETUP.md + AGENTS.md with {{title}} substituted', async () => {
            const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
            const nextjs = result.bundles.find((b) => b.manifest.name === 'nextjs-saas');
            expect(nextjs).toBeDefined();

            const copy = await copyBundleScaffold({
                bundle: nextjs!,
                destDir: workDir,
                vars: { title: 'Chess Club', description: 'Membership site' },
            });
            expect(copy.filesCopied).toContain('SETUP.md');
            expect(copy.filesCopied).toContain('AGENTS.md');

            const setup = fs.readFileSync(path.join(workDir, 'SETUP.md'), 'utf-8');
            expect(setup).toContain('Chess Club');
            expect(setup).not.toContain('{{title}}');

            const agents = fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf-8');
            expect(agents).toContain('Chess Club');
            expect(agents).not.toContain('{{title}}');
        });
    });
});
