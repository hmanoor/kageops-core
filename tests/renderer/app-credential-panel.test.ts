/**
 * MCC-8 / Slice 4 — app-credential-panel renderer tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    renderAppCredentialPanel,
    type AppCredentialPanelDeps,
    type AppLedgerData,
    type CredentialProposalView,
    type ProvideCredentialData,
} from '../../src/renderer/command-center/app-credential-panel';

const DB_PROPOSAL: CredentialProposalView = {
    playbookId: 'provideDatabaseUrl',
    title: 'Provide your database URL',
    description: 'Paste a Postgres connection string.',
    reason: 'This project needs database; DATABASE_URL is required at the scaffold stage.',
    status: 'needed-now',
    action: 'navigate',
    mutates: false,
    sourceUrl: 'https://console.neon.tech',
    envKeys: ['DATABASE_URL'],
};
const WEBHOOK_PROPOSAL: CredentialProposalView = {
    playbookId: 'registerStripeWebhook',
    title: 'Register the Stripe webhook',
    description: 'After deploy, register the endpoint.',
    reason: 'Needs the deployed URL first.',
    status: 'blocked-until-deploy',
    action: 'execute',
    mutates: true,
    sourceUrl: 'https://dashboard.stripe.com/test/webhooks',
    envKeys: ['STRIPE_WEBHOOK_SECRET'],
};
const PRICE_PROPOSAL: CredentialProposalView = {
    playbookId: 'createStripePrice',
    title: 'Create the membership Price',
    description: 'Create a recurring Stripe Product + Price.',
    reason: 'This project needs payments; STRIPE_PRICE_ID is required.',
    status: 'needed-now',
    action: 'execute',
    mutates: true,
    sourceUrl: 'https://dashboard.stripe.com/test/products',
    envKeys: ['STRIPE_PRICE_ID'],
};

function ledger(proposals: readonly CredentialProposalView[], providedEnvKeys: readonly string[] = []): AppLedgerData {
    return { phase: 'development', proposals, providedEnvKeys };
}

function buildDeps(opts?: {
    proposals?: readonly CredentialProposalView[];
    listFails?: boolean;
    provide?: AppCredentialPanelDeps['provideCredential'];
    provision?: AppCredentialPanelDeps['provisionCredential'];
    onSetupRequired?: AppCredentialPanelDeps['onSetupRequired'];
    openExternal?: (url: string) => void;
}): { deps: AppCredentialPanelDeps; listCalls: () => number } {
    let listCalls = 0;
    const deps: AppCredentialPanelDeps = {
        projectId: 'p1',
        listAppProposals: vi.fn(async () => {
            listCalls += 1;
            return opts?.listFails
                ? { success: false as const, error: 'boom' }
                : { success: true as const, data: ledger(opts?.proposals ?? [DB_PROPOSAL]) };
        }),
        provideCredential:
            opts?.provide ??
            vi.fn(async (): Promise<{ success: true; data: ProvideCredentialData }> => ({
                success: true,
                data: { ...ledger([]), check: { valid: true } },
            })),
        provisionCredential:
            opts?.provision ??
            vi.fn(async (): Promise<{ success: true; data: ProvideCredentialData }> => ({
                success: true,
                data: { ...ledger([]), check: { valid: true } },
            })),
        onSetupRequired: opts?.onSetupRequired,
        openExternal: opts?.openExternal,
    };
    return { deps, listCalls: () => listCalls };
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('renderAppCredentialPanel', () => {
    let root: HTMLElement;
    beforeEach(() => {
        root = document.createElement('div');
        document.body.appendChild(root);
    });

    it('renders a needed-now credential with a deep link and an input', async () => {
        const { deps } = buildDeps();
        renderAppCredentialPanel(root, deps);
        await flush();
        expect(root.querySelector('.app-credential')).not.toBeNull();
        expect(root.textContent).toContain('Provide your database URL');
        const link = root.querySelector<HTMLAnchorElement>('[data-cred-link]');
        expect(link?.getAttribute('href')).toBe('https://console.neon.tech');
        expect(root.querySelector('[data-cred-input="DATABASE_URL"]')).not.toBeNull();
    });

    it('renders nothing when the ledger is empty', async () => {
        const { deps } = buildDeps({ proposals: [] });
        renderAppCredentialPanel(root, deps);
        await flush();
        expect(root.innerHTML).toBe('');
    });

    it('renders nothing when the list call fails', async () => {
        const { deps } = buildDeps({ listFails: true });
        renderAppCredentialPanel(root, deps);
        await flush();
        expect(root.innerHTML).toBe('');
    });

    it('shows a blocked-until-deploy credential as pending, with no input', async () => {
        const { deps } = buildDeps({ proposals: [WEBHOOK_PROPOSAL] });
        renderAppCredentialPanel(root, deps);
        await flush();
        expect(root.textContent).toContain('Pending deploy');
        expect(root.querySelector('[data-cred-input="STRIPE_WEBHOOK_SECRET"]')).toBeNull();
    });

    it('on valid paste, persists and re-fetches the ledger', async () => {
        const provide = vi.fn(async () => ({ success: true as const, data: { ...ledger([]), check: { valid: true } } }));
        const { deps, listCalls } = buildDeps({ provide });
        renderAppCredentialPanel(root, deps);
        await flush();
        const before = listCalls();
        root.querySelector<HTMLInputElement>('[data-cred-input="DATABASE_URL"]')!.value = 'postgres://x';
        root.querySelector<HTMLButtonElement>('[data-cred-provide="DATABASE_URL"]')!.click();
        await flush();
        expect(provide).toHaveBeenCalledWith('p1', 'DATABASE_URL', 'postgres://x');
        expect(listCalls()).toBe(before + 1); // refreshed after success
    });

    it('on invalid paste, shows the rejection reason and does not re-fetch', async () => {
        const provide = vi.fn(async () => ({
            success: true as const,
            data: { ...ledger([DB_PROPOSAL]), check: { valid: false, reason: 'Not a Postgres connection string.' } },
        }));
        const { deps, listCalls } = buildDeps({ provide });
        renderAppCredentialPanel(root, deps);
        await flush();
        const before = listCalls();
        root.querySelector<HTMLInputElement>('[data-cred-input="DATABASE_URL"]')!.value = 'oops';
        root.querySelector<HTMLButtonElement>('[data-cred-provide="DATABASE_URL"]')!.click();
        await flush();
        expect(root.querySelector('[data-cred-status="DATABASE_URL"]')?.textContent).toContain('Not a Postgres');
        expect(listCalls()).toBe(before); // no refresh on rejection
    });

    it('refreshes when a matching setup.required event arrives, and unsubscribes on dispose', async () => {
        let captured: ((event: unknown) => void) | null = null;
        const unsub = vi.fn();
        const onSetupRequired = vi.fn((cb: (event: unknown) => void) => {
            captured = cb;
            return unsub;
        });
        const { deps, listCalls } = buildDeps({ onSetupRequired });
        const handle = renderAppCredentialPanel(root, deps);
        await flush();
        const before = listCalls();
        captured!({ projectId: 'p1' });
        await flush();
        expect(listCalls()).toBe(before + 1);
        handle.dispose();
        expect(unsub).toHaveBeenCalled();
    });

    it('renders an execute proposal as a one-click button, not a paste field', async () => {
        const { deps } = buildDeps({ proposals: [PRICE_PROPOSAL] });
        renderAppCredentialPanel(root, deps);
        await flush();
        expect(root.querySelector('[data-cred-execute="createStripePrice"]')).not.toBeNull();
        expect(root.querySelector('[data-cred-input="STRIPE_PRICE_ID"]')).toBeNull();
        expect(root.textContent).toContain('Create it for me');
    });

    it('on execute success, provisions and re-fetches the ledger', async () => {
        const provision = vi.fn(async () => ({ success: true as const, data: { ...ledger([]), check: { valid: true } } }));
        const { deps, listCalls } = buildDeps({ proposals: [PRICE_PROPOSAL], provision });
        renderAppCredentialPanel(root, deps);
        await flush();
        const before = listCalls();
        root.querySelector<HTMLButtonElement>('[data-cred-execute="createStripePrice"]')!.click();
        await flush();
        expect(provision).toHaveBeenCalledWith('p1', 'createStripePrice');
        expect(listCalls()).toBe(before + 1);
    });

    it('on execute failure, shows the reason and does not re-fetch', async () => {
        const provision = vi.fn(async () => ({
            success: true as const,
            data: { ...ledger([PRICE_PROPOSAL]), check: { valid: false, reason: 'Refusing LIVE objects.' } },
        }));
        const { deps, listCalls } = buildDeps({ proposals: [PRICE_PROPOSAL], provision });
        renderAppCredentialPanel(root, deps);
        await flush();
        const before = listCalls();
        root.querySelector<HTMLButtonElement>('[data-cred-execute="createStripePrice"]')!.click();
        await flush();
        expect(root.querySelector('[data-cred-status="createStripePrice"]')?.textContent).toContain('Refusing LIVE');
        expect(listCalls()).toBe(before);
    });

    it('opens deep links via openExternal when provided', async () => {
        const openExternal = vi.fn();
        const { deps } = buildDeps({ openExternal });
        renderAppCredentialPanel(root, deps);
        await flush();
        root.querySelector<HTMLAnchorElement>('[data-cred-link]')!.click();
        expect(openExternal).toHaveBeenCalledWith('https://console.neon.tech');
    });
});
