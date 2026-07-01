/**
 * BPF-30 — shipped-feature task filter (planner-noise root).
 */

import { describe, it, expect } from 'vitest';
import { filterShippedFeatureTasks } from '../../src/orchestrator/shipped-feature-filter';
import type { BundleShippedFeature } from '../../src/bundles/types';

const FEATURES: readonly BundleShippedFeature[] = [
    { label: 'Stripe checkout', phrases: ['create checkout', 'checkout route', 'checkout api'] },
    { label: 'Stripe webhook', phrases: ['stripe webhook', 'webhook handler'] },
    { label: 'Clerk auth', phrases: ['integrate clerk', 'sign-in page'] },
];

const t = (title: string, description = ''): { title: string; description: string } => ({ title, description });

describe('filterShippedFeatureTasks', () => {
    it('drops tasks that re-implement shipped features (the ClubHubOSS noise)', () => {
        const tasks = [
            t('Add Stripe webhook handler', 'Create app/api/stripe/webhook/route.ts'),
            t('Create checkout API route', 'POST /api/checkout'),
            t('Integrate Clerk authentication', 'Wrap app in ClerkProvider'),
            t('Implement landing page UI', 'sections #hero #pricing #join-cta'),
            t('Add events table to schema', 'new domain table for club events'),
        ];
        const { kept, dropped } = filterShippedFeatureTasks(tasks, FEATURES);

        expect(dropped.map((d) => d.task.title)).toEqual([
            'Add Stripe webhook handler',
            'Create checkout API route',
            'Integrate Clerk authentication',
        ]);
        // Customisation tasks survive.
        expect(kept.map((k) => k.title)).toEqual([
            'Implement landing page UI',
            'Add events table to schema',
        ]);
        // Each drop names the feature + the FIRST phrase that matched
        // ("stripe webhook" precedes "webhook handler" in the feature's list).
        expect(dropped[0]).toMatchObject({ feature: 'Stripe webhook', phrase: 'stripe webhook' });
    });

    it('matches against the description too, case-insensitively', () => {
        // A surviving sibling keeps the safety rail from firing.
        const { kept, dropped } = filterShippedFeatureTasks(
            [t('Payments', 'Build the STRIPE WEBHOOK receiver'), t('Landing page', 'hero section')],
            FEATURES,
        );
        expect(dropped).toHaveLength(1);
        expect(dropped[0].feature).toBe('Stripe webhook');
        expect(kept.map((k) => k.title)).toEqual(['Landing page']);
    });

    it('keeps everything when no features are declared', () => {
        const tasks = [t('Add Stripe webhook handler')];
        const { kept, dropped } = filterShippedFeatureTasks(tasks, []);
        expect(kept).toEqual(tasks);
        expect(dropped).toEqual([]);
    });

    it('keeps customisation tasks that merely mention a domain near a feature word', () => {
        // "checkout button copy" is customisation, not "create checkout" infra.
        const tasks = [t('Polish the checkout button copy on the membership page')];
        const { kept, dropped } = filterShippedFeatureTasks(tasks, FEATURES);
        expect(dropped).toEqual([]);
        expect(kept).toHaveLength(1);
    });

    it('SAFETY: never wipes an entire phase (over-match → keep all)', () => {
        const tasks = [
            t('Add Stripe webhook handler'),
            t('Create checkout route'),
        ];
        const { kept, dropped } = filterShippedFeatureTasks(tasks, FEATURES);
        // Both matched, but dropping all would build nothing → keep them.
        expect(dropped).toEqual([]);
        expect(kept).toEqual(tasks);
    });
});
