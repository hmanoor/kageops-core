/**
 * F-390 — `isLikelyArtifactContent()` stub-prose guard.
 *
 * Driven by 2026-05-21 GPS Delivery Tracker smoke (#165 stage 2)
 * where Forge's IMPROVE-phase consolidated task wrote 1-3 line file-
 * description prose into `.ts`/`.tsx` files. The decomposer allowlist
 * worked, the file count looked right, the verifier said pass — but
 * the artifacts were stubs.
 *
 * This guard is the shape oracle used by:
 *   - writeOutputFiles (src/agents/autonaut-agent.ts) — per-block
 *     check before `this.writeFile`, throws if every block is stub
 *   - BuildVerificationGate (F-391, follow-up) — same oracle re-used
 *     so even if Forge regresses, the verifier catches it.
 */

import { describe, it, expect } from 'vitest';
import { isLikelyArtifactContent } from '../../src/agents/output-parser';

describe('isLikelyArtifactContent() — F-390', () => {
    describe('.ts / .tsx — must contain code-shape tokens', () => {
        it('rejects the exact prose Forge wrote 2026-05-21', () => {
            const prose =
                'Express app with createApp() factory; Map<id,Vehicle> state; Zod validation for POST body;\n' +
                'WS snapshot-on-connect + broadcast on position_update; httpServer + WSS returned for test teardown.';
            expect(isLikelyArtifactContent(prose, 'backend/src/index.ts')).toBe(false);
        });

        it('rejects React component prose stub', () => {
            const prose =
                'MapContainer (OSM tiles, Sydney CBD center [-33.8688, 151.2093]), Marker per vehicle,\n' +
                'connection status badge, Leaflet icon fix.';
            expect(isLikelyArtifactContent(prose, 'frontend/src/App.tsx')).toBe(false);
        });

        it('rejects single-line hook description', () => {
            const prose = 'WebSocket hook: snapshot on connect, immutable mergeVehicle (map+spread), auto-reconnect 3s.';
            expect(isLikelyArtifactContent(prose, 'frontend/src/hooks/useVehicles.ts')).toBe(false);
        });

        it('accepts real Express bootstrap with imports', () => {
            const code = [
                "import express from 'express';",
                "import cors from 'cors';",
                '',
                'export function createApp() {',
                '    const app = express();',
                '    return app;',
                '}',
            ].join('\n');
            expect(isLikelyArtifactContent(code, 'backend/src/index.ts')).toBe(true);
        });

        it('accepts real React component file with import + JSX', () => {
            const code = [
                "import { MapContainer } from 'react-leaflet';",
                '',
                'export default function App() {',
                '    return <MapContainer />;',
                '}',
            ].join('\n');
            expect(isLikelyArtifactContent(code, 'frontend/src/App.tsx')).toBe(true);
        });

        it('rejects empty content', () => {
            expect(isLikelyArtifactContent('', 'src/index.ts')).toBe(false);
            expect(isLikelyArtifactContent('   \n  \n', 'src/index.ts')).toBe(false);
        });

        it('covers .mjs and .cjs extensions', () => {
            const prose = 'Sample mjs module description.';
            const code = 'export const x = 1;';
            expect(isLikelyArtifactContent(prose, 'src/util.mjs')).toBe(false);
            expect(isLikelyArtifactContent(code, 'src/util.mjs')).toBe(true);
            expect(isLikelyArtifactContent(prose, 'src/util.cjs')).toBe(false);
            expect(isLikelyArtifactContent(code, 'src/util.cjs')).toBe(true);
        });
    });

    describe('.py — Python syntax required', () => {
        it('rejects prose stub', () => {
            expect(isLikelyArtifactContent('A Python module that loads data.', 'src/load.py')).toBe(false);
        });
        it('accepts real Python with import', () => {
            const code = 'import json\n\ndef load(path):\n    return json.load(open(path))\n';
            expect(isLikelyArtifactContent(code, 'src/load.py')).toBe(true);
        });
    });

    describe('.html — must contain a real tag', () => {
        it('rejects HTML-described prose', () => {
            expect(isLikelyArtifactContent('A landing page with hero section and CTA.', 'index.html')).toBe(false);
        });
        it('accepts real HTML', () => {
            expect(isLikelyArtifactContent('<!DOCTYPE html><html><body><h1>Hi</h1></body></html>', 'index.html')).toBe(true);
        });
    });

    describe('.json — must look like JSON', () => {
        it('rejects JSON-described prose', () => {
            expect(isLikelyArtifactContent('A configuration file with three keys.', 'config.json')).toBe(false);
        });
        it('accepts a JSON object', () => {
            expect(isLikelyArtifactContent('{ "name": "kageops" }', 'package.json')).toBe(true);
        });
        it('accepts a JSON array', () => {
            expect(isLikelyArtifactContent('[1, 2, 3]', 'data.json')).toBe(true);
        });
    });

    describe('.css — must contain CSS shape tokens', () => {
        it('rejects CSS-described prose', () => {
            expect(isLikelyArtifactContent('Dark theme with rounded buttons.', 'styles.css')).toBe(false);
        });
        it('accepts real CSS', () => {
            expect(isLikelyArtifactContent('.btn { padding: 8px; }', 'styles.css')).toBe(true);
        });
        it('accepts CSS with only an at-rule', () => {
            expect(isLikelyArtifactContent('@import url("foo");', 'styles.css')).toBe(true);
        });
    });

    describe('.md — prose IS the artifact, only chat leads rejected', () => {
        it('accepts long prose markdown', () => {
            const md = 'A '.repeat(150);
            expect(isLikelyArtifactContent(md, 'docs/README.md')).toBe(true);
        });
        it('accepts markdown with structural markers', () => {
            expect(isLikelyArtifactContent('# Heading\n\nBody.', 'docs/notes.md')).toBe(true);
        });
        it('rejects short non-structural markdown', () => {
            expect(isLikelyArtifactContent('short answer', 'docs/x.md')).toBe(false);
        });
    });

    describe('unknown extension — only obvious chat leads rejected', () => {
        it('accepts arbitrary content', () => {
            expect(isLikelyArtifactContent('whatever', 'Dockerfile')).toBe(true);
            expect(isLikelyArtifactContent('FROM node:20\nRUN npm install', 'Dockerfile')).toBe(true);
        });
        it('rejects chat-summary leads', () => {
            expect(isLikelyArtifactContent("I've created the file.", 'Dockerfile')).toBe(false);
            expect(isLikelyArtifactContent('Done. Files ready.', 'Dockerfile')).toBe(false);
            expect(isLikelyArtifactContent('Task complete', 'unknown')).toBe(false);
        });
    });

    // ── 2026-06 Next.js boot failure — leaked agent monologue ─────────
    // An agent wrote 374 lines of internal reasoning into layout.tsx
    // instead of code; every route 500'd. The old keyword-anywhere
    // regex matched a stray `export default function` quoted deep in the
    // prose and let it through. The first meaningful line is the tell.
    describe('narration leak — leaked reasoning into a code file', () => {
        const leakedLayout = [
            'Let me read them all systematically. I have several files to look at',
            'before I can write the layout. Actually, I need to just read the files',
            'and understand the structure first.',
            '',
            'The root layout should wrap everything. Here is roughly what it needs:',
            '',
            '```ts',
            'export default function RootLayout({ children }) {',
            '  return <html><body>{children}</body></html>;',
            '}',
            '```',
            '',
            'But wait, I should double-check the metadata export and the font setup.',
            'Looking at the Next.js docs, the metadata const goes at the top. Given',
            'the app directory structure, I will also need a providers wrapper.',
        ].join('\n');

        it('rejects a leaked monologue layout.tsx despite stray export/const/```ts', () => {
            expect(isLikelyArtifactContent(leakedLayout, 'src/app/layout.tsx')).toBe(false);
        });

        it('rejects "All 6 test files written. Summary of what was created:" chat summary in a page.tsx', () => {
            const summary = [
                'All 6 test files written. Summary of what was created:',
                '',
                '| File | Purpose |',
                '| --- | --- |',
                '| login.test.tsx | covers the login form |',
                '',
                'These tests use vitest and render the page component.',
            ].join('\n');
            expect(isLikelyArtifactContent(summary, 'app/(auth)/login/page.tsx')).toBe(false);
        });

        it('rejects the same chat-summary lead in a markdown file', () => {
            const summary = 'Summary of what was created:\n\n- a thing\n- another thing';
            expect(isLikelyArtifactContent(summary, 'NOTES.md')).toBe(false);
        });

        it('accepts a real layout.tsx that opens with a code line', () => {
            const real = [
                "import type { Metadata } from 'next';",
                "import './globals.css';",
                '',
                "export const metadata: Metadata = { title: 'App' };",
                '',
                'export default function RootLayout({ children }: { children: React.ReactNode }) {',
                '    return (',
                '        <html lang="en">',
                '            <body>{children}</body>',
                '        </html>',
                '    );',
                '}',
            ].join('\n');
            expect(isLikelyArtifactContent(real, 'src/app/layout.tsx')).toBe(true);
        });

        it('accepts a real page.tsx that opens with a directive prologue', () => {
            const real = [
                "'use client';",
                '',
                "import { useState } from 'react';",
                '',
                'export default function LoginPage() {',
                "    const [email, setEmail] = useState('');",
                '    return <form>{email}</form>;',
                '}',
            ].join('\n');
            expect(isLikelyArtifactContent(real, 'app/(auth)/login/page.tsx')).toBe(true);
        });

        it('accepts a code file that opens with a JSDoc banner before the code', () => {
            const real = [
                '/**',
                ' * Root layout for the app.',
                ' * Wraps every page.',
                ' */',
                "import './globals.css';",
                '',
                'export default function Layout() { return null; }',
            ].join('\n');
            expect(isLikelyArtifactContent(real, 'src/app/layout.tsx')).toBe(true);
        });

        it('rejects narration even after a leading line comment', () => {
            const leak = '// layout\nLet me think about what this file needs before writing it.';
            expect(isLikelyArtifactContent(leak, 'src/app/layout.tsx')).toBe(false);
        });

        it('normalizes BOM + zero-width chars before the first-line check', () => {
            const leak = '﻿Let me​ read the files first before writing the layout.';
            expect(isLikelyArtifactContent(leak, 'src/app/layout.tsx')).toBe(false);
        });

        it('rejects prose paragraphs that happen to mention a keyword', () => {
            const prose = [
                'This component renders the navigation bar.',
                'It will import the logo and export a default function.',
                'The styling uses a const for the theme colors.',
            ].join('\n');
            expect(isLikelyArtifactContent(prose, 'src/components/Nav.tsx')).toBe(false);
        });
    });
});
