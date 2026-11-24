// Turn a label map into preview images. Border pixels are anti-aliased by
// mixing the woods in a 3x3 tent kernel, and get a soft dark glue line.

import { hexToRgb } from "./color";
import { grain, grainLut, lutIndex } from "./grain";

export interface RenderWood {
  color: string;
  figure: number;
  seed: number;
}

const KW = [1, 2, 1, 2, 4, 2, 1, 2, 1];

/** Calls paint(i, o, mix) for every pixel; mix lists (label, weight) for border pixels, else null. */
function eachPixel(
  labels: Uint8Array, w: number, h: number,
  paint: (x: number, y: number, o: number, lab: number, mix: { l: number[]; wt: number[] } | null) => void,
) {
  const l: number[] = [], wt: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, lab = labels[i];
      const edge =
        (x < w - 1 && labels[i + 1] !== lab) || (y < h - 1 && labels[i + w] !== lab) ||
        (x > 0 && labels[i - 1] !== lab) || (y > 0 && labels[i - w] !== lab);
      if (!edge) { paint(x, y, i * 4, lab, null); continue; }
      l.length = 0; wt.length = 0;
      let total = 0;
      for (let dy = -1, kk = 0; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++, kk++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = labels[yy * w + xx];
          const at = l.indexOf(q);
          if (at < 0) { l.push(q); wt.push(KW[kk]); } else wt[at] += KW[kk];
          total += KW[kk];
        }
      }
      for (let m = 0; m < wt.length; m++) wt[m] /= total;
      paint(x, y, i * 4, lab, { l, wt });
    }
  }
}

export function renderFlat(labels: Uint8Array, w: number, h: number, woods: RenderWood[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const rgb = woods.map((wd) => hexToRgb(wd.color));
  eachPixel(labels, w, h, (_x, _y, o, lab, mix) => {
    let r = 0, g = 0, b = 0;
    if (!mix) [r, g, b] = rgb[lab];
    else for (let m = 0; m < mix.l.length; m++) {
      const c = rgb[mix.l[m]], t = mix.wt[m];
      r += c[0] * t; g += c[1] * t; b += c[2] * t;
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
  });
  return out;
}

export function renderInlay(labels: Uint8Array, w: number, h: number, pxPerMm: number, woods: RenderWood[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const luts = woods.map((wd) => grainLut(wd.color));
  const mm = 1 / pxPerMm;
  eachPixel(labels, w, h, (x, y, o, lab, mix) => {
    if (!mix) {
      const wd = woods[lab], k = lutIndex(grain(x * mm, y * mm, wd.seed, wd.figure)), lut = luts[lab];
      out[o] = lut[k]; out[o + 1] = lut[k + 1]; out[o + 2] = lut[k + 2]; out[o + 3] = 255;
      return;
    }
    let r = 0, g = 0, b = 0, wmax = 0;
    for (let m = 0; m < mix.l.length; m++) {
      const q = mix.l[m], t = mix.wt[m], wd = woods[q];
      const k = lutIndex(grain(x * mm, y * mm, wd.seed, wd.figure)), lut = luts[q];
      r += lut[k] * t; g += lut[k + 1] * t; b += lut[k + 2] * t;
      wmax = Math.max(wmax, t);
    }
    const glue = 1 - 0.55 * (1 - wmax); // darkest exactly on the border
    out[o] = r * glue; out[o + 1] = g * glue; out[o + 2] = b * glue; out[o + 3] = 255;
  });
  return out;
}
