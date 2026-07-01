/**
 * P1-12 — Bundle matcher tests.
 *
 * Pure unit tests over the matcher. No I/O — registries are built
 * synthetically from fake LoadedBundle objects.
 */

import { describe, it, expect } from 'vitest';

import {
    buildBundleKey,
    matchBundleForBrief,
} from '../../src/bundles/bundle-matcher';
import { BundleRegistry } from '../../src/bundles/bundle-registry';
import type { BundleKind, LoadedBundle } from '../../src/bundles/types';

function makeBundle(
    name: string,
    overrides: {
        readonly kind?: BundleKind;
        readonly phrases?: readonly string[];
        readonly tags?: readonly string[];
        readonly rejectPhrases?: readonly string[];
    } = {}
): LoadedBundle {
    return {
        directory: `/fake/${name}`,
        manifest: {
            schemaVersion: 1,
            name,
            kind: overrides.kind ?? 'stack',
            version: '1.0.0',
            description: name,
            match:
                overrides.phrases !== undefined ||
                overrides.tags !== undefined ||
                overrides.rejectPhrases !== undefined
                    ? {
                          phrases: overrides.phrases,
                          tags: overrides.tags,
                          rejectPhrases: overrides.rejectPhrases,
                      }
                    : undefined,
        },
    };
}

function registryOf(...bundles: LoadedBundle[]): BundleRegistry {
    return new BundleRegistry({ bundles, errors: [] });
}

// ── buildBundleKey ──

describe('buildBundleKey()', () => {
    it('formats <kind>::<name>', () => {
        const b = makeBundle('vanilla-html');
        expect(buildBundleKey(b)).toBe('stack::vanilla-html');
    });

    it('handles capability + deployer kinds', () => {
        expect(buildBundleKey(makeBundle('auth', { kind: 'capability' }))).toBe('capability::auth');
        expect(buildBundleKey(makeBundle('vercel', { kind: 'deployer' }))).toBe('deployer::vercel');
    });
});

// ── matchBundleForBrief — happy paths ──

describe('matchBundleForBrief() — happy paths', () => {
    it('matches a single bundle by phrase', () => {
        const registry = registryOf(
            makeBundle('vanilla-html', { phrases: ['vanilla html', 'no build step'] })
        );
        const hit = matchBundleForBrief({
            text: 'Build a vanilla HTML calculator with no build step.',
            registry,
        });
        expect(hit).not.toBeNull();
        expect(hit?.bundle.manifest.name).toBe('vanilla-html');
        expect(hit?.matchedPhrases.sort()).toEqual(['no build step', 'vanilla html']);
    });

    it('is case-insensitive on both text and phrases', () => {
        const registry = registryOf(makeBundle('vanilla-html', { phrases: ['Vanilla HTML'] }));
        const hit = matchBundleForBrief({ text: 'vanilla html app', registry });
        expect(hit?.bundle.manifest.name).toBe('vanilla-html');
    });

    it('counts tag matches as half-weight word-boundary hits', () => {
        const registry = registryOf(makeBundle('vanilla-html', { tags: ['html', 'css'] }));
        const hit = matchBundleForBrief({
            text: 'a project using html and css',
            registry,
        });
        expect(hit?.bundle.manifest.name).toBe('vanilla-html');
        expect(hit?.matchedTags.sort()).toEqual(['css', 'html']);
        expect(hit?.score).toBe(1.0); // 2 tags × 0.5
    });

    it('tag match requires word boundary — "java" does not hit "javascript"', () => {
        const registry = registryOf(makeBundle('java-stack', { tags: ['java'] }));
        const hit = matchBundleForBrief({
            text: 'a javascript project using TypeScript',
            registry,
        });
        expect(hit).toBeNull();
    });

    it('tag match allows trailing digits — "html" hits "html5"', () => {
        const registry = registryOf(makeBundle('vanilla-html', { tags: ['html'] }));
        const hit = matchBundleForBrief({ text: 'an html5 doctype page', registry });
        expect(hit).not.toBeNull();
        expect(hit?.matchedTags).toEqual(['html']);
    });

    it('picks the highest-scoring bundle when multiple match', () => {
        const single = makeBundle('single', { phrases: ['html'] }); // 1 phrase hit
        const multi = makeBundle('multi', { phrases: ['html', 'static', 'page'] }); // 3 phrase hits
        const registry = registryOf(single, multi);
        const hit = matchBundleForBrief({
            text: 'a static html page',
            registry,
        });
        expect(hit?.bundle.manifest.name).toBe('multi');
    });

    it('ties go to load order (first bundle wins)', () => {
        const a = makeBundle('a', { phrases: ['html'] });
        const b = makeBundle('b', { phrases: ['html'] });
        const registry = registryOf(a, b);
        const hit = matchBundleForBrief({ text: 'html stuff', registry });
        expect(hit?.bundle.manifest.name).toBe('a');
    });
});

// ── matchBundleForBrief — rejection + no-match paths ──

describe('matchBundleForBrief() — rejection + no-match', () => {
    it('returns null when no bundle has any match block', () => {
        const registry = registryOf(makeBundle('plain'));
        const hit = matchBundleForBrief({ text: 'anything at all', registry });
        expect(hit).toBeNull();
    });

    it('returns null when no phrase / tag matches', () => {
        const registry = registryOf(
            makeBundle('vanilla-html', { phrases: ['vanilla html'], tags: ['html'] })
        );
        const hit = matchBundleForBrief({
            text: 'a python data pipeline',
            registry,
        });
        expect(hit).toBeNull();
    });

    it('rejectPhrase disqualifies an otherwise-matching bundle', () => {
        const registry = registryOf(
            makeBundle('vanilla-html', {
                phrases: ['html'],
                rejectPhrases: ['react'],
            })
        );
        const hit = matchBundleForBrief({
            text: 'an html app using React',
            registry,
        });
        expect(hit).toBeNull();
    });

    it('rejectPhrase only disqualifies its own bundle, not others', () => {
        const registry = registryOf(
            makeBundle('vanilla-html', { phrases: ['html'], rejectPhrases: ['react'] }),
            makeBundle('react-stack', { phrases: ['react'] })
        );
        const hit = matchBundleForBrief({
            text: 'an html app using React',
            registry,
        });
        expect(hit?.bundle.manifest.name).toBe('react-stack');
    });

    it('returns null on empty text', () => {
        const registry = registryOf(makeBundle('vanilla-html', { phrases: ['html'] }));
        expect(matchBundleForBrief({ text: '', registry })).toBeNull();
        expect(matchBundleForBrief({ text: '   \n\t  ', registry })).toBeNull();
    });

    it('only considers stack bundles — capability + deployer matches ignored', () => {
        const registry = registryOf(
            makeBundle('auth-cap', { kind: 'capability', phrases: ['auth'] }),
            makeBundle('vercel-dep', { kind: 'deployer', phrases: ['deploy'] })
        );
        const hit = matchBundleForBrief({
            text: 'a project with auth and deploy concerns',
            registry,
        });
        expect(hit).toBeNull();
    });
});

// ── matchBundleForBrief — realistic Solarsizer brief ──

describe('matchBundleForBrief() — realistic Solarsizer brief', () => {
    const SOLARSIZER_BRIEF = `
SOLARSIZER — a single-page solar calculator.
Type your last electricity bill. See the solar array you'd need.
Single-page web app — HTML + CSS + vanilla JS, localStorage for last-used inputs,
no backend, no build step.
`;

    it('routes Solarsizer to vanilla-html via phrase + tag matches', () => {
        const vanilla = makeBundle('vanilla-html', {
            phrases: ['vanilla', 'single page', 'no build step'],
            tags: ['html', 'css', 'javascript', 'static'],
            rejectPhrases: ['react', 'express'],
        });
        const nextjs = makeBundle('nextjs-saas', {
            phrases: ['next.js', 'react', 'saas'],
            tags: ['typescript', 'react', 'nextjs'],
        });
        const registry = registryOf(vanilla, nextjs);

        const hit = matchBundleForBrief({ text: SOLARSIZER_BRIEF, registry });

        expect(hit?.bundle.manifest.name).toBe('vanilla-html');
        expect(hit?.score).toBeGreaterThan(0);
        // Tag matches expected on html + css (no other tag terms in brief).
        expect(hit?.matchedTags.length).toBeGreaterThanOrEqual(2);
    });
});
