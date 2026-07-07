/**
 * Help panel — left-rail entry that surfaces the in-app docs.
 *
 * Layout: TOC (left) + rendered markdown (right). Markdown source is
 * imported as text from docs/help/*.md via the esbuild text loader,
 * which inlines content at bundle time — works in dev and packaged
 * builds without runtime path resolution.
 *
 * Phase 2 (RAG): the same HELP_DOCS array is the source the indexer
 * will embed and Sensei will search.
 */

import { marked } from 'marked';
import { sanitizeHtml } from '../shared/sanitize-html';
import quickstartMd from '../../../docs/help/01-quickstart.md';
import presetsMd from '../../../docs/help/02-presets.md';
import designProvidersMd from '../../../docs/help/03-design-providers.md';
import envVarsMd from '../../../docs/help/04-env-vars.md';
import troubleshootingMd from '../../../docs/help/05-troubleshooting.md';
import recommendedSettingsMd from '../../../docs/help/06-recommended-settings.md';
import proTipsMd from '../../../docs/help/07-pro-tips.md';
import phasesMd from '../../../docs/help/08-phases.md';
import agentsRefMd from '../../../docs/help/09-agents-reference.md';
import missionControlMd from '../../../docs/help/10-mission-control.md';
import headlessRunnerMd from '../../../docs/help/11-headless-runner.md';
import kageopsCliMd from '../../../docs/help/12-kageops-cli.md';

interface HelpDoc {
    readonly slug: string;
    readonly title: string;
    readonly body: string;
}

export const HELP_DOCS: ReadonlyArray<HelpDoc> = [
    { slug: 'quickstart',            title: 'Quickstart',            body: quickstartMd },
    { slug: 'recommended-settings',  title: 'Recommended settings',  body: recommendedSettingsMd },
    { slug: 'pro-tips',              title: 'Pro tips',              body: proTipsMd },
    { slug: 'presets',               title: 'Presets',               body: presetsMd },
    { slug: 'design-providers',      title: 'Design providers',      body: designProvidersMd },
    { slug: 'env-vars',              title: 'Environment vars',      body: envVarsMd },
    { slug: 'troubleshooting',       title: 'Troubleshooting',       body: troubleshootingMd },
    { slug: 'phases',                title: 'The 6 phases',          body: phasesMd },
    { slug: 'agents-reference',      title: 'Agents reference',      body: agentsRefMd },
    { slug: 'mission-control',       title: 'Mission Control',       body: missionControlMd },
    { slug: 'headless-runner',       title: 'Headless runner',       body: headlessRunnerMd },
    { slug: 'kageops-cli',           title: 'KageOps CLI',           body: kageopsCliMd },
];

interface HelpSection {
    readonly heading: string;
    readonly slugs: readonly string[];
}

const HELP_SECTIONS: ReadonlyArray<HelpSection> = [
    { heading: 'Getting started',  slugs: ['quickstart', 'recommended-settings', 'pro-tips'] },
    { heading: 'Configuration',    slugs: ['presets', 'design-providers', 'env-vars'] },
    { heading: 'Reference',        slugs: ['phases', 'agents-reference', 'mission-control', 'troubleshooting'] },
    { heading: 'CLI & Automation', slugs: ['headless-runner', 'kageops-cli'] },
];

let mounted = false;

export function initHelpPanel(): void {
    if (mounted) return;
    mounted = true;

    const host = document.getElementById('help-panel-body');
    if (host === null) {
        console.warn('[HelpPanel] help-panel-body not found, skipping');
        return;
    }

    const CHEVRON_SVG = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 4.5 3 3 3-3"/></svg>`;

    host.classList.add('help-panel');
    host.innerHTML = `
        <aside class="help-panel__toc" aria-label="Help table of contents">
            <div class="help-panel__toc-heading">Documentation</div>
            ${HELP_SECTIONS.map((section) => `
                <div class="help-panel__toc-section">
                    <button class="help-panel__toc-section-toggle" type="button" aria-expanded="true">
                        ${section.heading}${CHEVRON_SVG}
                    </button>
                    <ul class="help-panel__toc-list">
                        ${section.slugs.map((slug) => {
                            const doc = HELP_DOCS.find((d) => d.slug === slug);
                            if (doc === undefined) return '';
                            return `<li><button class="help-panel__toc-item" data-slug="${doc.slug}" type="button">${doc.title}</button></li>`;
                        }).join('')}
                    </ul>
                </div>
            `).join('')}
        </aside>
        <article class="help-panel__content" id="help-panel-content"></article>
    `;

    const firstBtn = host.querySelector<HTMLButtonElement>('.help-panel__toc-item');
    firstBtn?.classList.add('is-active');

    const content = document.getElementById('help-panel-content');
    if (content === null) return;

    function renderDoc(slug: string): void {
        const doc = HELP_DOCS.find((d) => d.slug === slug);
        if (doc === undefined || content === null) return;
        const html = sanitizeHtml(marked.parse(doc.body, { async: false, gfm: true, breaks: false }) as string);
        content.innerHTML = html;
        content.scrollTop = 0;
    }

    host.querySelectorAll<HTMLButtonElement>('.help-panel__toc-section-toggle').forEach((toggle) => {
        toggle.addEventListener('click', () => {
            const section = toggle.closest('.help-panel__toc-section');
            if (section === null) return;
            const collapsed = section.classList.toggle('help-panel__toc-section--collapsed');
            toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        });
    });

    host.querySelectorAll<HTMLButtonElement>('.help-panel__toc-item').forEach((btn) => {
        btn.addEventListener('click', () => {
            const slug = btn.dataset['slug'];
            if (slug === undefined) return;
            host.querySelectorAll('.help-panel__toc-item').forEach((b) => b.classList.remove('is-active'));
            btn.classList.add('is-active');
            renderDoc(slug);
        });
    });

    renderDoc(HELP_DOCS[0]!.slug);
}
