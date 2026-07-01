/**
 * ThinkingRotator — rotating phrase indicator with the kanji-stroke
 * cascade loader (Loader 3 from the design pack) drawing alongside.
 *
 * Loader: four slate strokes draw in sequence then a single accent
 * vertical, on a 2.6s cycle. Calligraphic, fits "agent reasoning".
 * Phrases: cycle through THINKING_PHRASES with a fade-out → swap →
 * fade-in transition every 1.8s.
 *
 * Usage:
 *   const rotator = new ThinkingRotator(element);
 *   rotator.start();   // begin rotating
 *   rotator.stop();    // hide and reset
 */

import { THINKING_PHRASES } from '../../shared/constants';

const ROTATE_INTERVAL_MS = 1800;
const FADE_DURATION_MS = 280;

/* Loader 3 · Stroke cascade — kanji-stroke order, 4 slate + 1 accent.
 * Geometry pulled verbatim from
 * docs/design_pack/wave-2-mission-control/design-system/preview/
 * Brand Mark + Loader.html (lines 366-372). */
const LOADER_SVG =
    '<svg class="kg-think-loader" viewBox="0 0 100 100" aria-hidden="true">' +
    '<path class="kg-stroke-anim" d="M20 30 L48 30"/>' +
    '<path class="kg-stroke-anim" d="M20 46 L60 46"/>' +
    '<path class="kg-stroke-anim" d="M20 62 L52 62"/>' +
    '<path class="kg-stroke-anim" d="M20 78 L72 78"/>' +
    '<path class="kg-stroke-anim kg-stroke-anim--accent" d="M76 22 L76 84"/>' +
    '</svg>';

export class ThinkingRotator {
    private readonly el: HTMLElement;
    private phraseEl: HTMLElement | null = null;
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private phraseIndex: number = 0;
    private active = false;

    constructor(el: HTMLElement) {
        this.el = el;
        this.buildShell();
        this.el.style.transition = `opacity ${FADE_DURATION_MS}ms ease`;
        this.el.style.opacity = '0';
    }

    start(): void {
        if (this.active) return;
        this.active = true;
        this.phraseIndex = Math.floor(Math.random() * THINKING_PHRASES.length);
        this.showPhrase();
        this.intervalId = setInterval(() => this.rotatePhrase(), ROTATE_INTERVAL_MS);
    }

    stop(): void {
        if (!this.active) return;
        this.active = false;
        if (this.intervalId !== null) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.el.style.opacity = '0';
    }

    /**
     * Build the inner DOM once: loader SVG (CSS-animated) + phrase
     * span. Only the phrase fades during rotation; the loader keeps
     * stroking unobstructed.
     */
    private buildShell(): void {
        this.el.classList.add('kg-thinking');
        this.el.innerHTML = LOADER_SVG + `<span class="kg-thinking-phrase"></span>`;
        this.phraseEl = this.el.querySelector('.kg-thinking-phrase');
        if (this.phraseEl !== null) {
            this.phraseEl.style.transition = `opacity ${FADE_DURATION_MS}ms ease`;
        }
    }

    private showPhrase(): void {
        if (this.phraseEl !== null) {
            this.phraseEl.textContent =
                THINKING_PHRASES[this.phraseIndex % THINKING_PHRASES.length] ?? 'Thinking...';
            void this.phraseEl.offsetHeight;
            this.phraseEl.style.opacity = '1';
        }
        this.el.style.opacity = '1';
    }

    private rotatePhrase(): void {
        if (this.phraseEl !== null) this.phraseEl.style.opacity = '0';
        setTimeout(() => {
            if (!this.active) return;
            this.phraseIndex = (this.phraseIndex + 1) % THINKING_PHRASES.length;
            this.showPhrase();
        }, FADE_DURATION_MS + 20);
    }
}
