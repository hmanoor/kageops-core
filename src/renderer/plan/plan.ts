export {};

interface KageOpsPlansBridge {
    getStripePublishableKey(): Promise<string>;
    getSession(): Promise<{
        userId: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
        plan: string;
    } | null>;
    continueFree(): Promise<void>;
    openCheckout(args: { tier: 'team' | 'enterprise'; annual: boolean }): Promise<{ ok?: boolean; error?: string }>;
    openPortal(): Promise<void>;
    onStripeCallback(handler: (url: string) => void): void;
    confirmSelected(): Promise<void>;
}

declare global {
    interface Window { kageOpsPlans: KageOpsPlansBridge; }
}

type Tier = 'team' | 'enterprise';

// Canonical USD pricing locked in 2026-05-11. If you change these, also
// update landing/index.html, landing/docs/index.html, the Stripe Live
// Price IDs (immutable — create new prices and archive the old ones),
// and the data-monthly / data-annual attrs in plan/index.html.
//
// Annual = monthly × 10 (2 months free), so the displayed annual figure
// is `monthly × 10 / 12` rounded to nearest dollar — what the user pays
// per month when billed annually.
const MONTHLY_PRICES: Record<Tier, number> = { team: 39, enterprise: 99 };
const ANNUAL_PRICES:  Record<Tier, number> = { team: 33, enterprise: 83 };

let isAnnual = false;

async function init(): Promise<void> {
    setupToggle();
    setupButtons();
    setupCancelCheckout();

    window.kageOpsPlans.onStripeCallback((url: string) => {
        if (url.startsWith('kageops://plan/success')) {
            showLoading(false);
            showSuccess('Payment successful! Opening KageOps…');
            setTimeout(() => void window.kageOpsPlans.confirmSelected(), 1500);
        } else if (url.startsWith('kageops://plan/cancelled')) {
            showLoading(false);
            showError('Checkout cancelled — you can try again.');
        }
    });
}

function setupToggle(): void {
    const btn = document.getElementById('toggle-annual') as HTMLButtonElement;
    btn.addEventListener('click', () => {
        isAnnual = !isAnnual;
        btn.setAttribute('aria-checked', String(isAnnual));
        updatePrices();
    });
}

function updatePrices(): void {
    document.querySelectorAll<HTMLElement>('.price-amount[data-monthly]').forEach(el => {
        const monthly = Number(el.dataset['monthly']);
        const annual  = Number(el.dataset['annual']);
        el.textContent = `$${isAnnual ? annual : monthly}`;
    });
}

function setupButtons(): void {
    document.getElementById('btn-free')?.addEventListener('click', () => {
        void window.kageOpsPlans.continueFree();
    });

    document.querySelectorAll<HTMLButtonElement>('.plan-btn[data-tier]').forEach(btn => {
        const tier = btn.dataset['tier'] as Tier | 'enterprise';
        btn.addEventListener('click', () => {
            if (tier === 'enterprise') {
                void window.open('mailto:hello@kageops.ai?subject=Enterprise%20Plan');
                return;
            }
            void handleCheckout(tier, btn);
        });
    });
}

async function handleCheckout(tier: Tier, btn: HTMLButtonElement): Promise<void> {
    setButtonsDisabled(true);
    showLoading(true);
    hideError();

    const result = await window.kageOpsPlans.openCheckout({ tier, annual: isAnnual });

    if (result.error !== undefined) {
        showLoading(false);
        setButtonsDisabled(false);
        showError(result.error);
        btn.disabled = false;
    }
    // On success, loading stays visible until the kageops://plan/success callback arrives
}

function setupCancelCheckout(): void {
    document.getElementById('btn-cancel-checkout')?.addEventListener('click', () => {
        showLoading(false);
        setButtonsDisabled(false);
        hideError();
    });
}

function setButtonsDisabled(disabled: boolean): void {
    document.querySelectorAll<HTMLButtonElement>('.plan-btn').forEach(b => {
        b.disabled = disabled;
    });
}

function showLoading(show: boolean): void {
    document.getElementById('loading-overlay')?.classList.toggle('hidden', !show);
}

function showError(msg: string): void {
    const el = document.getElementById('error-banner');
    if (el === null) return;
    el.textContent = msg;
    el.classList.remove('hidden');
}

function hideError(): void {
    document.getElementById('error-banner')?.classList.add('hidden');
}

function showSuccess(msg: string): void {
    const overlay = document.getElementById('loading-overlay');
    if (overlay === null) return;
    overlay.innerHTML = `
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="#5BB377" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span>${msg}</span>
    `;
    overlay.classList.remove('hidden');
}

void init();
