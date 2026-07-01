/**
 * Pillar 2.2 / PR-B.2 — DeploymentConfigSection tests.
 *
 * Uses jsdom directly (already a repo dep) for the DOM surface so we
 * can exercise click handlers + classList mutations without inventing
 * a parallel FakeEl. Bridge is stubbed deterministically.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

import {
    DeploymentConfigSection,
    type BundleSummary,
    type DeploymentConfigBridge,
    type SecretTestResult,
} from '../../src/renderer/command-center/deployment-config-section';

// ── jsdom setup ────────────────────────────────────────

let dom: JSDOM;
let container: HTMLElement;

beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    const g = globalThis as unknown as {
        window: typeof dom.window;
        document: Document;
        HTMLElement: typeof dom.window.HTMLElement;
        HTMLInputElement: typeof dom.window.HTMLInputElement;
        HTMLButtonElement: typeof dom.window.HTMLButtonElement;
        Node: typeof dom.window.Node;
    };
    g.window = dom.window;
    g.document = dom.window.document as unknown as Document;
    g.HTMLElement = dom.window.HTMLElement;
    g.HTMLInputElement = dom.window.HTMLInputElement;
    g.HTMLButtonElement = dom.window.HTMLButtonElement;
    g.Node = dom.window.Node;
    container = dom.window.document.getElementById('root')!;
});

afterEach(() => {
    dom.window.close();
});

// ── Fixtures ────────────────────────────────────────────

function bundleWithDeployment(): BundleSummary {
    return {
        name: 'nextjs-saas',
        kind: 'stack',
        description: 'Next.js + Clerk + Neon + Stripe',
        deployment: {
            provider: 'vercel',
            provider_help: {
                signup_url: 'https://vercel.com/signup',
                token_url: 'https://vercel.com/account/tokens',
                docs_url: 'https://vercel.com/docs/cli/tokens',
                token_scope: 'Full Account',
            },
            required_env: [
                {
                    key: 'DATABASE_URL',
                    label: 'Neon DB URL',
                    secret: true,
                    signup_url: 'https://console.neon.tech/signup',
                    dashboard_url: 'https://console.neon.tech',
                    docs_url: 'https://neon.tech/docs',
                    format_hint: 'postgres://...',
                    format_regex: '^postgres(ql)?://.+@.+/.+$',
                },
                {
                    key: 'CLERK_SECRET_KEY',
                    label: 'Clerk secret',
                    secret: true,
                    dashboard_url: 'https://dashboard.clerk.com',
                    format_regex: '^sk_(test|live)_[A-Za-z0-9]+$',
                },
            ],
            optional_env: [
                { key: 'STRIPE_WEBHOOK_SECRET', label: 'Stripe webhook secret' },
            ],
        },
    };
}

function staticBundle(): BundleSummary {
    return {
        name: 'vanilla-html',
        kind: 'stack',
        description: 'Just HTML/CSS/JS',
        deployment: null,
    };
}

type CallLog = { name: string; args: readonly unknown[] };

function makeBridge(overrides: Partial<DeploymentConfigBridge> = {}): {
    bridge: DeploymentConfigBridge;
    calls: CallLog[];
} {
    const calls: CallLog[] = [];
    const trace =
        <Args extends readonly unknown[], R>(name: string, fn: (...args: Args) => Promise<R>) =>
        async (...args: Args): Promise<R> => {
            calls.push({ name, args });
            return fn(...args);
        };
    const bridge: DeploymentConfigBridge = {
        getVercelTokenStatus: trace('getVercelTokenStatus', async () => ({ success: true, present: false })),
        saveVercelToken: trace('saveVercelToken', async () => ({ success: true })),
        clearVercelToken: trace('clearVercelToken', async () => ({ success: true })),
        testSecret: trace('testSecret', async () => ({
            success: true,
            result: { code: 'valid', latencyMs: 12, identity: 'demo' } as SecretTestResult,
        })),
        openVendorUrl: trace('openVendorUrl', async () => ({ success: true })),
        ...overrides,
    };
    return { bridge, calls };
}

// ── Tests ───────────────────────────────────────────────

describe('DeploymentConfigSection — empty states', () => {
    it('renders an empty notice when bundle is null', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, null);
        expect(container.querySelector('.deploy-empty')).not.toBeNull();
        expect(container.textContent).toContain('Pick a project type');
    });

    it('renders "no deploy config needed" for a bundle without a deployment block', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, staticBundle());
        expect(container.textContent).toContain('does not need a deploy configuration');
    });

    it('collectValues returns null when bundle has no deployment', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, staticBundle());
        expect(section.collectValues()).toBeNull();
    });
});

describe('DeploymentConfigSection — rendering from bundle.yaml', () => {
    it('renders the provider name in the header', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());
        expect(container.querySelector('.deploy-provider-name')!.textContent).toBe('vercel');
    });

    it('renders required + optional env rows with the bundle keys', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());
        const rows = Array.from(container.querySelectorAll('.deploy-row--env'));
        const keys = rows.map((r) => (r as HTMLElement).dataset.envKey);
        expect(keys).toEqual(['DATABASE_URL', 'CLERK_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
    });

    it('marks optional env rows with " (optional)" in the label', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());
        const optionalRow = container.querySelector('[data-env-key="STRIPE_WEBHOOK_SECRET"] .deploy-row-label');
        expect(optionalRow?.textContent).toContain('(optional)');
    });

    it('uses type=password for secret fields and adds a reveal button', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());
        const dbInput = container.querySelector('#deploy-env-DATABASE_URL') as HTMLInputElement;
        expect(dbInput.type).toBe('password');
        const revealBtns = container.querySelectorAll('.deploy-btn--reveal');
        // 2 secret fields (DATABASE_URL + CLERK_SECRET_KEY); the optional Stripe webhook isn't secret in this fixture.
        expect(revealBtns.length).toBe(2);
    });

    it('reveal button toggles input type between password and text', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());
        const row = container.querySelector('[data-env-key="DATABASE_URL"]')!;
        const input = row.querySelector('input') as HTMLInputElement;
        const reveal = row.querySelector('.deploy-btn--reveal') as HTMLButtonElement;
        expect(input.type).toBe('password');
        reveal.click();
        expect(input.type).toBe('text');
        reveal.click();
        expect(input.type).toBe('password');
    });

    it('reads keychain status on mount and updates the Vercel token badge', async () => {
        const { bridge } = makeBridge({
            getVercelTokenStatus: async () => ({ success: true, present: true }),
        });
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());
        const badge = container.querySelector('.deploy-token-badge')!;
        expect(badge.classList.contains('deploy-token-badge--saved')).toBe(true);
        expect(badge.textContent).toContain('Saved');
    });

    it('renders the setup checklist with one step per unique vendor origin', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());
        const steps = container.querySelectorAll('.deploy-setup-step');
        // vercel.com + console.neon.tech — dashboard.clerk.com has no signup_url in fixture.
        expect(steps.length).toBe(2);
    });
});

describe('DeploymentConfigSection — collectValues', () => {
    it('returns the entered values and allRequiredFilled=true when both required fields are valid', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment(), { initialMode: 'deploy' });

        (container.querySelector('#deploy-env-DATABASE_URL') as HTMLInputElement).value =
            'postgres://u:p@host.neon.tech/db';
        (container.querySelector('#deploy-env-CLERK_SECRET_KEY') as HTMLInputElement).value =
            'sk_test_abc123';

        const collected = section.collectValues();
        expect(collected).not.toBeNull();
        expect(collected!.allRequiredFilled).toBe(true);
        expect(collected!.values).toEqual({
            DATABASE_URL: 'postgres://u:p@host.neon.tech/db',
            CLERK_SECRET_KEY: 'sk_test_abc123',
        });
    });

    it('omits optional fields with bad format from the values map', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        const bundle: BundleSummary = {
            ...bundleWithDeployment(),
            deployment: {
                ...bundleWithDeployment().deployment!,
                optional_env: [
                    { key: 'STRIPE_WEBHOOK_SECRET', label: 'Webhook', format_regex: '^whsec_.+$' },
                ],
            },
        };
        await section.mountInto(container, bundle, { initialMode: 'deploy' });

        (container.querySelector('#deploy-env-DATABASE_URL') as HTMLInputElement).value =
            'postgres://u:p@host/db';
        (container.querySelector('#deploy-env-CLERK_SECRET_KEY') as HTMLInputElement).value =
            'sk_test_xyz';
        (container.querySelector('#deploy-env-STRIPE_WEBHOOK_SECRET') as HTMLInputElement).value =
            'not-a-webhook-secret';

        const collected = section.collectValues();
        expect(collected!.values.STRIPE_WEBHOOK_SECRET).toBeUndefined();
        expect(collected!.allRequiredFilled).toBe(true);
    });

    it('sets allRequiredFilled=false when a required field fails its format regex', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment(), { initialMode: 'deploy' });

        (container.querySelector('#deploy-env-DATABASE_URL') as HTMLInputElement).value =
            'not-a-postgres-url';
        (container.querySelector('#deploy-env-CLERK_SECRET_KEY') as HTMLInputElement).value =
            'sk_test_x';

        const collected = section.collectValues();
        expect(collected!.allRequiredFilled).toBe(false);
    });

    it('returns null when the "Skip for now" toggle is ticked', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());
        (container.querySelector('.deploy-skip-toggle') as HTMLInputElement).checked = true;
        expect(section.collectValues()).toBeNull();
        expect(section.isSkipped()).toBe(true);
    });
});

describe('DeploymentConfigSection — run-mode toggle', () => {
    const modeBtn = (mode: 'local' | 'deploy'): HTMLButtonElement =>
        container.querySelector(`[data-deploy-mode="${mode}"]`) as HTMLButtonElement;
    const fields = (): HTMLElement => container.querySelector('[data-deploy-fields]') as HTMLElement;

    it('defaults to "Run locally": deploy fields hidden + collectValues null', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());

        expect(section.currentMode()).toBe('local');
        expect(fields().style.display).toBe('none');
        expect(modeBtn('local').getAttribute('aria-pressed')).toBe('true');
        expect(modeBtn('deploy').getAttribute('aria-pressed')).toBe('false');
        // Even with valid values entered, local mode deploys nothing.
        (container.querySelector('#deploy-env-DATABASE_URL') as HTMLInputElement).value =
            'postgres://u:p@host/db';
        expect(section.collectValues()).toBeNull();
    });

    it('clicking "Deploy to Vercel" reveals the fields and enables collectValues', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());

        modeBtn('deploy').click();

        expect(section.currentMode()).toBe('deploy');
        expect(fields().style.display).toBe('');
        expect(modeBtn('deploy').getAttribute('aria-pressed')).toBe('true');

        (container.querySelector('#deploy-env-DATABASE_URL') as HTMLInputElement).value =
            'postgres://u:p@host.neon.tech/db';
        (container.querySelector('#deploy-env-CLERK_SECRET_KEY') as HTMLInputElement).value =
            'sk_test_abc123';
        const collected = section.collectValues();
        expect(collected).not.toBeNull();
        expect(collected!.allRequiredFilled).toBe(true);
    });

    it('switching back to local re-hides fields and returns null again', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment(), { initialMode: 'deploy' });

        expect(fields().style.display).toBe('');
        modeBtn('local').click();

        expect(section.currentMode()).toBe('local');
        expect(fields().style.display).toBe('none');
        expect(section.collectValues()).toBeNull();
    });
});

describe('DeploymentConfigSection — key register tickbox (phase 2b)', () => {
    it('collectValues reports saveToKeyRegister=false by default', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment(), { initialMode: 'deploy' });
        (container.querySelector('#deploy-env-DATABASE_URL') as HTMLInputElement).value =
            'postgres://u:p@host/db';
        expect(section.collectValues()!.saveToKeyRegister).toBe(false);
    });

    it('reports saveToKeyRegister=true when the tickbox is checked', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment(), { initialMode: 'deploy' });
        (container.querySelector('#deploy-env-DATABASE_URL') as HTMLInputElement).value =
            'postgres://u:p@host/db';
        (container.querySelector('[data-deploy-key-register]') as HTMLInputElement).checked = true;
        expect(section.collectValues()!.saveToKeyRegister).toBe(true);
    });
});

describe('DeploymentConfigSection — vendor link buttons (D-L)', () => {
    it('opens the bundle-declared signup URL when "Sign up →" is clicked', async () => {
        const { bridge, calls } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());

        const link = container.querySelector('.deploy-setup-step-link') as HTMLButtonElement;
        link.click();
        // wait a microtask for the void promise to enqueue
        await Promise.resolve();
        const opened = calls.filter((c) => c.name === 'openVendorUrl');
        expect(opened.length).toBe(1);
        expect(opened[0]!.args[0]).toBe('https://vercel.com/signup');
    });

    it('opens dashboard_url (not signup_url) when both are present on an env row', async () => {
        const { bridge, calls } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());

        const row = container.querySelector('[data-env-key="DATABASE_URL"]')!;
        const getLink = Array.from(row.querySelectorAll('.deploy-link-btn')).find(
            (b) => b.textContent === 'Get →'
        ) as HTMLButtonElement;
        getLink.click();
        await Promise.resolve();
        const opened = calls.filter((c) => c.name === 'openVendorUrl');
        expect(opened.some((c) => c.args[0] === 'https://console.neon.tech')).toBe(true);
    });
});

describe('DeploymentConfigSection — Test buttons (D-N)', () => {
    it('routes DATABASE_URL → neon provider', async () => {
        const { bridge, calls } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());

        const row = container.querySelector('[data-env-key="DATABASE_URL"]')!;
        (row.querySelector('input') as HTMLInputElement).value = 'postgres://x:y@host/db';
        const testBtn = Array.from(row.querySelectorAll('button')).find(
            (b) => b.textContent === 'Test'
        ) as HTMLButtonElement;
        testBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        const probe = calls.find((c) => c.name === 'testSecret');
        expect(probe?.args[0]).toBe('neon');
    });

    it('routes CLERK_SECRET_KEY → clerk-secret provider', async () => {
        const { bridge, calls } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());

        const row = container.querySelector('[data-env-key="CLERK_SECRET_KEY"]')!;
        (row.querySelector('input') as HTMLInputElement).value = 'sk_test_abc';
        const testBtn = Array.from(row.querySelectorAll('button')).find(
            (b) => b.textContent === 'Test'
        ) as HTMLButtonElement;
        testBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        const probe = calls.find((c) => c.name === 'testSecret');
        expect(probe?.args[0]).toBe('clerk-secret');
    });

    it('renders ✓ Valid + identity in the status pill on a successful probe', async () => {
        const { bridge } = makeBridge({
            testSecret: async () => ({
                success: true,
                result: { code: 'valid', latencyMs: 9, identity: 'octocat' },
            }),
        });
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());

        const row = container.querySelector('[data-env-key="DATABASE_URL"]')!;
        (row.querySelector('input') as HTMLInputElement).value = 'postgres://x:y@host/db';
        const testBtn = Array.from(row.querySelectorAll('button')).find(
            (b) => b.textContent === 'Test'
        ) as HTMLButtonElement;
        testBtn.click();
        await new Promise((r) => setTimeout(r, 0));

        const status = row.querySelector('.deploy-status') as HTMLElement;
        expect(status.classList.contains('deploy-status--valid')).toBe(true);
        expect(status.textContent).toContain('Valid');
        expect(status.textContent).toContain('octocat');
    });

    it('renders ✗ Unauthorized on a 401 probe', async () => {
        const { bridge } = makeBridge({
            testSecret: async () => ({
                success: true,
                result: { code: 'unauthorized', latencyMs: 5 },
            }),
        });
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());

        const row = container.querySelector('[data-env-key="DATABASE_URL"]')!;
        (row.querySelector('input') as HTMLInputElement).value = 'postgres://x:y@host/db';
        const testBtn = Array.from(row.querySelectorAll('button')).find(
            (b) => b.textContent === 'Test'
        ) as HTMLButtonElement;
        testBtn.click();
        await new Promise((r) => setTimeout(r, 0));

        const status = row.querySelector('.deploy-status') as HTMLElement;
        expect(status.classList.contains('deploy-status--bad')).toBe(true);
        expect(status.textContent).toContain('Unauthorized');
    });
});

describe('DeploymentConfigSection — Vercel token row', () => {
    it('save button persists token + clears the input on success', async () => {
        const { bridge, calls } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());
        const tokenInput = container.querySelector('.deploy-input--token') as HTMLInputElement;
        tokenInput.value = 'vercel-token-abc';
        const saveBtn = Array.from(container.querySelectorAll('button')).find(
            (b) => b.textContent === 'Save'
        ) as HTMLButtonElement;
        saveBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(calls.some((c) => c.name === 'saveVercelToken' && c.args[0] === 'vercel-token-abc')).toBe(true);
        expect(tokenInput.value).toBe('');
    });

    it('replace button clears the keychain entry and resets badge to empty', async () => {
        const { bridge, calls } = makeBridge({
            getVercelTokenStatus: async () => ({ success: true, present: true }),
        });
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());
        const replaceBtn = Array.from(container.querySelectorAll('button')).find(
            (b) => b.textContent === 'Replace'
        ) as HTMLButtonElement;
        replaceBtn.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(calls.some((c) => c.name === 'clearVercelToken')).toBe(true);
        const badge = container.querySelector('.deploy-token-badge')!;
        expect(badge.classList.contains('deploy-token-badge--empty')).toBe(true);
    });
});

describe('DeploymentConfigSection — re-mount on bundle change', () => {
    it('wipes the previous bundle\'s fields when remounted with a different bundle', async () => {
        const { bridge } = makeBridge();
        const section = new DeploymentConfigSection(bridge);
        await section.mountInto(container, bundleWithDeployment());
        expect(container.querySelector('[data-env-key="DATABASE_URL"]')).not.toBeNull();

        await section.mountInto(container, staticBundle());
        expect(container.querySelector('[data-env-key="DATABASE_URL"]')).toBeNull();
        expect(container.textContent).toContain('does not need a deploy configuration');
    });
});
