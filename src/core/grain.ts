// Procedural wood grain. Coordinates are in millimetres so the figure
// stays physically plausible at any piece size. Grain runs along X.

import { hexToLab, labToRgb, type RGB } from "./color";

function hash(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x: number, y: number, seed: number): number {
  return vnoise(x, y, seed) * 0.6 + vnoise(x * 2.03, y * 2.03, seed + 11) * 0.3 + vnoise(x * 4.1, y * 4.1, seed + 23) * 0.1;
}

/** Grain value, roughly in [-1, 1]. */
export function grain(xMm: number, yMm: number, seed: number, figure: number): number {
  const warp = (fbm(xMm * 0.012, yMm * 0.04, seed) - 0.5) * 34;
  const spacing = 3.2 + 2.5 * hash(seed, 7, 3);
  const ring = 0.5 + 0.5 * Math.sin(((yMm + warp) / spacing) * Math.PI * 2);
  const late = ring * ring * ring; // sharp dark latewood bands
  const fiber = vnoise(xMm * 0.05, yMm * 2.6, seed + 5) - 0.5;
  const pore = vnoise(xMm * 0.6, yMm * 6, seed + 9) - 0.5;
  return figure * (late * 1.6 - 0.45) + fiber * (0.35 + 0.4 * figure) + pore * 0.15;
}

const LUT_SIZE = 64;
const LUT_MIN = -1.2, LUT_MAX = 1.6;

/** Color lookup: grain value -> RGB, darker and slightly richer in the latewood. */
export function grainLut(hex: string): Uint8ClampedArray {
  const [L, a, b] = hexToLab(hex);
  const lut = new Uint8ClampedArray(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const v = LUT_MIN + ((LUT_MAX - LUT_MIN) * i) / (LUT_SIZE - 1);
    const dl = -v * (5 + L * 0.1);
    const chroma = 1 + Math.max(0, v) * 0.12;
    const rgb: RGB = labToRgb(Math.max(0, Math.min(100, L + dl)), a * chroma, b * chroma);
    lut.set(rgb, i * 3);
  }
  return lut;
}

export function lutIndex(v: number): number {
  const t = (v - LUT_MIN) / (LUT_MAX - LUT_MIN);
  return Math.max(0, Math.min(LUT_SIZE - 1, Math.round(t * (LUT_SIZE - 1)))) * 3;
}

export function seedFor(uid: string): number {
  let h = 2166136261;
  for (let i = 0; i < uid.length; i++) h = Math.imul(h ^ uid.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
}

/** Paint a grain swatch into a canvas (used for wood cards). */
export function paintSwatch(canvas: HTMLCanvasElement, hex: string, figure: number, seed: number, mmPerPx = 0.25): void {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const lut = grainLut(hex);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = lutIndex(grain(x * mmPerPx, y * mmPerPx, seed, figure));
      const o = (y * w + x) * 4;
      img.data[o] = lut[k]; img.data[o + 1] = lut[k + 1]; img.data[o + 2] = lut[k + 2]; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
