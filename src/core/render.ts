// Turn a label map into preview images.

import { hexToRgb } from "./color";
import { grain, grainLut, lutIndex } from "./grain";

export interface RenderWood {
  color: string;
  figure: number;
  seed: number;
}

export function renderFlat(labels: Uint8Array, w: number, h: number, woods: RenderWood[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const rgb = woods.map((wd) => hexToRgb(wd.color));
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    const c = rgb[labels[i]];
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
  }
  return out;
}

/** Wood-textured preview with a faint glue line where two woods meet. */
export function renderInlay(labels: Uint8Array, w: number, h: number, pxPerMm: number, woods: RenderWood[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const luts = woods.map((wd) => grainLut(wd.color));
  const mm = 1 / pxPerMm;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, o = i * 4, lab = labels[i], wd = woods[lab];
      const g = grain(x * mm, y * mm, wd.seed, wd.figure);
      const k = lutIndex(g), lut = luts[lab];
      const edge =
        (x < w - 1 && labels[i + 1] !== lab) || (y < h - 1 && labels[i + w] !== lab) ||
        (x > 0 && labels[i - 1] !== lab) || (y > 0 && labels[i - w] !== lab);
      const m = edge ? 0.72 : 1;
      out[o] = lut[k] * m; out[o + 1] = lut[k + 1] * m; out[o + 2] = lut[k + 2] * m; out[o + 3] = 255;
    }
  }
  return out;
}
