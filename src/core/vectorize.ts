// Label map -> smooth closed outlines (in mm), one set per wood.
//
// Each wood's mask is blurred slightly and traced with marching squares at the
// 0.5 level, with linear interpolation, so outlines fall between pixels instead
// of following the pixel staircase. Where two woods meet, their blurred masks sum
// to 1, so both outlines land on the same curve. Loops are then thinned with
// Douglas-Peucker. Holes come out as separate loops: fill with the even-odd rule.

export interface WoodOutline {
  wood: number; // label index
  loops: Float32Array[]; // each loop: x0,y0,x1,y1,... in mm, closed implicitly
}

export function vectorize(labels: Uint8Array, w: number, h: number, k: number, pxPerMm: number, skip0 = true): WoodOutline[] {
  const out: WoodOutline[] = [];
  const W2 = w + 2, H2 = h + 2; // one pixel of zero padding closes loops at the border
  const f = new Float32Array(W2 * H2);
  const tmp = new Float32Array(W2 * H2);
  const nextEdge = new Int32Array(W2 * H2 * 2);
  const ex = new Float32Array(W2 * H2 * 2), ey = new Float32Array(W2 * H2 * 2);

  for (let j = skip0 ? 1 : 0; j < k; j++) {
    f.fill(0);
    let any = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (labels[y * w + x] === j) { f[(y + 1) * W2 + x + 1] = 1; any = true; }
    }
    if (!any) continue;
    blur1(f, tmp, W2, H2);
    nextEdge.fill(-1);
    trace(f, W2, H2, nextEdge, ex, ey);
    const loops: Float32Array[] = [];
    for (let e = 0; e < nextEdge.length; e++) {
      if (nextEdge[e] < 0) continue;
      const pts: number[] = [];
      let cur = e;
      while (nextEdge[cur] >= 0) {
        // padded pixel (i) has its centre at i - 0.5 in image pixel units
        pts.push(ex[cur] - 0.5, ey[cur] - 0.5);
        const nx = nextEdge[cur];
        nextEdge[cur] = -1;
        cur = nx;
      }
      if (pts.length < 8) continue;
      if (Math.abs(area(pts)) < 2) continue; // sub-pixel specks
      const simple = douglasPeucker(pts, 0.2);
      const mm = new Float32Array(simple.length);
      for (let i = 0; i < simple.length; i++) mm[i] = simple[i] / pxPerMm;
      loops.push(mm);
    }
    out.push({ wood: j, loops });
  }
  return out;
}

/** 3x3 tent blur, in place (zero border stays zero-ish). */
function blur1(f: Float32Array, tmp: Float32Array, w: number, h: number) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const l = x > 0 ? f[i - 1] : 0, r = x < w - 1 ? f[i + 1] : 0;
    tmp[i] = (l + 2 * f[i] + r) / 4;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const u = y > 0 ? tmp[i - w] : 0, d = y < h - 1 ? tmp[i + w] : 0;
    f[i] = (u + 2 * tmp[i] + d) / 4;
  }
}

// Edge ids: horizontal edge from grid point (x,y) to (x+1,y) = 2*(y*W+x); vertical (x,y)-(x,y+1) = 2*(y*W+x)+1.
const T = 0, R = 1, B = 2, L = 3;
const CASES: number[][][] = [
  [], [[L, B]], [[B, R]], [[L, R]], [[T, R]], [], [[T, B]], [[T, L]],
  [[T, L]], [[T, B]], [], [[T, R]], [[L, R]], [[R, B]], [[L, B]], [],
];

function trace(f: Float32Array, W: number, H: number, next: Int32Array, ex: Float32Array, ey: Float32Array) {
  const lv = 0.5;
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const tl = f[y * W + x], tr = f[y * W + x + 1], bl = f[(y + 1) * W + x], br = f[(y + 1) * W + x + 1];
      const c = (tl >= lv ? 8 : 0) | (tr >= lv ? 4 : 0) | (br >= lv ? 2 : 0) | (bl >= lv ? 1 : 0);
      if (c === 0 || c === 15) continue;
      let segs = CASES[c];
      if (c === 5 || c === 10) {
        const centre = (tl + tr + bl + br) / 4 >= lv;
        segs = c === 5
          ? (centre ? [[T, L], [B, R]] : [[T, R], [L, B]])
          : (centre ? [[T, R], [L, B]] : [[T, L], [B, R]]);
      }
      for (const [a, b] of segs) {
        const ea = edgeId(a, x, y, W), eb = edgeId(b, x, y, W);
        edgePoint(a, x, y, tl, tr, bl, br, lv, ea, ex, ey);
        edgePoint(b, x, y, tl, tr, bl, br, lv, eb, ex, ey);
        // Orient so the inside (higher values) is on a consistent side.
        const mx = (ex[ea] + ex[eb]) / 2 - x, my = (ey[ea] + ey[eb]) / 2 - y;
        const gx = (tr - tl) * (1 - my) + (br - bl) * my;
        const gy = (bl - tl) * (1 - mx) + (br - tr) * mx;
        const dx = ex[eb] - ex[ea], dy = ey[eb] - ey[ea];
        if (dx * gy - dy * gx > 0) next[ea] = eb; else next[eb] = ea;
      }
    }
  }
}

function edgeId(e: number, x: number, y: number, W: number): number {
  switch (e) {
    case T: return 2 * (y * W + x);
    case B: return 2 * ((y + 1) * W + x);
    case L: return 2 * (y * W + x) + 1;
    default: return 2 * (y * W + x + 1) + 1;
  }
}

function edgePoint(e: number, x: number, y: number, tl: number, tr: number, bl: number, br: number, lv: number, id: number, ex: Float32Array, ey: Float32Array) {
  const t = (a: number, b: number) => (a === b ? 0.5 : (lv - a) / (b - a));
  switch (e) {
    case T: ex[id] = x + t(tl, tr); ey[id] = y; break;
    case B: ex[id] = x + t(bl, br); ey[id] = y + 1; break;
    case L: ex[id] = x; ey[id] = y + t(tl, bl); break;
    default: ex[id] = x + 1; ey[id] = y + t(tr, br);
  }
}

function area(p: number[]): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return a / 2;
}

/** Douglas-Peucker for a closed loop (split at the point farthest from the start). */
function douglasPeucker(p: number[], tol: number): number[] {
  const n = p.length / 2;
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (p[2 * i] - p[0]) ** 2 + (p[2 * i + 1] - p[1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  const px = (i: number) => p[2 * (i % n)], py = (i: number) => p[2 * (i % n) + 1];
  const stack: [number, number][] = [[0, far], [far, n]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = px(a), ay = py(a), bx = px(b), by = py(b);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
    let idx = -1, md = tol2;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((px(i) - ax) * dx + (py(i) - ay) * dy) / len2));
      const qx = ax + t * dx - px(i), qy = ay + t * dy - py(i);
      const d = qx * qx + qy * qy;
      if (d > md) { md = d; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}

/** Smooth path through loop points: quadratic curves between edge midpoints. */
export function loopToPath2D(path: Path2D, loop: Float32Array) {
  const n = loop.length / 2;
  if (n < 3) return;
  const mx = (i: number) => (loop[2 * (i % n)] + loop[2 * ((i + 1) % n)]) / 2;
  const my = (i: number) => (loop[2 * (i % n) + 1] + loop[2 * ((i + 1) % n) + 1]) / 2;
  path.moveTo(mx(0), my(0));
  for (let i = 1; i <= n; i++) path.quadraticCurveTo(loop[2 * (i % n)], loop[2 * (i % n) + 1], mx(i), my(i));
  path.closePath();
}

/** Same curve as loopToPath2D, as SVG path data. */
export function loopToSvg(loop: Float32Array, d = 3): string {
  const n = loop.length / 2;
  if (n < 3) return "";
  const r = (v: number) => +v.toFixed(d);
  const mx = (i: number) => r((loop[2 * (i % n)] + loop[2 * ((i + 1) % n)]) / 2);
  const my = (i: number) => r((loop[2 * (i % n) + 1] + loop[2 * ((i + 1) % n) + 1]) / 2);
  let s = `M${mx(0)} ${my(0)}`;
  for (let i = 1; i <= n; i++) s += `Q${r(loop[2 * (i % n)])} ${r(loop[2 * (i % n) + 1])} ${mx(i)} ${my(i)}`;
  return s + "Z";
}
