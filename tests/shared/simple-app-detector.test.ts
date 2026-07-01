/**
 * Pillar 2.2 — simple-app classifier regression suite.
 *
 * Why this exists: the FleetPulse smoke (2026-05-31) hit a bug where
 * WorkspaceManager called detectSimpleApp on a SaaS brief, the regex
 * `\blanding\s*page\b` matched "Landing page at /", veto patterns
 * (`react`, `next.js`, `postgres`) didn't fire because the brief
 * named services rather than frameworks, → simple=true → workspace
 * stripped → bundle scaffold deleted → Forge wrote freeform code →
 * nothing deployable.
 *
 * The HabbitForge smoke earlier hit the same root cause silently.
 *
 * Fix added SaaS-service vetoes (clerk, supabase, neon, drizzle,
 * stripe, oauth, /api/, etc.). This suite locks them in.
 */

import { describe, it, expect } from 'vitest';
import { detectSimpleApp } from '../../src/shared/simple-app-detector';

describe('detectSimpleApp — positive cases (real simple apps)', () => {
    it('counter brief → simple', () => {
        const r = detectSimpleApp('A counter app with + and - buttons.');
        expect(r.simple).toBe(true);
        expect(r.kind).toBe('counter');
    });

    it('coffee shop landing page → simple', () => {
        const r = detectSimpleApp(
            'A landing page for a coffee shop with hero, menu, contact form.'
        );
        expect(r.simple).toBe(true);
        expect(r.kind).toBe('landing-page');
    });

    it('todo list → simple', () => {
        const r = detectSimpleApp('A todo list app with add, complete, and delete.');
        expect(r.simple).toBe(true);
        expect(r.kind).toBe('todo');
    });

    it('calculator → simple', () => {
        expect(detectSimpleApp('A calculator that does basic arithmetic.').simple).toBe(true);
    });
});

describe('detectSimpleApp — vetoes SaaS-shaped briefs that look like landing pages', () => {
    // Each of these has "landing page" surface keyword + at least one
    // SaaS-service signal. Without the veto, stripBuildScaffold deletes
    // the bundle scaffold and the run is unrecoverable.

    it('rejects FleetPulse-shaped GPS tracker brief (clerk + /api/ + sign-in)', () => {
        const r = detectSimpleApp(
            'A live GPS asset tracking SaaS called FleetPulse. ' +
            'Landing page at / with hero. Sign up via Clerk magic links at /sign-in. ' +
            '/api/positions/stream emits SSE.'
        );
        expect(r.simple).toBe(false);
        expect(r.kind).toBeNull();
    });

    it('rejects HabbitForge-shaped paywalled SaaS brief (clerk + stripe + paywall)', () => {
        const r = detectSimpleApp(
            'A paywalled personal habit tracker SaaS. Landing page at /. ' +
            'Sign up via Clerk. Stripe checkout for $9/month subscription.'
        );
        expect(r.simple).toBe(false);
        expect(r.kind).toBeNull();
    });

    it('rejects Supabase-backed dashboard (supabase veto)', () => {
        const r = detectSimpleApp(
            'A single-page dashboard for users to view metrics. Backed by Supabase.'
        );
        expect(r.simple).toBe(false);
        expect(r.kind).toBeNull();
    });

    it('rejects Neon + Drizzle data app', () => {
        const r = detectSimpleApp(
            'Landing page for an analytics tool. Uses Neon Postgres and Drizzle ORM.'
        );
        expect(r.simple).toBe(false);
        expect(r.kind).toBeNull();
    });

    it('rejects Stripe + checkout SaaS (stripe veto)', () => {
        const r = detectSimpleApp(
            'A single-page SaaS landing page with Stripe checkout for monthly subscriptions.'
        );
        expect(r.simple).toBe(false);
        expect(r.kind).toBeNull();
    });

    it('rejects OAuth + magic-link briefs', () => {
        const r = detectSimpleApp(
            'A simple landing page with OAuth login and magic-link sign in.'
        );
        expect(r.simple).toBe(false);
        expect(r.kind).toBeNull();
    });

    it('rejects briefs that mention an /api/ path', () => {
        const r = detectSimpleApp(
            'A landing page hero with a contact form that POSTs to /api/contact.'
        );
        expect(r.simple).toBe(false);
        expect(r.kind).toBeNull();
    });

    it('rejects briefs that mention Server-Sent Events or WebSocket', () => {
        expect(detectSimpleApp('A landing page that uses Server-Sent Events.').simple).toBe(false);
        expect(detectSimpleApp('A single-page app with a WebSocket feed.').simple).toBe(false);
    });

    it('rejects Auth0 / Firebase auth landing pages', () => {
        expect(detectSimpleApp('Landing page secured by Auth0.').simple).toBe(false);
        expect(detectSimpleApp('Landing page using Firebase Auth.').simple).toBe(false);
    });
});

describe('detectSimpleApp — pre-existing framework vetoes still fire', () => {
    it('rejects Next.js brief', () => {
        expect(detectSimpleApp('A Next.js landing page.').simple).toBe(false);
    });
    it('rejects React brief', () => {
        expect(detectSimpleApp('A React counter.').simple).toBe(false);
    });
    it('rejects Node.js backend', () => {
        expect(detectSimpleApp('A Node.js todo backend.').simple).toBe(false);
    });
    it('rejects empty / undefined input', () => {
        expect(detectSimpleApp('').simple).toBe(false);
    });
});
