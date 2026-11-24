// Hand edits on the wood regions.
//
// Edits are stored relative to the image (u, v in 0..1 of the image's drawn
// rectangle; brush radius as a fraction of its width), so they follow the image
// when the board size or placement changes, and are re-applied in order every
// time the regions are recomputed.

export type Edit =
  | { t: "fill"; u: number; v: number; wood: string } // region under (u,v) -> wood (by uid)
  | { t: "merge"; u: number; v: number } // region under (u,v) -> the wood around it
  | { t: "brush"; pts: number[]; r: number; wood: string } // u,v pairs
  | { t: "lasso"; pts: number[]; wood: string }; // polygon, u,v pairs

/** An edit resolved to working pixels and a label index. */
export type PxEdit =
  | { t: "fill"; x: number; y: number; lab: number }
  | { t: "merge"; x: number; y: number }
  | { t: "brush"; pts: number[]; r: number; lab: number }
  | { t: "lasso"; pts: number[]; lab: number };

export function applyEdits(labels: Uint8Array, w: number, h: number, k: number, edits: PxEdit[]): void {
  for (const e of edits) {
    if (e.t === "fill") fillRegion(labels, w, h, e.x, e.y, e.lab);
    else if (e.t === "merge") mergeRegion(labels, w, h, k, e.x, e.y);
    else if (e.t === "brush") brush(labels, w, h, e.pts, e.r, e.lab);
    else lasso(labels, w, h, e.pts, e.lab);
  }
}

function region(labels: Uint8Array, w: number, h: number, x: number, y: number): number[] | null {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
  const n = w * h, s = yi * w + xi, lab = labels[s];
  const seen = new Uint8Array(n);
  const out: number[] = [], stack = [s];
  seen[s] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    out.push(p);
    const px = p % w;
    if (px > 0 && !seen[p - 1] && labels[p - 1] === lab) { seen[p - 1] = 1; stack.push(p - 1); }
    if (px < w - 1 && !seen[p + 1] && labels[p + 1] === lab) { seen[p + 1] = 1; stack.push(p + 1); }
    if (p >= w && !seen[p - w] && labels[p - w] === lab) { seen[p - w] = 1; stack.push(p - w); }
    if (p < n - w && !seen[p + w] && labels[p + w] === lab) { seen[p + w] = 1; stack.push(p + w); }
  }
  return out;
}

function fillRegion(labels: Uint8Array, w: number, h: number, x: number, y: number, lab: number) {
  const r = region(labels, w, h, x, y);
  if (r) for (const p of r) labels[p] = lab;
}

function mergeRegion(labels: Uint8Array, w: number, h: number, k: number, x: number, y: number) {
  const r = region(labels, w, h, x, y);
  if (!r) return;
  const n = w * h, own = labels[r[0]];
  const touch = new Uint32Array(k);
  for (const p of r) {
    const px = p % w;
    if (px > 0 && labels[p - 1] !== own) touch[labels[p - 1]]++;
    if (px < w - 1 && labels[p + 1] !== own) touch[labels[p + 1]]++;
    if (p >= w && labels[p - w] !== own) touch[labels[p - w]]++;
    if (p < n - w && labels[p + w] !== own) touch[labels[p + w]]++;
  }
  let best = -1, bestN = 0;
  for (let j = 0; j < k; j++) if (touch[j] > bestN) { bestN = touch[j]; best = j; }
  if (best >= 0) for (const p of r) labels[p] = best;
}

function brush(labels: Uint8Array, w: number, h: number, pts: number[], r: number, lab: number) {
  const r2 = r * r;
  const n = pts.length / 2;
  for (let s = 0; s < Math.max(1, n - 1); s++) {
    const ax = pts[2 * s], ay = pts[2 * s + 1];
    const bx = n > 1 ? pts[2 * s + 2] : ax, by = n > 1 ? pts[2 * s + 3] : ay;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-9;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        const qx = ax + t * dx - x, qy = ay + t * dy - y;
        if (qx * qx + qy * qy <= r2) labels[y * w + x] = lab;
      }
    }
  }
}

/** Even-odd scanline fill of a polygon, sampling pixel centres. */
function lasso(labels: Uint8Array, w: number, h: number, pts: number[], lab: number) {
  const n = pts.length / 2;
  if (n < 3) return;
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { y0 = Math.min(y0, pts[2 * i + 1]); y1 = Math.max(y1, pts[2 * i + 1]); }
  const xs: number[] = [];
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = pts[2 * i + 1], yj = pts[2 * j + 1];
      if ((yi > y) !== (yj > y)) xs.push(pts[2 * i] + ((y - yi) * (pts[2 * j] - pts[2 * i])) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      for (let x = Math.max(0, Math.ceil(xs[q])); x <= Math.min(w - 1, Math.floor(xs[q + 1])); x++) labels[y * w + x] = lab;
    }
  }
}
