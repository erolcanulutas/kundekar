// Round planning and the pocket / plug shapes of each round.
//
// A round pockets one or more woods that never touch each other. Its pocket is
// the union of those woods' regions, except that holes holding only woods of
// *later* rounds are filled: the plug covers them and the later round cuts its
// own pocket into the plug. That gives simpler pockets and plugs with fewer
// islands and thin walls. Holes holding the base or an earlier inlay stay.

import { vectorize } from "./vectorize";

export interface Plug {
  wood: number;
  loops: Float32Array[]; // mirrored, placed at (margin, margin) on the plug board, mm
  w: number; // plug board size needed, mm (shape + margin on all sides)
  h: number;
  areaMm2: number;
}

export interface RoundShape {
  woods: number[];
  pocket: Float32Array[]; // on the base board, mm (board top-left = 0,0)
  pocketAreaMm2: number;
  plugs: Plug[];
}

export const PLUG_MARGIN = 10; // mm of plug board around the shapes

export function buildRounds(
  labels: Uint8Array, w: number, h: number, k: number, pxPerMm: number,
  rounds: number[][], blurPasses: number,
): RoundShape[] {
  const roundOf = new Int16Array(k).fill(-1); // base and unused woods: -1
  rounds.forEach((r, i) => r.forEach((j) => (roundOf[j] = i)));
  const px2 = pxPerMm * pxPerMm;

  return rounds.map((woods, ri) => {
    const union = new Uint8Array(w * h);
    const plugs: Plug[] = woods.map((j) => {
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) if (labels[i] === j) mask[i] = 1;
      fillLaterHoles(mask, labels, w, h, roundOf, ri);
      let n = 0;
      for (let i = 0; i < w * h; i++) if (mask[i]) { union[i] = 1; n++; }
      const loops = trace(mask, w, h, pxPerMm, blurPasses);
      return { wood: j, ...mirrorOntoBoard(loops), areaMm2: n / px2 };
    });
    let n = 0;
    for (let i = 0; i < w * h; i++) n += union[i];
    return { woods, pocket: trace(union, w, h, pxPerMm, blurPasses), pocketAreaMm2: n / px2, plugs };
  });
}

function trace(mask: Uint8Array, w: number, h: number, ppm: number, passes: number): Float32Array[] {
  return vectorize(mask, w, h, 2, ppm, true, passes)[0]?.loops ?? [];
}

/** Holes (not touching the board edge) whose pixels all belong to later rounds join the mask. */
function fillLaterHoles(mask: Uint8Array, labels: Uint8Array, w: number, h: number, roundOf: Int16Array, ri: number) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const comp: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (mask[s] || seen[s]) continue;
    comp.length = 0;
    let border = false, fillable = true;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (roundOf[labels[p]] <= ri) fillable = false; // base (-1), earlier or same round
      if (x > 0 && !mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && !mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && !mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && !mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
    }
    if (!border && fillable) for (const p of comp) mask[p] = 1;
  }
}

/** Plugs are cut face down: mirror left-right, then move to the plug board's corner. */
function mirrorOntoBoard(loops: Float32Array[]): { loops: Float32Array[]; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of loops) for (let i = 0; i < l.length; i += 2) {
    x0 = Math.min(x0, l[i]); x1 = Math.max(x1, l[i]);
    y0 = Math.min(y0, l[i + 1]); y1 = Math.max(y1, l[i + 1]);
  }
  if (!loops.length) return { loops: [], w: 0, h: 0 };
  const m = PLUG_MARGIN;
  const out = loops.map((l) => {
    const o = new Float32Array(l.length);
    for (let i = 0; i < l.length; i += 2) { o[i] = m + (x1 - l[i]); o[i + 1] = m + (l[i + 1] - y0); }
    return o;
  });
  return { loops: out, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
}
