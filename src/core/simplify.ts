// Image -> wood-color regions.
//   1. Convert to Lab, stretch lightness onto the woods' lightness range, blur lightly.
//   2. Assign each pixel the nearest wood (weighted Lab distance).
//   3. Majority-filter the labels.
//   4. Morphological opening per wood with a disk of the minimum feature size:
//      anything a V-bit cannot cut deep enough is released...
//   5. ...and refilled from neighbouring woods, preferring the closest color.
// Pure functions: runs in a worker, and later in a Node CLI.

import { rgbToLab, type Lab } from "./color";
import { applyEdits, type PxEdit } from "./edits";

export interface SimplifyInput {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  pxPerMm: number;
  woodLabs: Lab[]; // index 0 = base wood
  minFeatureMm: number; // thinnest line kept
  minAreaMm2: number; // smallest island kept
  colorWeight: number;
  smoothing: number; // 0..1
  sourcePx: number; // working pixels per source-image pixel (>1 when a small image is enlarged)
}

export interface WoodStat {
  pixels: number;
  areaMm2: number;
  islands: number;
}

export interface SimplifyResult {
  labels: Uint8Array;
  stats: WoodStat[];
  adjacency: boolean[][]; // adjacency[i][j]: woods i and j touch
  releasedPct: number; // share of pixels moved by cleanup
}

const UNSET = 255;

/** The expensive part, cached by the worker while only hand edits change. */
export interface Prepared {
  labels: Uint8Array;
  L: Float32Array;
  A: Float32Array;
  B: Float32Array;
  released: number;
}

export function simplify(inp: SimplifyInput, edits: PxEdit[] = []): SimplifyResult {
  return finish(prepare(inp), inp, edits);
}

/** Apply hand edits to a copy of the prepared labels, re-check the size rules, measure. */
export function finish(prep: Prepared, inp: SimplifyInput, edits: PxEdit[]): SimplifyResult {
  const { width: w, height: h, woodLabs } = inp;
  const k = woodLabs.length;
  const labels = prep.labels.slice();
  let released = prep.released;
  if (edits.length) {
    applyEdits(labels, w, h, k, edits);
    // Edits obey the same rules: no lines thinner, no islands smaller than allowed.
    released += removeThin(labels, w, h, k, (inp.minFeatureMm / 2) * inp.pxPerMm, prep.L, prep.A, prep.B, woodLabs, inp.colorWeight);
    released += removeSmallIslands(labels, w, h, k, inp.minAreaMm2 * inp.pxPerMm * inp.pxPerMm);
  }
  return {
    labels,
    stats: computeStats(labels, w, h, k, inp.pxPerMm),
    adjacency: computeAdjacency(labels, w, h, k),
    releasedPct: (100 * released) / (w * h),
  };
}

export function prepare(inp: SimplifyInput): Prepared {
  const { width: w, height: h, woodLabs } = inp;
  const n = w * h;
  const k = woodLabs.length;
  const radiusPx = (inp.minFeatureMm / 2) * inp.pxPerMm;
  // Blur and border smoothing follow the line width, but only up to a point:
  // a request for bold 8 mm lines should not melt every shape.
  const detailPx = Math.min(radiusPx, 1.5 * inp.pxPerMm);

  // 1. Lab conversion + transparency
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const transparent = new Uint8Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const lab = rgbToLab(inp.rgba[o], inp.rgba[o + 1], inp.rgba[o + 2]);
    L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
    transparent[i] = inp.rgba[o + 3] < 128 ? 1 : 0;
  }

  // Lightness stretch: map image 1st..99th percentile onto the wood range.
  // Statistics over the artwork only: transparent pixels (the board border, or
  // around a "fit" image) are not part of the picture.
  const [lo, hi] = percentiles(L, transparent, 0.01, 0.99);
  let wLo = Infinity, wHi = -Infinity;
  for (const lab of woodLabs) { wLo = Math.min(wLo, lab[0]); wHi = Math.max(wHi, lab[0]); }
  const scale = hi - lo > 1 ? (wHi - wLo) / (hi - lo) : 1;
  for (let i = 0; i < n; i++) L[i] = wLo + (L[i] - lo) * scale;
  // Transparent areas become base wood; give them its color before blurring so
  // they don't bleed black into the image edges.
  for (let i = 0; i < n; i++) if (transparent[i]) { L[i] = woodLabs[0][0]; A[i] = woodLabs[0][1]; B[i] = woodLabs[0][2]; }

  // Blur before the hard colour decision. An enlarged small image carries JPEG
  // noise and pixel steps at the scale of its own pixels, so blur at that scale too.
  const blurR = Math.max(0, Math.round(Math.max(detailPx * 0.35, inp.smoothing * inp.sourcePx * 0.8)));
  if (blurR > 0) for (const ch of [L, A, B]) boxBlur3(ch, w, h, blurR);

  // 2. Nearest wood
  const cw = inp.colorWeight;
  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (transparent[i]) { labels[i] = 0; continue; }
    let best = 0, bestD = Infinity;
    for (let j = 0; j < k; j++) {
      const dl = L[i] - woodLabs[j][0], da = A[i] - woodLabs[j][1], db = B[i] - woodLabs[j][2];
      const d = dl * dl + cw * (da * da + db * db);
      if (d < bestD) { bestD = d; best = j; }
    }
    labels[i] = best;
  }

  // 3. Majority filter, then smooth region borders
  majority(labels, w, h, k);
  majority(labels, w, h, k);
  // Smooth on the scale of whichever is coarser: the bit's minimum feature or the
  // source image's own pixels (an enlarged small PNG has big blocky steps).
  const smoothR = Math.round(inp.smoothing * Math.max(detailPx * 0.8, inp.sourcePx * 1.1));
  if (smoothR >= 1) smoothLabels(labels, w, h, k, smoothR);

  // 4 + 5. Thin lines: opening, release, refill.
  let released = removeThin(labels, w, h, k, radiusPx, L, A, B, woodLabs, cw);
  // Refill grows regions pixel by pixel; round those new borders off, then
  // enforce the line width once more, since smoothing can pinch a neck.
  if (smoothR >= 1) {
    smoothLabels(labels, w, h, k, Math.max(1, Math.round(smoothR / 2)));
    released += removeThin(labels, w, h, k, radiusPx, L, A, B, woodLabs, cw);
  }

  // 6. Small islands last: whatever survived above but is too small is filled
  // by the wood it touches most.
  released += removeSmallIslands(labels, w, h, k, inp.minAreaMm2 * inp.pxPerMm * inp.pxPerMm);

  return { labels, L, A, B, released };
}

function removeThin(labels: Uint8Array, w: number, h: number, k: number, radiusPx: number,
  L: Float32Array, A: Float32Array, B: Float32Array, woodLabs: Lab[], cw: number): number {
  if (radiusPx < 0.75) return 0;
  let released = 0;
  for (let pass = 0; pass < 2; pass++) { // refilling can create new slivers
    const r = openAndRelease(labels, w, h, k, radiusPx);
    if (!r) break;
    released += r;
    refill(labels, w, h, L, A, B, woodLabs, cw);
  }
  return released;
}

/**
 * Connected regions (4-connected) smaller than minPx take the label they share
 * the most border with. Repeats, since a merge can leave a neighbour small too.
 */
function removeSmallIslands(labels: Uint8Array, w: number, h: number, k: number, minPx: number): number {
  if (minPx < 1) return 0;
  const n = w * h;
  const seen = new Uint8Array(n);
  const members: number[] = [];
  const stack: number[] = [];
  const touch = new Uint32Array(k);
  let moved = 0;
  for (let pass = 0; pass < 4; pass++) {
    seen.fill(0);
    let changed = 0;
    for (let s = 0; s < n; s++) {
      if (seen[s]) continue;
      const lab = labels[s];
      members.length = 0;
      seen[s] = 1; stack.push(s);
      while (stack.length) {
        const p = stack.pop()!;
        members.push(p);
        const x = p % w;
        if (x > 0 && !seen[p - 1] && labels[p - 1] === lab) { seen[p - 1] = 1; stack.push(p - 1); }
        if (x < w - 1 && !seen[p + 1] && labels[p + 1] === lab) { seen[p + 1] = 1; stack.push(p + 1); }
        if (p >= w && !seen[p - w] && labels[p - w] === lab) { seen[p - w] = 1; stack.push(p - w); }
        if (p < n - w && !seen[p + w] && labels[p + w] === lab) { seen[p + w] = 1; stack.push(p + w); }
      }
      if (members.length >= minPx) continue;
      touch.fill(0);
      for (const p of members) {
        const x = p % w;
        if (x > 0 && labels[p - 1] !== lab) touch[labels[p - 1]]++;
        if (x < w - 1 && labels[p + 1] !== lab) touch[labels[p + 1]]++;
        if (p >= w && labels[p - w] !== lab) touch[labels[p - w]]++;
        if (p < n - w && labels[p + w] !== lab) touch[labels[p + w]]++;
      }
      let best = -1, bestN = 0;
      for (let j = 0; j < k; j++) if (touch[j] > bestN) { bestN = touch[j]; best = j; }
      if (best < 0) continue; // the whole image is this one region
      for (const p of members) labels[p] = best;
      changed += members.length;
    }
    moved += changed;
    if (!changed) break;
  }
  return moved;
}

function percentiles(v: Float32Array, skip: Uint8Array, a: number, b: number): [number, number] {
  const hist = new Uint32Array(1001);
  let count = 0;
  for (let i = 0; i < v.length; i++) if (!skip[i]) { hist[Math.max(0, Math.min(1000, Math.round(v[i] * 10)))]++; count++; }
  if (!count) return [0, 100];
  const find = (q: number) => {
    const target = q * count;
    let acc = 0;
    for (let i = 0; i <= 1000; i++) { acc += hist[i]; if (acc >= target) return i / 10; }
    return 100;
  };
  return [find(a), find(b)];
}

function boxBlur1(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const len = horizontal ? w : h, lines = horizontal ? h : w;
  const step = horizontal ? 1 : w, lineStep = horizontal ? w : 1;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[base + Math.max(0, Math.min(len - 1, i)) * step];
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = acc / (2 * r + 1);
      const add = Math.min(len - 1, i + r + 1), sub = Math.max(0, i - r);
      acc += src[base + add * step] - src[base + sub * step];
    }
  }
}

/** Three box blurs approximate a Gaussian. */
function boxBlur3(ch: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(ch.length);
  for (let i = 0; i < 3; i++) {
    boxBlur1(ch, tmp, w, h, r, true);
    boxBlur1(tmp, ch, w, h, r, false);
  }
}

/**
 * Gaussian-smooth each wood's mask and give every pixel to the strongest one.
 * Equivalent to a short curvature flow: staircases and jagged borders round off,
 * corners soften by roughly r pixels, large shapes keep their position.
 */
function smoothLabels(labels: Uint8Array, w: number, h: number, k: number, r: number) {
  const n = w * h;
  const best = new Float32Array(n).fill(-1);
  const out = labels.slice();
  const ch = new Float32Array(n);
  for (let j = 0; j < k; j++) {
    let any = false;
    for (let i = 0; i < n; i++) { const v = labels[i] === j ? 1 : 0; ch[i] = v; any ||= v === 1; }
    if (!any) continue;
    boxBlur3(ch, w, h, r);
    for (let i = 0; i < n; i++) if (ch[i] > best[i]) { best[i] = ch[i]; out[i] = j; }
  }
  labels.set(out);
}

function majority(labels: Uint8Array, w: number, h: number, k: number) {
  const src = labels.slice();
  const count = new Uint8Array(k);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      count.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          count[src[yy * w + xx]]++;
        }
      }
      const cur = src[y * w + x];
      let best = cur;
      for (let j = 0; j < k; j++) if (count[j] > count[best]) best = j;
      if (count[best] >= 5) labels[y * w + x] = best;
    }
  }
}

const INF = 1e20;

/** Felzenszwalb & Huttenlocher exact squared Euclidean distance transform, in place. */
function edt(f: Float32Array, w: number, h: number) {
  const m = Math.max(w, h);
  const d = new Float32Array(m), v = new Int32Array(m), z = new Float32Array(m + 1), g = new Float32Array(m);
  const pass = (len: number, get: (i: number) => number, set: (i: number, val: number) => void) => {
    for (let i = 0; i < len; i++) g[i] = get(i);
    let kk = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((g[q] + q * q) - (g[v[kk]] + v[kk] * v[kk])) / (2 * q - 2 * v[kk]);
      while (s <= z[kk]) { kk--; s = ((g[q] + q * q) - (g[v[kk]] + v[kk] * v[kk])) / (2 * q - 2 * v[kk]); }
      kk++; v[kk] = q; z[kk] = s; z[kk + 1] = INF;
    }
    kk = 0;
    for (let q = 0; q < len; q++) {
      while (z[kk + 1] < q) kk++;
      d[q] = (q - v[kk]) * (q - v[kk]) + g[v[kk]];
    }
    for (let i = 0; i < len; i++) set(i, d[i]);
  };
  for (let x = 0; x < w; x++) pass(h, (i) => f[i * w + x], (i, val) => { f[i * w + x] = val; });
  for (let y = 0; y < h; y++) { const o = y * w; pass(w, (i) => f[o + i], (i, val) => { f[o + i] = val; }); }
}

/** Opening per wood; pixels not covered by the opened shape are set to UNSET. */
function openAndRelease(labels: Uint8Array, w: number, h: number, k: number, r: number): number {
  const n = w * h, r2 = r * r;
  const keep = new Uint8Array(n);
  const f = new Float32Array(n);
  for (let j = 0; j < k; j++) {
    let any = false;
    for (let i = 0; i < n; i++) { const inside = labels[i] === j; f[i] = inside ? INF : 0; any ||= inside; }
    if (!any) continue;
    edt(f, w, h); // squared distance to the nearest pixel of another wood
    let core = false;
    for (let i = 0; i < n; i++) { const c = f[i] >= r2; f[i] = c ? 0 : INF; core ||= c; }
    if (!core) continue; // the whole wood is too thin: all of it is released
    edt(f, w, h); // squared distance to the eroded core
    for (let i = 0; i < n; i++) if (labels[i] === j && f[i] <= r2) keep[i] = 1;
  }
  let released = 0;
  for (let i = 0; i < n; i++) if (!keep[i] && labels[i] !== UNSET) { labels[i] = UNSET; released++; }
  return released;
}

/** Grow kept regions into UNSET pixels layer by layer, choosing the neighbour wood closest in color. */
function refill(labels: Uint8Array, w: number, h: number, L: Float32Array, A: Float32Array, B: Float32Array, woods: Lab[], cw: number) {
  const n = w * h;
  let hasSet = false;
  for (let i = 0; i < n; i++) if (labels[i] !== UNSET) { hasSet = true; break; }
  if (!hasSet) { labels.fill(0); return; }

  const inFrontier = new Uint8Array(n);
  let frontier: number[] = [];
  const pushNeighbours = (i: number, list: number[]) => {
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && labels[i - 1] === UNSET && !inFrontier[i - 1]) { inFrontier[i - 1] = 1; list.push(i - 1); }
    if (x < w - 1 && labels[i + 1] === UNSET && !inFrontier[i + 1]) { inFrontier[i + 1] = 1; list.push(i + 1); }
    if (y > 0 && labels[i - w] === UNSET && !inFrontier[i - w]) { inFrontier[i - w] = 1; list.push(i - w); }
    if (y < h - 1 && labels[i + w] === UNSET && !inFrontier[i + w]) { inFrontier[i + w] = 1; list.push(i + w); }
  };
  for (let i = 0; i < n; i++) if (labels[i] !== UNSET) pushNeighbours(i, frontier);

  while (frontier.length) {
    const chosen = new Uint8Array(frontier.length);
    for (let fi = 0; fi < frontier.length; fi++) {
      const i = frontier[fi], x = i % w, y = (i / w) | 0;
      let best = UNSET, bestD = Infinity;
      const consider = (j: number) => {
        const lab = labels[j];
        if (lab === UNSET) return;
        const wl = woods[lab];
        const dl = L[i] - wl[0], da = A[i] - wl[1], db = B[i] - wl[2];
        const d = dl * dl + cw * (da * da + db * db);
        if (d < bestD) { bestD = d; best = lab; }
      };
      if (x > 0) consider(i - 1);
      if (x < w - 1) consider(i + 1);
      if (y > 0) consider(i - w);
      if (y < h - 1) consider(i + w);
      chosen[fi] = best;
    }
    for (let fi = 0; fi < frontier.length; fi++) labels[frontier[fi]] = chosen[fi];
    const next: number[] = [];
    for (const i of frontier) pushNeighbours(i, next);
    frontier = next;
  }
}

function computeStats(labels: Uint8Array, w: number, h: number, k: number, ppm: number): WoodStat[] {
  const stats: WoodStat[] = Array.from({ length: k }, () => ({ pixels: 0, areaMm2: 0, islands: 0 }));
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    const lab = labels[i];
    stats[lab].pixels++;
    if (seen[i]) continue;
    stats[lab].islands++;
    seen[i] = 1; stack.push(i);
    while (stack.length) {
      const p = stack.pop()!, x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of nb) {
        if (q < 0 || q >= w * h || seen[q] || labels[q] !== lab) continue;
        seen[q] = 1; stack.push(q);
      }
    }
  }
  for (const s of stats) s.areaMm2 = s.pixels / (ppm * ppm);
  return stats;
}

function computeAdjacency(labels: Uint8Array, w: number, h: number, k: number): boolean[][] {
  const adj = Array.from({ length: k }, () => new Array<boolean>(k).fill(false));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = labels[y * w + x];
      if (x < w - 1) { const b = labels[y * w + x + 1]; if (a !== b) adj[a][b] = adj[b][a] = true; }
      if (y < h - 1) { const b = labels[(y + 1) * w + x]; if (a !== b) adj[a][b] = adj[b][a] = true; }
    }
  }
  return adj;
}

/**
 * Preview of round planning: greedy graph colouring of the tone woods
 * (base wood is never pocketed), biggest area first.
 */
export function planRounds(adjacency: boolean[][], stats: WoodStat[]): number[][] {
  const tones = stats.map((s, i) => ({ i, a: s.pixels })).filter((t) => t.i > 0 && t.a > 0).sort((p, q) => q.a - p.a);
  const rounds: number[][] = [];
  for (const t of tones) {
    const slot = rounds.find((r) => r.every((j) => !adjacency[t.i][j]));
    if (slot) slot.push(t.i); else rounds.push([t.i]);
  }
  return rounds;
}
