/// <reference lib="webworker" />
import { hexToLab } from "./core/color";
import { renderFlat, renderInlay, type RenderWood } from "./core/render";
import { simplify, type SimplifyResult } from "./core/simplify";

export interface JobRequest {
  id: number;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  pxPerMm: number;
  woods: RenderWood[];
  minFeatureMm: number;
  colorWeight: number;
  smoothing: number;
  sourcePx: number;
}

export interface JobResponse {
  id: number;
  result?: SimplifyResult;
  flat?: Uint8ClampedArray;
  inlay?: Uint8ClampedArray;
  ms?: number;
  error?: string;
}

self.onmessage = (e: MessageEvent<JobRequest>) => {
  const q = e.data;
  const t0 = performance.now();
  try {
    const result = simplify({
      rgba: q.rgba,
      width: q.width,
      height: q.height,
      pxPerMm: q.pxPerMm,
      woodLabs: q.woods.map((w) => hexToLab(w.color)),
      minFeatureMm: q.minFeatureMm,
      colorWeight: q.colorWeight,
      smoothing: q.smoothing,
      sourcePx: q.sourcePx,
    });
    const flat = renderFlat(result.labels, q.width, q.height, q.woods);
    const inlay = renderInlay(result.labels, q.width, q.height, q.pxPerMm, q.woods);
    const res: JobResponse = { id: q.id, result, flat, inlay, ms: performance.now() - t0 };
    (self as unknown as Worker).postMessage(res, [flat.buffer, inlay.buffer, result.labels.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: q.id, error: String(err) } satisfies JobResponse);
  }
};
