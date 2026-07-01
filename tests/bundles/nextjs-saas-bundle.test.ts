/**
 * P2-01 — nextjs-saas bundle skeleton tests.
 *
 * Loads the REAL `bundles/stacks/nextjs-saas/` directory from the repo
 * and asserts:
 *   - The bundle parses against the schema (including the new BundleAcceptance block).
 *   - The match rules score briefs as expected (Next.js / SaaS keywords win;
 *     vanilla-html-style briefs are explicitly rejected via rejectPhrases).
 *   - The new build-tests-preview acceptance kind round-trips through the loader.
 *
 * The prompt bodies are placeholders in PR-A; the real bodies + an
 * inline-equivalent snapshot land in PR-B. This test deliberately does
 * NOT snapshot the placeholder text — it asserts the bundle SHAPE only,
 * so PR-B can swap prompt content without touching this file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';

import * as fs from 'node:fs';
import * as os from 'node:os';

import { loadBundles } from '../../src/bundles/bundle-loader';
import { BundleRegistry } from '../../src/bundles/bundle-registry';
import { matchBundleForBrief, buildBundleKey } from '../../src/bundles/bundle-matcher';
import { copyBundleScaffold } from '../../src/bundles/scaffold-copier';
import { renderBundlePrompt } from '../../src/bundles/bundle-prompt-renderer';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLES_ROOT = path.join(REPO_ROOT, 'bundles');

// Pin a host version inside the bundle's declared range so this suite is
// hermetic across package.json bumps. The bundle's range is ">=0.3.0 <0.5.0".
const TEST_HOST_VERSION = '0.3.0';

describe('nextjs-saas bundle', () => {
    it('loads from disk with no errors', async () => {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        expect(result.errors).toEqual([]);
        const nextjs = result.bundles.find((b) => b.manifest.name === 'nextjs-saas');
        expect(nextjs).toBeDefined();
        expect(nextjs!.manifest.kind).toBe('stack');
    });

    it('declares the build-tests-preview acceptance kind (D-14, D-16)', async () => {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        const nextjs = result.bundles.find((b) => b.manifest.name === 'nextjs-saas');
        expect(nextjs?.manifest.acceptance?.kind).toBe('build-tests-preview');
        expect(nextjs?.manifest.acceptance?.required_test_pass_rate).toBe(1.0);
        expect(nextjs?.manifest.acceptance?.preview_routes).toEqual(['/sign-in', '/sign-up']);
    });

    it('declares the frozen scaffold file list (PR-A.1)', async () => {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        const nextjs = result.bundles.find((b) => b.manifest.name === 'nextjs-saas');
        const files = nextjs?.manifest.scaffold?.files ?? [];
        // Spot-check the critical foundation files; full list is in bundle.yaml.
        expect(files).toContain('scaffold/package.json');
        expect(files).toContain('scaffold/tsconfig.json');
        expect(files).toContain('scaffold/middleware.ts');
        expect(files).toContain('scaffold/app/layout.tsx');
        expect(files).toContain('scaffold/app/page.tsx');
        expect(files).toContain('scaffold/lib/db/schema.ts');
        expect(files).toContain('scaffold/lib/stripe.ts');
        // Every file listed in the manifest must actually exist on disk
        // — otherwise scaffold-copy at project-init time would fail silently.
        const { promises: fsp } = await import('node:fs');
        for (const rel of files) {
            const abs = path.join(nextjs!.directory, rel);
            await expect(fsp.access(abs)).resolves.toBeUndefined();
        }
    });

    it('declares build config consistent with D-07 (build verifier runs npm install/build)', async () => {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        const nextjs = result.bundles.find((b) => b.manifest.name === 'nextjs-saas');
        expect(nextjs?.manifest.build?.skip_npm).toBe(false);
        expect(nextjs?.manifest.build?.framework_label).toContain('Next.js');
    });

    it('exposes forge_create_ui + forge_implement_feature prompt pointers', async () => {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        const nextjs = result.bundles.find((b) => b.manifest.name === 'nextjs-saas');
        expect(nextjs?.manifest.prompts).toBeDefined();
        expect(nextjs?.manifest.prompts!['forge_create_ui']).toMatch(/forge-create-ui/);
        expect(nextjs?.manifest.prompts!['forge_implement_feature']).toMatch(
            /forge-implement-feature/
        );
    });

    it('declares the Vercel deployment block with the 5 required + 3 optional env vars (P2.2-01)', async () => {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        const nextjs = result.bundles.find((b) => b.manifest.name === 'nextjs-saas');
        const dep = nextjs?.manifest.deployment;
        expect(dep?.provider).toBe('vercel');
        expect(dep?.provider_help?.token_url).toBe('https://vercel.com/account/tokens');

        const requiredKeys = (dep?.required_env ?? []).map((e) => e.key);
        expect(requiredKeys).toEqual([
            'DATABASE_URL',
            'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
            'CLERK_SECRET_KEY',
            'STRIPE_SECRET_KEY',
            'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
        ]);

        // Spot-check the help affordances on one secret + one public field.
        const dbUrl = dep?.required_env?.find((e) => e.key === 'DATABASE_URL');
        expect(dbUrl?.secret).toBe(true);
        expect(dbUrl?.dashboard_url).toMatch(/^https:\/\/console\.neon\.tech/);
        expect(dbUrl?.format_regex).toBeDefined();
        expect(() => new RegExp(dbUrl!.format_regex!)).not.toThrow();

        const clerkPub = dep?.required_env?.find(
            (e) => e.key === 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'
        );
        expect(clerkPub?.secret).toBeUndefined();
        expect(clerkPub?.format_hint).toBe('pk_test_...');

        // Optional list: Stripe webhook secret + the membership Price + app URL
        // (the working payment vertical's runtime config).
        expect(dep?.optional_env?.map((e) => e.key)).toEqual([
            'STRIPE_WEBHOOK_SECRET',
            'STRIPE_PRICE_ID',
            'NEXT_PUBLIC_APP_URL',
        ]);
    });
});

describe('nextjs-saas bundle — matcher behaviour (P2-01 / D-00..D-06)', () => {
    async function makeRegistry(): Promise<BundleRegistry> {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        return new BundleRegistry(result);
    }

    it('matches a Next.js SaaS brief over vanilla-html', async () => {
        const registry = await makeRegistry();
        const hit = matchBundleForBrief({
            text: 'Build a paywalled PDF redaction SaaS with Stripe checkout, user accounts via Clerk, and a Next.js 16 App Router frontend backed by Neon Postgres.',
            registry,
        });
        expect(hit).not.toBeNull();
        expect(buildBundleKey(hit!.bundle)).toBe('stack::nextjs-saas');
    });

    it('matches generic "web app with database and payments" to nextjs-saas', async () => {
        const registry = await makeRegistry();
        const hit = matchBundleForBrief({
            text: 'A web app with database, payments, and user accounts.',
            registry,
        });
        expect(hit).not.toBeNull();
        expect(buildBundleKey(hit!.bundle)).toBe('stack::nextjs-saas');
    });

    it('rejects a vanilla-html-style brief from nextjs-saas via rejectPhrases', async () => {
        const registry = await makeRegistry();
        const hit = matchBundleForBrief({
            text: 'A pure HTML static landing page with no build step and no framework.',
            registry,
        });
        // Either matches vanilla-html or nothing — explicitly NOT nextjs-saas.
        if (hit !== null) {
            expect(buildBundleKey(hit.bundle)).not.toBe('stack::nextjs-saas');
        }
    });

    it('rejects a React Native / Expo brief from nextjs-saas', async () => {
        const registry = await makeRegistry();
        const hit = matchBundleForBrief({
            text: 'Build an Expo mobile app with React Native for iOS and Android.',
            registry,
        });
        if (hit !== null) {
            expect(buildBundleKey(hit.bundle)).not.toBe('stack::nextjs-saas');
        }
    });

    it('rejects a FastAPI / Python backend brief from nextjs-saas', async () => {
        const registry = await makeRegistry();
        const hit = matchBundleForBrief({
            text: 'A FastAPI Python backend with a data pipeline. No frontend framework.',
            registry,
        });
        if (hit !== null) {
            expect(buildBundleKey(hit.bundle)).not.toBe('stack::nextjs-saas');
        }
    });
});

describe('nextjs-saas bundle — scaffold + prompt integration (PR-B / P2-02)', () => {
    let workDir: string;

    beforeEach(() => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-nextjs-saas-'));
    });

    afterEach(() => {
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    it('copyBundleScaffold copies the full Next.js scaffold into a workspace, applying {{title}}/{{description}} substitutions', async () => {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        const nextjs = result.bundles.find((b) => b.manifest.name === 'nextjs-saas');
        expect(nextjs).toBeDefined();

        const copyResult = await copyBundleScaffold({
            bundle: nextjs!,
            destDir: workDir,
            vars: { title: 'PDF Redactor', description: 'Paywalled PDF redaction SaaS' },
        });

        // Every declared scaffold file landed in the workspace
        expect(copyResult.filesCopied.length).toBeGreaterThanOrEqual(20);
        expect(copyResult.filesSkipped).toEqual([]);

        // Foundation files exist at the workspace root, without the scaffold/ prefix
        expect(fs.existsSync(path.join(workDir, 'package.json'))).toBe(true);
        expect(fs.existsSync(path.join(workDir, 'tsconfig.json'))).toBe(true);
        expect(fs.existsSync(path.join(workDir, 'middleware.ts'))).toBe(true);
        expect(fs.existsSync(path.join(workDir, 'app', 'layout.tsx'))).toBe(true);
        expect(fs.existsSync(path.join(workDir, 'app', 'page.tsx'))).toBe(true);
        expect(fs.existsSync(path.join(workDir, 'lib', 'db', 'schema.ts'))).toBe(true);

        // Substitution applied in README + layout + page
        const readme = fs.readFileSync(path.join(workDir, 'README.md'), 'utf8');
        expect(readme).toContain('PDF Redactor');
        expect(readme).not.toContain('{{title}}');

        const layout = fs.readFileSync(path.join(workDir, 'app', 'layout.tsx'), 'utf8');
        expect(layout).toContain('PDF Redactor');
        expect(layout).toContain('Paywalled PDF redaction SaaS');
        expect(layout).not.toContain('{{title}}');
        expect(layout).not.toContain('{{description}}');

        // App Router catch-all routes copied successfully (the path-traversal
        // regression from PR-A.1 lived here)
        expect(
            fs.existsSync(
                path.join(workDir, 'app', '(auth)', 'sign-in', '[[...sign-in]]', 'page.tsx')
            )
        ).toBe(true);
    });

    it('renderBundlePrompt produces the forge_create_ui prompt with vars substituted', async () => {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        const nextjs = result.bundles.find((b) => b.manifest.name === 'nextjs-saas');
        const prompt = await renderBundlePrompt(nextjs!, {
            promptKey: 'forge_create_ui',
            vars: { title: 'PDF Redactor', description: 'Paywalled PDF redaction SaaS' },
        });
        expect(prompt).toContain('PDF Redactor');
        expect(prompt).toContain('Paywalled PDF redaction SaaS');
        expect(prompt).not.toContain('{{title}}');
        // Confirm the prompt is the REAL content (PR-B), not the PR-A placeholder.
        expect(prompt).toContain('THE SCAFFOLD ALREADY EXISTS');
        expect(prompt).toContain('Drizzle');
        expect(prompt).toContain('Server Components');
    });

    it('renderBundlePrompt produces the forge_implement_feature prompt for revisions', async () => {
        const result = await loadBundles(BUNDLES_ROOT, TEST_HOST_VERSION);
        const nextjs = result.bundles.find((b) => b.manifest.name === 'nextjs-saas');
        const prompt = await renderBundlePrompt(nextjs!, {
            promptKey: 'forge_implement_feature',
            vars: { title: 'Add billing page', description: 'Show current subscription tier' },
        });
        expect(prompt).toContain('Add billing page');
        expect(prompt).toContain('Show current subscription tier');
        // Confirm it's the REAL content, not the placeholder
        expect(prompt).toContain('EDIT-IN-PLACE RULE');
        expect(prompt).toContain('Server Actions');
        expect(prompt).toContain('revalidatePath');
    });
});
