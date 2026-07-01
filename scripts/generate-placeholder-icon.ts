/**
 * Generates `assets/icon.png` (used by BrowserWindow#icon) and
 * `build/icon.png` (used by electron-builder) from the KageOps
 * hood-and-iris brand mark — same geometry as
 * docs/design_pack/wave-2-mission-control/design-system/assets/logo.svg
 * but rasterised at 1024 × 1024 PNG so Windows / macOS / Linux
 * window managers can use it.
 *
 * Pure Node built-ins — no canvas, no sharp, no puppeteer. Renders
 * the hood silhouette, visor band, and iris triangle at sub-pixel
 * AA via per-pixel signed-distance evaluation.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SIZE = 1024;
const OUT_PATHS = [
    resolve(process.cwd(), "build", "icon.png"),
    resolve(process.cwd(), "assets", "icon.png"),
];

interface Rgba {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };
const HOOD_FILL: Rgba = { r: 26, g: 26, b: 26, a: 255 };       // #1A1A1A
const HOOD_STROKE: Rgba = { r: 200, g: 200, b: 200, a: 255 };  // #C8C8C8
const VISOR_FILL: Rgba = { r: 10, g: 10, b: 10, a: 255 };      // #0A0A0A
const IRIS_FILL: Rgba = { r: 132, g: 188, b: 122, a: 255 };    // moss green ≈ oklch(0.66 0.12 150)

/* Convert design coords (0–64) to canvas coords (0–SIZE).
 * The brand mark in the SVG only occupies y=12..44 (centred at y=27)
 * which leaves whitespace below in a square canvas. Shift the design
 * grid downward by 5 units before scaling so the hood sits at the
 * canvas centre. */
const Y_OFFSET = 5;
const u = (n: number): number => (n / 64) * SIZE;
const uY = (n: number): number => ((n + Y_OFFSET) / 64) * SIZE;

/* Composite `over` onto `under`, returning the result. Both are
 * straight (non-premultiplied) RGBA. */
function over(under: Rgba, top: Rgba): Rgba {
    if (top.a === 0) return under;
    if (top.a === 255) return top;
    const aTop = top.a / 255;
    const aBg = under.a / 255;
    const aOut = aTop + aBg * (1 - aTop);
    if (aOut === 0) return TRANSPARENT;
    const blend = (cTop: number, cBg: number): number => {
        return Math.round(
            (cTop * aTop + cBg * aBg * (1 - aTop)) / aOut,
        );
    };
    return {
        r: blend(top.r, under.r),
        g: blend(top.g, under.g),
        b: blend(top.b, under.b),
        a: Math.round(aOut * 255),
    };
}

/* Smooth step: returns 0 outside [edge0, edge1], 1 inside, AA at edges. */
function smoothFillAlpha(distance: number, halfWidth = 0.5): number {
    if (distance < -halfWidth) return 1;
    if (distance > halfWidth) return 0;
    const t = (halfWidth - distance) / (halfWidth * 2);
    return t * t * (3 - 2 * t);
}

/* Signed distance from an axis-aligned rounded rectangle. */
function sdRoundedRect(
    px: number, py: number,
    cx: number, cy: number,
    halfW: number, halfH: number,
    radius: number,
): number {
    const dx = Math.max(Math.abs(px - cx) - halfW + radius, 0);
    const dy = Math.max(Math.abs(py - cy) - halfH + radius, 0);
    return Math.hypot(dx, dy) - radius;
}

/* Approximate signed distance from the hood silhouette (rounded
 * tab shape). Treat as a vertical capsule with a slight bulge top. */
function sdHood(px: number, py: number): number {
    // Centre at design (32, 27), tall capsule
    const cx = u(32);
    const cy = uY(27);
    const halfW = u(16);   // 16-48 → 16 wide each side
    const halfH = u(15);   // 12-42 → 15 tall each side
    return sdRoundedRect(px, py, cx, cy, halfW, halfH, u(10));
}

function sdVisor(px: number, py: number): number {
    // Visor: design rect 22-42 wide, 26-28.4 tall
    const cx = u(32);
    const cy = uY(27.2);
    const halfW = u(10);
    const halfH = u(1.2);
    return sdRoundedRect(px, py, cx, cy, halfW, halfH, u(0.6));
}

/* Iris triangle: approximate via barycentric inside-test +
 * distance-to-edge for AA. Triangle vertices at (27,26), (37,26),
 * (32,30) in design space. */
function sdIris(px: number, py: number): number {
    const ax = u(27), ay = uY(26);
    const bx = u(37), by = uY(26);
    const cx = u(32), cy = uY(30);

    // Barycentric / cross-product sign test for inside
    const sign = (p1x: number, p1y: number, p2x: number, p2y: number, p3x: number, p3y: number): number =>
        (p1x - p3x) * (p2y - p3y) - (p2x - p3x) * (p1y - p3y);

    const d1 = sign(px, py, ax, ay, bx, by);
    const d2 = sign(px, py, bx, by, cx, cy);
    const d3 = sign(px, py, cx, cy, ax, ay);
    const inside = !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)));

    // Distance to nearest edge
    const distToSeg = (px2: number, py2: number, vx: number, vy: number, wx: number, wy: number): number => {
        const l2 = (wx - vx) ** 2 + (wy - vy) ** 2;
        if (l2 === 0) return Math.hypot(px2 - vx, py2 - vy);
        const t = Math.max(0, Math.min(1, ((px2 - vx) * (wx - vx) + (py2 - vy) * (wy - vy)) / l2));
        return Math.hypot(px2 - (vx + t * (wx - vx)), py2 - (vy + t * (wy - vy)));
    };

    const dEdge = Math.min(
        distToSeg(px, py, ax, ay, bx, by),
        distToSeg(px, py, bx, by, cx, cy),
        distToSeg(px, py, cx, cy, ax, ay),
    );
    return inside ? -dEdge : dEdge;
}

function pixel(x: number, y: number): Rgba {
    let result: Rgba = TRANSPARENT;

    // 1. Hood fill — soft AA at the silhouette edge
    const hoodDist = sdHood(x, y);
    const hoodAlpha = smoothFillAlpha(hoodDist, 1.0);
    if (hoodAlpha > 0) {
        result = over(result, { ...HOOD_FILL, a: Math.round(HOOD_FILL.a * hoodAlpha) });

        // 1b. Hood stroke — a 2-pixel band straddling the silhouette edge
        // (only on the outer half so it reads as a contour ring).
        const strokeBand = Math.abs(hoodDist - 0) < 2 ? Math.max(0, 1 - Math.abs(hoodDist) / 2) : 0;
        if (strokeBand > 0) {
            result = over(result, { ...HOOD_STROKE, a: Math.round(HOOD_STROKE.a * strokeBand * 0.6) });
        }
    }

    // 2. Visor — sits inside the hood
    const visorDist = sdVisor(x, y);
    const visorAlpha = smoothFillAlpha(visorDist, 1.0);
    if (visorAlpha > 0) {
        result = over(result, { ...VISOR_FILL, a: Math.round(VISOR_FILL.a * visorAlpha) });
    }

    // 3. Iris triangle — single saturated accent pixel cluster
    const irisDist = sdIris(x, y);
    const irisAlpha = smoothFillAlpha(irisDist, 1.0);
    if (irisAlpha > 0) {
        result = over(result, { ...IRIS_FILL, a: Math.round(IRIS_FILL.a * irisAlpha) });
    }

    return result;
}

const crcTable: number[] = (() => {
    const table: number[] = [];
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table.push(c >>> 0);
    }
    return table;
})();

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (const byte of buf) {
        c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function buildRaster(size: number): Buffer {
    const rowBytes = size * 4;
    const raster = Buffer.alloc((rowBytes + 1) * size);
    for (let y = 0; y < size; y += 1) {
        const rowStart = y * (rowBytes + 1);
        raster[rowStart] = 0; // filter: none
        for (let x = 0; x < size; x += 1) {
            const p = pixel(x + 0.5, y + 0.5);
            const offset = rowStart + 1 + x * 4;
            raster[offset] = p.r;
            raster[offset + 1] = p.g;
            raster[offset + 2] = p.b;
            raster[offset + 3] = p.a;
        }
    }
    return raster;
}

function encodePng(size: number): Buffer {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type: RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const raster = buildRaster(size);
    const idat = deflateSync(raster, { level: 9 });

    return Buffer.concat([
        signature,
        chunk("IHDR", ihdr),
        chunk("IDAT", idat),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function main(): void {
    const png = encodePng(SIZE);
    for (const out of OUT_PATHS) {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, png);
        // eslint-disable-next-line no-console
        console.log(`[icon] wrote ${out} (${png.length} bytes, ${SIZE}×${SIZE})`);
    }
}

main();
