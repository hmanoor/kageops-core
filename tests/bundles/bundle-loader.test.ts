/**
 * P1-10 — Bundle loader + registry tests.
 *
 * Uses real temp dirs (mkdtempSync) so loader I/O is exercised
 * end-to-end. Matches the pattern used by tests/agents/revision-staging.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    loadBundleFromDirectory,
    loadBundles,
    resolveBundlesRoot,
} from '../../src/bundles/bundle-loader';
import { BundleRegistry } from '../../src/bundles/bundle-registry';

// ── Tempdir setup ──

let bundlesRoot: string;

beforeEach(() => {
    bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kageops-bundles-'));
    for (const kind of ['stacks', 'capabilities', 'deployers']) {
        fs.mkdirSync(path.join(bundlesRoot, kind), { recursive: true });
    }
});

afterEach(() => {
    fs.rmSync(bundlesRoot, { recursive: true, force: true });
    delete process.env['KAGEOPS_BUNDLES_DIR'];
});

// ── Fixture helpers ──

function writeBundle(
    kindDir: 'stacks' | 'capabilities' | 'deployers',
    name: string,
    yaml: string
): string {
    const dir = path.join(bundlesRoot, kindDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bundle.yaml'), yaml);
    return dir;
}

function minimalStackYaml(name: string): string {
    return `schemaVersion: 1
name: ${name}
kind: stack
version: "1.0.0"
description: A minimal stack for tests.
`;
}

const MINIMAL_STACK_YAML = minimalStackYaml('minimal-stack');

// ── resolveBundlesRoot ──

describe('resolveBundlesRoot()', () => {
    it('returns <repoRoot>/bundles by default', () => {
        const root = resolveBundlesRoot('/some/repo');
        expect(root).toBe(path.resolve('/some/repo', 'bundles'));
    });

    it('honours KAGEOPS_BUNDLES_DIR override', () => {
        process.env['KAGEOPS_BUNDLES_DIR'] = bundlesRoot;
        const root = resolveBundlesRoot('/ignored');
        expect(root).toBe(path.resolve(bundlesRoot));
    });

    it('ignores empty KAGEOPS_BUNDLES_DIR', () => {
        process.env['KAGEOPS_BUNDLES_DIR'] = '';
        const root = resolveBundlesRoot('/repo');
        expect(root).toBe(path.resolve('/repo', 'bundles'));
    });
});

// ── loadBundles — happy paths ──

describe('loadBundles() — happy paths', () => {
    it('returns empty result when bundles root does not exist', async () => {
        const result = await loadBundles(path.join(bundlesRoot, 'does-not-exist'));
        expect(result.bundles).toEqual([]);
        expect(result.errors).toEqual([]);
    });

    it('returns empty result when kind directories are empty', async () => {
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors).toEqual([]);
    });

    it('loads a single minimal stack bundle', async () => {
        writeBundle('stacks', 'minimal-stack', MINIMAL_STACK_YAML);
        const result = await loadBundles(bundlesRoot);
        expect(result.errors).toEqual([]);
        expect(result.bundles).toHaveLength(1);
        expect(result.bundles[0]?.manifest.name).toBe('minimal-stack');
        expect(result.bundles[0]?.manifest.kind).toBe('stack');
        expect(result.bundles[0]?.directory).toBe(
            path.resolve(bundlesRoot, 'stacks', 'minimal-stack')
        );
    });

    it('loads bundles across all three kind directories', async () => {
        writeBundle('stacks', 'my-stack', minimalStackYaml('my-stack'));
        writeBundle(
            'capabilities',
            'my-cap',
            `schemaVersion: 1
name: my-cap
kind: capability
version: "0.1.0"
description: cap test`
        );
        writeBundle(
            'deployers',
            'my-deployer',
            `schemaVersion: 1
name: my-deployer
kind: deployer
version: "0.1.0"
description: deployer test`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.errors).toEqual([]);
        expect(result.bundles).toHaveLength(3);
        const names = result.bundles.map((b) => b.manifest.name).sort();
        expect(names).toEqual(['my-cap', 'my-deployer', 'my-stack']);
    });

    it('parses optional sub-blocks correctly', async () => {
        writeBundle(
            'stacks',
            'full-stack',
            `schemaVersion: 1
name: full-stack
kind: stack
version: "1.2.3"
kageops_version: ">=0.2.0 <0.3.0"
description: |
  Multi-line description
  with several lines.
match:
  phrases: ["foo", "bar"]
  tags: [html, css]
  rejectPhrases: ["react"]
scaffold:
  files:
    - index.html
    - styles.css
prompts:
  forge_create_ui: prompts/forge-create-ui.md
build:
  skip_npm: true
  acceptance_required_ids: extract_from_description
  framework_label: "Static HTML"
checks:
  vigil_module: checks/static-html-checks.ts
`
        );
        // Pin an explicit host version so this test is hermetic across
        // package.json version bumps — the fixture's range is fixed.
        const result = await loadBundles(bundlesRoot, '0.2.5');
        expect(result.errors).toEqual([]);
        const m = result.bundles[0]?.manifest;
        expect(m?.kageops_version).toBe('>=0.2.0 <0.3.0');
        expect(m?.match?.phrases).toEqual(['foo', 'bar']);
        expect(m?.match?.tags).toEqual(['html', 'css']);
        expect(m?.match?.rejectPhrases).toEqual(['react']);
        expect(m?.scaffold?.files).toEqual(['index.html', 'styles.css']);
        expect(m?.prompts?.['forge_create_ui']).toBe('prompts/forge-create-ui.md');
        expect(m?.build?.skip_npm).toBe(true);
        expect(m?.build?.framework_label).toBe('Static HTML');
        expect(m?.checks?.vigil_module).toBe('checks/static-html-checks.ts');
    });

    it('skips non-directory entries inside kind directories', async () => {
        writeBundle('stacks', 'real-bundle', minimalStackYaml('real-bundle'));
        fs.writeFileSync(path.join(bundlesRoot, 'stacks', 'stray.txt'), 'not a bundle');
        const result = await loadBundles(bundlesRoot);
        expect(result.errors).toEqual([]);
        expect(result.bundles).toHaveLength(1);
        expect(result.bundles[0]?.manifest.name).toBe('real-bundle');
    });
});

// ── loadBundles — error paths ──

describe('loadBundles() — error paths', () => {
    it('reports directories with no bundle.yaml as errors', async () => {
        const dir = path.join(bundlesRoot, 'stacks', 'empty-bundle');
        fs.mkdirSync(dir, { recursive: true });
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.reason).toMatch(/missing bundle\.yaml/);
        expect(result.errors[0]?.directory).toBe(dir);
    });

    it('reports malformed YAML as an error (loader does not throw)', async () => {
        writeBundle('stacks', 'bad-yaml', 'name: : invalid:\n  yaml [\nthis');
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.reason).toMatch(/YAML parse error/);
    });

    it('rejects manifest with wrong schemaVersion', async () => {
        writeBundle(
            'stacks',
            'wrong-version',
            `schemaVersion: 99
name: x
kind: stack
version: "1.0.0"
description: test`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.errors[0]?.reason).toMatch(/schemaVersion must be 1/);
    });

    it('rejects non-kebab-case names', async () => {
        writeBundle(
            'stacks',
            'BadName',
            `schemaVersion: 1
name: BadName
kind: stack
version: "1.0.0"
description: test`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.errors[0]?.reason).toMatch(/kebab-case/);
    });

    it('rejects kind mismatch between manifest and directory', async () => {
        writeBundle(
            'stacks',
            'cap-in-stack-dir',
            `schemaVersion: 1
name: cap-in-stack-dir
kind: capability
version: "1.0.0"
description: test`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.errors[0]?.reason).toMatch(/does not match directory/);
    });

    it('rejects invalid version strings', async () => {
        writeBundle(
            'stacks',
            'bad-version',
            `schemaVersion: 1
name: bad-version
kind: stack
version: "v1"
description: test`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.errors[0]?.reason).toMatch(/semver/);
    });

    it('rejects path traversal in scaffold.files', async () => {
        writeBundle(
            'stacks',
            'traversal',
            `schemaVersion: 1
name: traversal
kind: stack
version: "1.0.0"
description: test
scaffold:
  files:
    - ../../etc/passwd`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.errors[0]?.reason).toMatch(/path traversal/);
    });

    it('allows ".." inside a segment (e.g. Next.js App Router catch-all "[[...sign-in]]")', async () => {
        // The path-traversal check must be SEGMENT-aware — ".." as a substring
        // of a real path segment (a catch-all route, or just any file like "foo..bar.ts")
        // is legitimate; only "..".split(/[/\\]/) being the WHOLE segment counts as
        // traversal. Regression for the App Router scaffold patterns shipped in PR-A.1.
        writeBundle(
            'stacks',
            'catchall',
            `schemaVersion: 1
name: catchall
kind: stack
version: "1.0.0"
description: test
scaffold:
  files:
    - "scaffold/app/(auth)/sign-in/[[...sign-in]]/page.tsx"
    - "scaffold/foo..bar.ts"`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.errors).toEqual([]);
        expect(result.bundles[0]?.manifest.scaffold?.files).toContain(
            'scaffold/app/(auth)/sign-in/[[...sign-in]]/page.tsx'
        );
    });

    it('rejects absolute paths in prompts', async () => {
        const absPath = process.platform === 'win32' ? 'C:/evil.md' : '/etc/evil.md';
        writeBundle(
            'stacks',
            'abs-prompt',
            `schemaVersion: 1
name: abs-prompt
kind: stack
version: "1.0.0"
description: test
prompts:
  forge_create_ui: "${absPath}"`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.errors[0]?.reason).toMatch(/relative, non-traversing/);
    });

    it('rejects invalid build.acceptance_required_ids enum value', async () => {
        writeBundle(
            'stacks',
            'bad-build',
            `schemaVersion: 1
name: bad-build
kind: stack
version: "1.0.0"
description: test
build:
  acceptance_required_ids: maybe`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.errors[0]?.reason).toMatch(/acceptance_required_ids/);
    });

    it('does NOT take the whole load down if one bundle is broken', async () => {
        writeBundle('stacks', 'good', minimalStackYaml('good'));
        writeBundle('stacks', 'broken', 'not: valid: yaml: at: all: [[[');
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toHaveLength(1);
        expect(result.bundles[0]?.manifest.name).toBe('good');
        expect(result.errors).toHaveLength(1);
    });
});

// ── P1-13: host-version compat at load time ──

describe('loadBundles() — P1-13 kageops_version compat', () => {
    it('loads a bundle whose kageops_version range covers the host', async () => {
        writeBundle(
            'stacks',
            'compat-ok',
            `schemaVersion: 1
name: compat-ok
kind: stack
version: "1.0.0"
kageops_version: ">=0.2.0 <0.4.0"
description: test`
        );
        const result = await loadBundles(bundlesRoot, '0.2.5');
        expect(result.errors).toEqual([]);
        expect(result.bundles).toHaveLength(1);
    });

    it('skips a bundle whose kageops_version range excludes the host', async () => {
        writeBundle(
            'stacks',
            'too-new',
            `schemaVersion: 1
name: too-new
kind: stack
version: "1.0.0"
kageops_version: ">=0.5.0"
description: test`
        );
        const result = await loadBundles(bundlesRoot, '0.2.5');
        expect(result.bundles).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.reason).toMatch(/bundle requires host kageops_version >=0\.5\.0/);
    });

    it('treats missing kageops_version as permissive (loads on any host)', async () => {
        writeBundle(
            'stacks',
            'no-constraint',
            `schemaVersion: 1
name: no-constraint
kind: stack
version: "1.0.0"
description: test`
        );
        const result = await loadBundles(bundlesRoot, '99.99.99');
        expect(result.errors).toEqual([]);
        expect(result.bundles).toHaveLength(1);
    });

    it('rejects a bundle whose kageops_version is a malformed range', async () => {
        writeBundle(
            'stacks',
            'bad-range',
            `schemaVersion: 1
name: bad-range
kind: stack
version: "1.0.0"
kageops_version: "definitely-not-semver"
description: test`
        );
        const result = await loadBundles(bundlesRoot, '0.2.5');
        expect(result.bundles).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.reason).toMatch(/not a valid semver range/);
    });

    it('accepts prerelease host versions (e.g. 0.2.0-beta.6)', async () => {
        writeBundle(
            'stacks',
            'beta-ok',
            `schemaVersion: 1
name: beta-ok
kind: stack
version: "1.0.0"
kageops_version: ">=0.2.0 <0.3.0"
description: test`
        );
        const result = await loadBundles(bundlesRoot, '0.2.0-beta.6');
        expect(result.errors).toEqual([]);
        expect(result.bundles).toHaveLength(1);
    });
});

// ── loadBundleFromDirectory ──

describe('loadBundleFromDirectory() — single-bundle entry point', () => {
    it('loads one bundle when called directly', async () => {
        const dir = writeBundle('stacks', 'direct-load', minimalStackYaml('direct-load'));
        const result = await loadBundleFromDirectory(dir, 'stack');
        expect('manifest' in result).toBe(true);
        if ('manifest' in result) {
            expect(result.manifest.name).toBe('direct-load');
        }
    });

    it('returns an error when expectedKind mismatches manifest', async () => {
        const dir = writeBundle('stacks', 'kind-mismatch', minimalStackYaml('kind-mismatch'));
        const result = await loadBundleFromDirectory(dir, 'capability');
        expect('manifest' in result).toBe(false);
        if (!('manifest' in result)) {
            expect(result.reason).toMatch(/does not match directory.*capability/);
        }
    });
});

// ── BundleRegistry ──

describe('BundleRegistry', () => {
    it('is empty when loader returned no bundles', () => {
        const registry = new BundleRegistry({ bundles: [], errors: [] });
        expect(registry.size()).toBe(0);
        expect(registry.all()).toEqual([]);
        expect(registry.ofKind('stack')).toEqual([]);
        expect(registry.get('stack', 'anything')).toBeUndefined();
        expect(registry.has('stack', 'anything')).toBe(false);
    });

    it('indexes bundles by (kind, name)', async () => {
        writeBundle('stacks', 'alpha', minimalStackYaml('alpha'));
        writeBundle(
            'stacks',
            'beta',
            `schemaVersion: 1
name: beta
kind: stack
version: "1.0.0"
description: beta test`
        );
        writeBundle(
            'capabilities',
            'gamma',
            `schemaVersion: 1
name: gamma
kind: capability
version: "1.0.0"
description: gamma test`
        );
        const result = await loadBundles(bundlesRoot);
        const registry = new BundleRegistry(result);

        expect(registry.size()).toBe(3);
        expect(registry.get('stack', 'alpha')?.manifest.name).toBe('alpha');
        expect(registry.get('stack', 'beta')?.manifest.name).toBe('beta');
        expect(registry.get('capability', 'gamma')?.manifest.name).toBe('gamma');

        // Cross-kind lookups don't bleed
        expect(registry.get('capability', 'alpha')).toBeUndefined();
        expect(registry.has('stack', 'gamma')).toBe(false);

        expect(registry.ofKind('stack').map((b) => b.manifest.name).sort()).toEqual([
            'alpha',
            'beta',
        ]);
        expect(registry.ofKind('capability')).toHaveLength(1);
        expect(registry.ofKind('deployer')).toEqual([]);
    });
});

// ── BundleAcceptance block (P2-01 / D-14..D-16) ──

describe('loadBundles() — acceptance block validation', () => {
    function writeAcceptanceBundle(acceptanceYaml: string): string {
        return writeBundle(
            'stacks',
            'with-acceptance',
            `${minimalStackYaml('with-acceptance')}${acceptanceYaml}`
        );
    }

    it('omitting acceptance is allowed (back-compat with vanilla-html-shaped bundles)', async () => {
        writeBundle('stacks', 'no-acceptance', minimalStackYaml('no-acceptance'));
        const result = await loadBundles(bundlesRoot);
        expect(result.errors).toEqual([]);
        expect(result.bundles[0]?.manifest.acceptance).toBeUndefined();
    });

    it('parses kind: html-ids', async () => {
        writeAcceptanceBundle(`acceptance:\n  kind: html-ids\n`);
        const result = await loadBundles(bundlesRoot);
        expect(result.errors).toEqual([]);
        expect(result.bundles[0]?.manifest.acceptance?.kind).toBe('html-ids');
    });

    it('parses kind: build-tests-preview with preview_routes and required_test_pass_rate', async () => {
        writeAcceptanceBundle(
            `acceptance:\n  kind: build-tests-preview\n  preview_routes: ["/sign-in", "/api/health"]\n  required_test_pass_rate: 0.95\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.errors).toEqual([]);
        const accept = result.bundles[0]?.manifest.acceptance;
        expect(accept?.kind).toBe('build-tests-preview');
        expect(accept?.preview_routes).toEqual(['/sign-in', '/api/health']);
        expect(accept?.required_test_pass_rate).toBe(0.95);
    });

    it('rejects unknown acceptance.kind', async () => {
        writeAcceptanceBundle(`acceptance:\n  kind: lighthouse-only\n`);
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/acceptance\.kind/);
    });

    it('rejects acceptance with no kind', async () => {
        writeAcceptanceBundle(`acceptance:\n  preview_routes: ["/"]\n`);
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/acceptance\.kind/);
    });

    it('rejects preview_routes that are not all strings', async () => {
        writeAcceptanceBundle(
            `acceptance:\n  kind: build-tests-preview\n  preview_routes: ["/", 42]\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/preview_routes/);
    });

    it('rejects preview_routes that do not start with "/"', async () => {
        writeAcceptanceBundle(
            `acceptance:\n  kind: build-tests-preview\n  preview_routes: ["sign-in"]\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/preview_routes.*"\/"/);
    });

    it('rejects required_test_pass_rate outside [0, 1]', async () => {
        writeAcceptanceBundle(
            `acceptance:\n  kind: build-tests-preview\n  required_test_pass_rate: 1.5\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/required_test_pass_rate/);
    });

    it('rejects required_test_pass_rate that is not a number', async () => {
        writeAcceptanceBundle(
            `acceptance:\n  kind: build-tests-preview\n  required_test_pass_rate: "high"\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/required_test_pass_rate/);
    });

    it('rejects acceptance that is not an object', async () => {
        writeAcceptanceBundle(`acceptance: "yes please"\n`);
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/acceptance must be an object/);
    });
});

// ── BundleDeployment block (P2.2-01 / D-C + D-L) ──

describe('loadBundles() — deployment block validation', () => {
    function writeDeploymentBundle(deploymentYaml: string): string {
        return writeBundle(
            'stacks',
            'with-deployment',
            `${minimalStackYaml('with-deployment')}${deploymentYaml}`
        );
    }

    it('omitting deployment is allowed (static-only bundles like vanilla-html)', async () => {
        writeBundle('stacks', 'no-deployment', minimalStackYaml('no-deployment'));
        const result = await loadBundles(bundlesRoot);
        expect(result.errors).toEqual([]);
        expect(result.bundles[0]?.manifest.deployment).toBeUndefined();
    });

    it('parses provider: vercel with full provider_help + required_env + optional_env', async () => {
        writeDeploymentBundle(
            `deployment:\n` +
                `  provider: vercel\n` +
                `  provider_help:\n` +
                `    signup_url: "https://vercel.com/signup"\n` +
                `    token_url: "https://vercel.com/account/tokens"\n` +
                `    docs_url: "https://vercel.com/docs/cli/tokens"\n` +
                `    token_scope: "Full Account"\n` +
                `  required_env:\n` +
                `    - key: DATABASE_URL\n` +
                `      label: "Neon DB URL"\n` +
                `      secret: true\n` +
                `      signup_url: "https://console.neon.tech/signup"\n` +
                `      dashboard_url: "https://console.neon.tech"\n` +
                `      docs_url: "https://neon.tech/docs"\n` +
                `      format_hint: "postgres://..."\n` +
                `      format_regex: "^postgres(ql)?://.+@.+/.+$"\n` +
                `  optional_env:\n` +
                `    - key: STRIPE_WEBHOOK_SECRET\n` +
                `      label: "Stripe webhook secret"\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.errors).toEqual([]);
        const dep = result.bundles[0]?.manifest.deployment;
        expect(dep?.provider).toBe('vercel');
        expect(dep?.provider_help?.signup_url).toBe('https://vercel.com/signup');
        expect(dep?.provider_help?.token_scope).toBe('Full Account');
        expect(dep?.required_env).toHaveLength(1);
        expect(dep?.required_env?.[0]?.key).toBe('DATABASE_URL');
        expect(dep?.required_env?.[0]?.secret).toBe(true);
        expect(dep?.required_env?.[0]?.format_regex).toBe('^postgres(ql)?://.+@.+/.+$');
        expect(dep?.optional_env?.[0]?.key).toBe('STRIPE_WEBHOOK_SECRET');
    });

    it('accepts minimal env entry (key + label only)', async () => {
        writeDeploymentBundle(
            `deployment:\n` +
                `  provider: vercel\n` +
                `  required_env:\n` +
                `    - key: API_KEY\n` +
                `      label: "API key"\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.errors).toEqual([]);
        expect(result.bundles[0]?.manifest.deployment?.required_env?.[0]?.key).toBe('API_KEY');
    });

    it('rejects unsupported provider', async () => {
        writeDeploymentBundle(`deployment:\n  provider: netlify\n`);
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/deployment\.provider "netlify"/);
    });

    it('rejects missing provider', async () => {
        writeDeploymentBundle(`deployment:\n  required_env: []\n`);
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/deployment\.provider must be a string/);
    });

    it('rejects deployment that is not an object', async () => {
        writeDeploymentBundle(`deployment: "vercel please"\n`);
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/deployment must be an object/);
    });

    it('rejects non-https URL in provider_help', async () => {
        writeDeploymentBundle(
            `deployment:\n` +
                `  provider: vercel\n` +
                `  provider_help:\n` +
                `    signup_url: "http://vercel.com/signup"\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/provider_help\.signup_url must use https/);
    });

    it('rejects malformed URL in env entry', async () => {
        writeDeploymentBundle(
            `deployment:\n` +
                `  provider: vercel\n` +
                `  required_env:\n` +
                `    - key: DATABASE_URL\n` +
                `      label: "Neon"\n` +
                `      signup_url: "not a url"\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(
            /required_env\[0\]\.signup_url is not a valid URL/
        );
    });

    it('rejects env entry with non-UPPER_SNAKE_CASE key', async () => {
        writeDeploymentBundle(
            `deployment:\n` +
                `  provider: vercel\n` +
                `  required_env:\n` +
                `    - key: database-url\n` +
                `      label: "Neon"\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/UPPER_SNAKE_CASE/);
    });

    it('rejects env entry with non-compilable format_regex', async () => {
        writeDeploymentBundle(
            `deployment:\n` +
                `  provider: vercel\n` +
                `  required_env:\n` +
                `    - key: API_KEY\n` +
                `      label: "API key"\n` +
                `      format_regex: "(unclosed"\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/format_regex is not a valid regular expression/);
    });

    it('rejects duplicate env keys within the same list', async () => {
        writeDeploymentBundle(
            `deployment:\n` +
                `  provider: vercel\n` +
                `  required_env:\n` +
                `    - key: API_KEY\n` +
                `      label: "First"\n` +
                `    - key: API_KEY\n` +
                `      label: "Second"\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/API_KEY.*duplicated/);
    });

    it('rejects secret flag that is not a boolean', async () => {
        writeDeploymentBundle(
            `deployment:\n` +
                `  provider: vercel\n` +
                `  required_env:\n` +
                `    - key: API_KEY\n` +
                `      label: "API key"\n` +
                `      secret: "yes"\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/secret must be a boolean/);
    });

    it('rejects required_env that is not an array', async () => {
        writeDeploymentBundle(
            `deployment:\n  provider: vercel\n  required_env: "DATABASE_URL"\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/required_env must be an array/);
    });

    it('rejects env entry missing key', async () => {
        writeDeploymentBundle(
            `deployment:\n` +
                `  provider: vercel\n` +
                `  required_env:\n` +
                `    - label: "Missing key"\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/required_env\[0\]\.key must be a non-empty string/);
    });

    it('rejects env entry missing label', async () => {
        writeDeploymentBundle(
            `deployment:\n` +
                `  provider: vercel\n` +
                `  required_env:\n` +
                `    - key: API_KEY\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.bundles).toEqual([]);
        expect(result.errors[0]?.reason).toMatch(/required_env\[0\]\.label must be a non-empty string/);
    });

    it('leaves BundleAcceptance untouched when both blocks are present', async () => {
        writeDeploymentBundle(
            `acceptance:\n  kind: build-tests-preview\n` +
                `deployment:\n` +
                `  provider: vercel\n` +
                `  required_env:\n` +
                `    - key: DATABASE_URL\n` +
                `      label: "Neon"\n`
        );
        const result = await loadBundles(bundlesRoot);
        expect(result.errors).toEqual([]);
        const m = result.bundles[0]?.manifest;
        expect(m?.acceptance?.kind).toBe('build-tests-preview');
        expect(m?.deployment?.provider).toBe('vercel');
    });
});
