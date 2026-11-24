/// <reference lib="webworker" />
import { hexToLab } from "./core/color";
import type { PxEdit } from "./core/edits";
import { renderFlat, renderInlay, type RenderWood } from "./core/render";
import { finish, prepare, type Prepared, type SimplifyInput, type SimplifyResult } from "./core/simplify";
import { vectorize, type WoodOutline } from "./core/vectorize";

export interface JobRequest {
  id: number;
  /** Same key as the previous job = same image and settings: reuse the prepared regions. */
  baseKey: string;
  rgba: Uint8ClampedArray | null; // may be omitted when baseKey matches the cache
  width: number;
  height: number;
  pxPerMm: number;
  woods: RenderWood[];
  minFeatureMm: number;
  minAreaMm2: number;
  colorWeight: number;
  smoothing: number;
  sourcePx: number;
  edits: PxEdit[];
}

export interface JobResponse {
  id: number;
  result?: SimplifyResult;
  flat?: Uint8ClampedArray;
  inlay?: Uint8ClampedArray;
  outlines?: WoodOutline[];
  ms?: number;
  needRgba?: boolean; // the cache was empty: send the image again
  error?: string;
}

let cache: { key: string; prep: Prepared } | null = null;

const post = (msg: JobResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<JobRequest>) => {
  const q = e.data;
  const t0 = performance.now();
  try {
    const inp: SimplifyInput = {
      rgba: q.rgba ?? new Uint8ClampedArray(0),
      width: q.width,
      height: q.height,
      pxPerMm: q.pxPerMm,
      woodLabs: q.woods.map((w) => hexToLab(w.color)),
      minFeatureMm: q.minFeatureMm,
      minAreaMm2: q.minAreaMm2,
      colorWeight: q.colorWeight,
      smoothing: q.smoothing,
      sourcePx: q.sourcePx,
    };
    if (!cache || cache.key !== q.baseKey) {
      if (!q.rgba) { post({ id: q.id, needRgba: true }); return; }
      cache = { key: q.baseKey, prep: prepare(inp) };
    }
    const result = finish(cache.prep, inp, q.edits);
    const flat = renderFlat(result.labels, q.width, q.height, q.woods);
    const inlay = renderInlay(result.labels, q.width, q.height, q.pxPerMm, q.woods);
    const outlines = vectorize(result.labels, q.width, q.height, q.woods.length, q.pxPerMm);
    const transfer = [flat.buffer, inlay.buffer, result.labels.buffer] as ArrayBuffer[];
    for (const o of outlines) for (const l of o.loops) transfer.push(l.buffer as ArrayBuffer);
    post({ id: q.id, result, flat, inlay, outlines, ms: performance.now() - t0 }, transfer);
  } catch (err) {
    post({ id: q.id, error: String(err) });
  }
};
