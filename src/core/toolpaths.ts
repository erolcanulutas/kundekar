// Toolpaths for V-carve inlays, all derived from one signed distance field.
//
// sd(p) = distance from p to the shape's outline, negative inside, in mm.
//
// Pocket (V-bit of half-angle a, t = tan a): the ideal surface has depth
//   min(D, -sd / t)   inside the shape.
// Cutting along the contour sd = -l at depth l / t puts the cone's flank exactly
// on the wall, so walls are exact whatever the contour spacing; spacing only
// leaves small ridges on the floor and along the centre line of narrow parts.
//
// Plug (cut face down, start depth S, total depth Pd): cut depth
//   clamp(S + sd / t, 0, Pd)  everywhere,
// so the plug's top is the outline shrunk by S*t, and when flipped into the
// pocket its top stops S below the surface: glue gap = D - S.
//
// An end mill of radius R clears the flat floor along contours at distance
// >= (wall width) + R, so it never touches the V walls.

import { edt, INF } from "./simplify";

export interface Cut {
  z: number; // depth of this group of paths (machine Z, mm)
  paths: number[][]; // x,y pairs in board mm (y down, as in the SVG)
  closed: boolean;
  zs?: number[][]; // optional per-point Z for each path (variable-depth passes)
}

interface Field {
  sd: Float32Array;
  W: number;
  H: number;
  res: number;
  ox: number; // mm of pixel (0,0)'s corner
  oy: number;
  maxSd: number;
  minSd: number;
}

/** Signed distance field of even-odd filled loops over a rectangle, sampled at pixel centres. */
export function signedField(loops: ArrayLike<number>[], ox: number, oy: number, wMm: number, hMm: number, res: number): Field {
  const W = Math.max(3, Math.ceil(wMm / res)), H = Math.max(3, Math.ceil(hMm / res));
  const n = W * H;
  const mask = new Uint8Array(n);
  const xs: number[] = [];
  for (let j = 0; j < H; j++) {
    const y = oy + (j + 0.5) * res;
    xs.length = 0;
    for (const l of loops) {
      const m = l.length / 2;
      for (let a = 0, b = m - 1; a < m; b = a++) {
        const ya = l[2 * a + 1], yb = l[2 * b + 1];
        if ((ya > y) !== (yb > y)) xs.push(l[2 * a] + ((y - ya) * (l[2 * b] - l[2 * a])) / (yb - ya));
      }
    }
    xs.sort((p, q) => p - q);
    for (let q = 0; q + 1 < xs.length; q += 2) {
      const i0 = Math.max(0, Math.ceil((xs[q] - ox) / res - 0.5)), i1 = Math.min(W - 1, Math.floor((xs[q + 1] - ox) / res - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * W + i] = 1;
    }
  }
  const fin = new Float32Array(n), fout = new Float32Array(n);
  for (let i = 0; i < n; i++) { fin[i] = mask[i] ? INF : 0; fout[i] = mask[i] ? 0 : INF; }
  edt(fin, W, H);
  edt(fout, W, H);
  const sd = new Float32Array(n);
  let maxSd = -Infinity, minSd = Infinity;
  for (let i = 0; i < n; i++) {
    // The outline lies half a pixel from the nearest pixel centre of the other side.
    const v = mask[i] ? -(Math.sqrt(fin[i]) - 0.5) * res : (Math.sqrt(fout[i]) - 0.5) * res;
    sd[i] = v;
    if (v > maxSd) maxSd = v;
    if (v < minSd) minSd = v;
  }
  return { sd, W, H, res, ox, oy, maxSd, minSd };
}

// ---- iso-contours (marching squares, same scheme as the outline tracer)

const T = 0, R_ = 1, B = 2, L = 3;
const CASES: number[][][] = [[], [[L, B]], [[B, R_]], [[L, R_]], [[T, R_]], [], [[T, B]], [[T, L]], [[T, L]], [[T, B]], [], [[T, R_]], [[L, R_]], [[R_, B]], [[L, B]], []];
const CX = [0, 1, 1, 0], CY = [0, 0, 1, 1], CBIT = [8, 4, 2, 1];

/**
 * Closed loops around { v >= level }, where v = sign * sd. Outside the field the
 * value is padIn ? +inf : -inf. Returns loops in mm, simplified to tol.
 */
function iso(f: Field, sign: 1 | -1, level: number, padIn: boolean, tol: number): number[][] {
  const { W, H } = f;
  const W2 = W + 2, H2 = H + 2;
  const lv = level + 1e-6;
  const pad = padIn ? INF : -INF;
  const val = (x: number, y: number) => (x < 1 || y < 1 || x > W || y > H ? pad : sign * f.sd[(y - 1) * W + (x - 1)]);
  const next = new Map<number, number>();
  const px = new Map<number, number>(), py = new Map<number, number>();
  const eid = (e: number, x: number, y: number) =>
    e === T ? 2 * (y * W2 + x) : e === B ? 2 * ((y + 1) * W2 + x) : e === L ? 2 * (y * W2 + x) + 1 : 2 * (y * W2 + x + 1) + 1;
  const ept = (e: number, x: number, y: number, c: number[], id: number) => {
    if (px.has(id)) return;
    const t = (a: number, b: number) => (a === b ? 0.5 : Math.max(0, Math.min(1, (lv - a) / (b - a))));
    let X: number, Y: number;
    if (e === T) { X = x + t(c[0], c[1]); Y = y; }
    else if (e === B) { X = x + t(c[3], c[2]); Y = y + 1; }
    else if (e === L) { X = x; Y = y + t(c[0], c[3]); }
    else { X = x + 1; Y = y + t(c[1], c[2]); }
    px.set(id, X); py.set(id, Y);
  };
  for (let y = 0; y < H2 - 1; y++) {
    for (let x = 0; x < W2 - 1; x++) {
      const c = [val(x, y), val(x + 1, y), val(x + 1, y + 1), val(x, y + 1)];
      const code = (c[0] >= lv ? 8 : 0) | (c[1] >= lv ? 4 : 0) | (c[2] >= lv ? 2 : 0) | (c[3] >= lv ? 1 : 0);
      if (code === 0 || code === 15) continue;
      let segs = CASES[code];
      if (code === 5 || code === 10) {
        const finite = c.map((v) => Math.max(-1e6, Math.min(1e6, v)));
        const centre = (finite[0] + finite[1] + finite[2] + finite[3]) / 4 >= lv;
        segs = code === 5 ? (centre ? [[T, L], [B, R_]] : [[T, R_], [L, B]]) : (centre ? [[T, R_], [L, B]] : [[T, L], [B, R_]]);
      }
      for (const [a, b] of segs) {
        const ea = eid(a, x, y), eb = eid(b, x, y);
        ept(a, x, y, c, ea); ept(b, x, y, c, eb);
        const ax = px.get(ea)!, ay = py.get(ea)!, dx = px.get(eb)! - ax, dy = py.get(eb)! - ay;
        const cr = [0, 0, 0, 0];
        let pos = 0, neg = 0;
        for (let q = 0; q < 4; q++) {
          cr[q] = dx * (y + CY[q] - ay) - dy * (x + CX[q] - ax);
          if (cr[q] > 1e-9) pos++; else if (cr[q] < -1e-9) neg++;
        }
        const lone = pos === 0 ? -1 : neg === 0 ? 1 : pos <= neg ? 1 : -1;
        let pick = -1, best = -1;
        for (let q = 0; q < 4; q++) {
          const side = cr[q] > 1e-9 ? 1 : cr[q] < -1e-9 ? -1 : 0;
          if (side === lone && Math.abs(cr[q]) > best) { best = Math.abs(cr[q]); pick = q; }
        }
        if (pick < 0) continue;
        const inside = (code & CBIT[pick]) !== 0;
        if ((lone > 0) === inside) next.set(ea, eb); else next.set(eb, ea);
      }
    }
  }
  const out: number[][] = [];
  for (const start of next.keys()) {
    if (!next.has(start)) continue;
    const pts: number[] = [];
    let cur: number | undefined = start;
    while (cur !== undefined && next.has(cur)) {
      // padded grid point i sits at pixel i-1's centre
      pts.push(f.ox + (px.get(cur)! - 0.5) * f.res, f.oy + (py.get(cur)! - 0.5) * f.res);
      const nx: number = next.get(cur)!;
      next.delete(cur);
      cur = nx;
    }
    if (pts.length >= 6) out.push(simplifyClosed(pts, tol));
  }
  return out;
}

function simplifyClosed(p: number[], tol: number): number[] {
  const n = p.length / 2;
  if (n < 4) return p;
  const keep = new Uint8Array(n + 1);
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = (p[2 * i] - p[0]) ** 2 + (p[2 * i + 1] - p[1]) ** 2; if (d > fd) { fd = d; far = i; } }
  keep[0] = keep[far] = keep[n] = 1;
  const X = (i: number) => p[2 * (i % n)], Y = (i: number) => p[2 * (i % n) + 1];
  const st: [number, number][] = [[0, far], [far, n]];
  while (st.length) {
    const [a, b] = st.pop()!;
    const ax = X(a), ay = Y(a), dx = X(b) - ax, dy = Y(b) - ay, l2 = dx * dx + dy * dy || 1e-12;
    let idx = -1, md = tol * tol;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((X(i) - ax) * dx + (Y(i) - ay) * dy) / l2));
      const d = (ax + t * dx - X(i)) ** 2 + (ay + t * dy - Y(i)) ** 2;
      if (d > md) { md = d; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; st.push([a, idx], [idx, b]); }
  }
  const o: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) o.push(p[2 * i], p[2 * i + 1]);
  return o;
}

// ---- what the passes actually cut, and the leftover

/** Achieved depth (below zTop) after V passes (cones) and flat end-mill passes (discs). */
function stamp(got: Float32Array, f: Field, cuts: Cut[], zTop: number, tool: { tan: number } | { R: number }) {
  const { W, H, res, ox, oy } = f;
  for (const c of cuts) {
    c.paths.forEach((p, pi) => {
      const n = p.length / 2, zs = c.zs?.[pi];
      const segs = c.closed ? n : n - 1;
      for (let k = 0; k < Math.max(1, segs); k++) {
        const k2 = n === 1 ? 0 : (k + 1) % n;
        const ax = p[2 * k], ay = p[2 * k + 1], bx = p[2 * k2], by = p[2 * k2 + 1];
        const da = zTop - (zs ? zs[k] : c.z), db = zTop - (zs ? zs[k2] : c.z);
        const reach = "tan" in tool ? Math.max(da, db) * tool.tan : tool.R;
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - ox) / res)), i1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx) + reach - ox) / res));
        const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - oy) / res)), j1 = Math.min(H - 1, Math.ceil((Math.max(ay, by) + reach - oy) / res));
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-12;
        for (let j = j0; j <= j1; j++) {
          const py = oy + (j + 0.5) * res;
          for (let i = i0; i <= i1; i++) {
            const px = ox + (i + 0.5) * res;
            const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
            const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
            const dep = da + t * (db - da);
            const cut = "tan" in tool ? dep - d / tool.tan : d <= tool.R ? dep : 0;
            if (cut > got[j * W + i]) got[j * W + i] = cut;
          }
        }
      }
    });
  }
}

/** Zhang-Suen thinning, in place (1 = foreground). */
function thin(m: Uint8Array, W: number, H: number) {
  const del: number[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!m[i]) continue;
        const p2 = m[i - W], p3 = m[i - W + 1], p4 = m[i + 1], p5 = m[i + W + 1], p6 = m[i + W], p7 = m[i + W - 1], p8 = m[i - 1], p9 = m[i - W - 1];
        const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (b < 2 || b > 6) continue;
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
        let a = 0;
        for (let q = 0; q < 8; q++) if (!seq[q] && seq[q + 1]) a++;
        if (a !== 1) continue;
        if (step === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
        del.push(i);
      }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
    }
  }
}

/** 8-connected skeleton -> polylines (pixel indices). */
function traceSkeleton(m: Uint8Array, W: number, H: number): number[][] {
  const nb = (i: number) => {
    const x = i % W, y = (i / W) | 0, o: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H && m[yy * W + xx]) o.push(yy * W + xx);
    }
    return o;
  };
  const used = new Set<string>();
  const ek = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const lines: number[][] = [];
  const walk = (start: number, next: number) => {
    const line = [start, next];
    used.add(ek(start, next));
    let prev = start, cur = next;
    for (;;) {
      const ns = nb(cur).filter((q) => q !== prev && !used.has(ek(cur, q)));
      if (nb(cur).length !== 2 || !ns.length) break; // junction or end
      used.add(ek(cur, ns[0]));
      line.push(ns[0]);
      prev = cur; cur = ns[0];
    }
    lines.push(line);
  };
  const pts: number[] = [];
  for (let i = 0; i < W * H; i++) if (m[i]) pts.push(i);
  for (const i of pts) { const n = nb(i); if (n.length !== 2) for (const q of n) if (!used.has(ek(i, q))) walk(i, q); if (!n.length) lines.push([i]); }
  for (const i of pts) for (const q of nb(i)) if (!used.has(ek(i, q))) walk(i, q); // loops
  return lines;
}

/**
 * Leftover cleanup: wherever the passes so far fall short of the ideal depth,
 * thin the shortfall to its centre line and run the V-bit along it with the
 * tip at the ideal depth of each point (never an overcut: the cone meets the
 * surface exactly at the outline). Repeats a few times on what is still left.
 */
function leftoverCuts(f: Field, sign: 1 | -1, done: { v: Cut[]; clear: Cut[]; R: number }, tan: number, depthOf: (v: number) => number, zTop: number): Cut[] {
  const { W, H, res, ox, oy } = f;
  const got = new Float32Array(W * H);
  stamp(got, f, done.v, zTop, { tan });
  if (done.R > 0) stamp(got, f, done.clear, zTop, { R: done.R });
  const out: Cut[] = [];
  for (let iter = 0; iter < 3; iter++) {
    const m = new Uint8Array(W * H);
    let any = false;
    for (let i = 0; i < W * H; i++) {
      const want = depthOf(sign * f.sd[i]);
      // 0.08 mm: above the ~0.05 mm the field and contour discretisation leave on good walls
      if (want > 0.02 && want - got[i] > 0.08) { m[i] = 1; any = true; }
    }
    if (!any) break;
    thin(m, W, H);
    const lines = traceSkeleton(m, W, H);
    if (!lines.length) break;
    const paths: number[][] = [], zs: number[][] = [];
    for (const line of lines) {
      if (line.length < 3) continue; // specks: a few hundredths of a mm, not worth a plunge
      const p: number[] = [], z: number[] = [];
      for (const i of line) { p.push(ox + ((i % W) + 0.5) * res, oy + (((i / W) | 0) + 0.5) * res); z.push(zTop - depthOf(sign * f.sd[i])); }
      if (p.length === 2) { p.push(p[0] + 0.01, p[1]); z.push(z[0]); }
      paths.push(p); zs.push(z);
    }
    if (!paths.length) break;
    const cut: Cut = { z: Math.min(...zs.map((a) => Math.min(...a))), paths, closed: false, zs };
    out.push(cut);
    stamp(got, f, [cut], zTop, { tan });
  }
  return out;
}

// ---- toolpath generators

export interface VParams { angle: number; step: number } // V-bit included angle (deg), contour spacing (mm)
export interface MillParams { dia: number; stepover: number; stepdown: number } // end mill; stepover as a fraction of dia
const RES = 0.1; // mm per field pixel
const TOL = 0.01; // mm path simplification

function bboxOf(loops: ArrayLike<number>[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of loops) for (let i = 0; i < l.length; i += 2) {
    x0 = Math.min(x0, l[i]); x1 = Math.max(x1, l[i]); y0 = Math.min(y0, l[i + 1]); y1 = Math.max(y1, l[i + 1]);
  }
  return { x0, y0, x1, y1 };
}

function resFor(wMm: number, hMm: number) {
  return Math.max(RES, Math.sqrt((wMm * hMm) / 9e6)); // keep fields under ~9 M pixels
}

/** Pocket into the base: end-mill floor clearing (optional), V-bit wall contours, leftover cleanup. */
export function pocketToolpaths(loops: Float32Array[], depth: number, v: VParams, mill: MillParams | null, zTop: number) {
  const tan = Math.tan(((v.angle / 2) * Math.PI) / 180);
  const R = mill ? mill.dia / 2 : 0;
  const b = bboxOf(loops);
  const m = 2;
  const res = resFor(b.x1 - b.x0 + 2 * m, b.y1 - b.y0 + 2 * m);
  const f = signedField(loops, b.x0 - m, b.y0 - m, b.x1 - b.x0 + 2 * m, b.y1 - b.y0 + 2 * m, res);
  const wall = depth * tan;
  const vcuts: Cut[] = [];
  const vMax = mill ? wall : -f.minSd; // with an end mill, the V-bit only does the walls
  for (let l = v.step; l <= vMax + 1e-9; l += v.step) {
    const paths = iso(f, -1, l, false, TOL);
    if (!paths.length) break;
    vcuts.push({ z: zTop - Math.min(depth, l / tan), paths, closed: true });
  }
  const clear: Cut[] = [];
  if (mill) {
    const levels: number[][][] = [];
    for (let l = wall + R; ; l += mill.dia * mill.stepover) {
      const paths = iso(f, -1, l, false, TOL);
      if (!paths.length) break;
      levels.push(paths);
    }
    const passes = Math.max(1, Math.ceil(depth / mill.stepdown - 1e-9));
    for (let k = 1; k <= passes; k++) {
      const z = zTop - (depth * k) / passes;
      for (let i = levels.length - 1; i >= 0; i--) clear.push({ z, paths: levels[i], closed: true }); // centre outwards
    }
  }
  vcuts.push(...leftoverCuts(f, -1, { v: vcuts, clear, R }, tan, (d) => Math.min(depth, Math.max(0, d / tan)), zTop));
  return { v: vcuts, clear };
}

/**
 * Plug on its own board (wMm x hMm), cut face down. Everything around the plug
 * shapes is lowered to plugDepth so the board clears the base when glued.
 */
export function plugToolpaths(loops: Float32Array[], wMm: number, hMm: number, startDepth: number, plugDepth: number, v: VParams, mill: MillParams | null) {
  const tan = Math.tan(((v.angle / 2) * Math.PI) / 180);
  const R = mill ? mill.dia / 2 : 0;
  const m = R + 1;
  const res = resFor(wMm + 2 * m, hMm + 2 * m);
  const f = signedField(loops, -m, -m, wMm + 2 * m, hMm + 2 * m, res);
  const S = startDepth, Pd = plugDepth;
  const vcuts: Cut[] = [];
  const vMax = mill ? (Pd - S) * tan : f.maxSd;
  for (let l = -S * tan + v.step; l <= vMax + 1e-9; l += v.step) {
    if (l > f.maxSd) break;
    const paths = iso(f, 1, l, true, TOL);
    if (!paths.length) break;
    vcuts.push({ z: -Math.min(Pd, Math.max(0, S + l / tan)), paths, closed: true });
  }
  const clear: Cut[] = [];
  if (mill) {
    const levels: number[][][] = [];
    for (let l = (Pd - S) * tan + R; l <= f.maxSd; l += mill.dia * mill.stepover) {
      const paths = iso(f, 1, l, true, TOL);
      if (paths.length) levels.push(paths);
    }
    const passes = Math.max(1, Math.ceil(Pd / mill.stepdown - 1e-9));
    for (let k = 1; k <= passes; k++) {
      const z = -(Pd * k) / passes;
      for (const paths of levels) clear.push({ z, paths, closed: true }); // from the plugs outwards
    }
  }
  vcuts.push(...leftoverCuts(f, 1, { v: vcuts, clear, R }, tan, (sd) => Math.min(Pd, Math.max(0, S + sd / tan)), 0));
  return { v: vcuts, clear };
}

/** Zigzag surfacing of the whole board from zStart down to zEnd. */
export function surfacingToolpaths(wMm: number, hMm: number, mill: MillParams, zStart: number, zEnd: number): Cut[] {
  const R = mill.dia / 2, step = mill.dia * mill.stepover;
  const x0 = -R - 1, x1 = wMm + R + 1;
  const ys: number[] = [];
  for (let y = 0; y < hMm + step; y += step) ys.push(Math.min(y, hMm));
  const zig: number[] = [];
  ys.forEach((y, i) => { if (i % 2) zig.push(x1, y, x0, y); else zig.push(x0, y, x1, y); });
  const cuts: Cut[] = [];
  const passes = Math.max(1, Math.ceil((zStart - zEnd) / mill.stepdown - 1e-9));
  for (let k = 1; k <= passes; k++) cuts.push({ z: zStart - ((zStart - zEnd) * k) / passes, paths: [zig], closed: false });
  return cuts;
}
