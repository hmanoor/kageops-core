import Stripe from 'stripe';

/**
 * Lazy Stripe client.
 *
 * Eager (module-load-time) construction broke `next build` whenever
 * STRIPE_SECRET_KEY wasn't present in the build environment — even on
 * routes that never touch Stripe. Vercel's `--env` flags apply at
 * runtime, not build time, so the eager path would fail `next build`
 * on Vercel even when runtime env was set correctly.
 *
 * Wrapping in a function defers the env check + Stripe construction
 * until the first call. Build-time page-data collection (which evaluates
 * module top-level code) no longer trips on missing STRIPE_SECRET_KEY.
 */
let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
    if (_stripe !== null) return _stripe;

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (secretKey === undefined || secretKey.length === 0) {
        throw new Error(
            'STRIPE_SECRET_KEY is not set — copy .env.example to .env.local for local dev, ' +
            'or set --env STRIPE_SECRET_KEY=... on the Vercel deploy.'
        );
    }

    _stripe = new Stripe(secretKey, {
        apiVersion: '2025-02-24.acacia',
        typescript: true,
    });
    return _stripe;
}

/**
 * Backwards-compat alias. Existing imports of `stripe` still work but
 * the actual client construction is now lazy.
 *
 * @deprecated Prefer `getStripe()` for explicit lazy access.
 */
export const stripe = new Proxy({} as Stripe, {
    get(_target, prop, receiver) {
        const client = getStripe();
        const value = Reflect.get(client, prop, receiver);
        return typeof value === 'function' ? value.bind(client) : value;
    },
});
