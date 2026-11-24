import "./style.css";
import {
  boardLayout, DEFAULT_SETTINGS, derive, fmt, pxPerMm, SIZE_PRESETS, V_ANGLES, type Derived, type FitMode, type NumericSetting, type SizeMode,
} from "./core/machine";
import { loopToPath2D, loopToSvg, type WoodOutline } from "./core/vectorize";
import type { Edit, PxEdit } from "./core/edits";
import { removeBackground } from "./ai";
import { paintSeamlessTile, paintSwatch, seedFor } from "./core/grain";
import { planRounds, type SimplifyResult } from "./core/simplify";
import {
  MAX_TONES, presetById, TONE_THICKNESS, WOOD_KITS, WOOD_PRESETS, woodFromPreset, woodsFromKit, type Wood,
} from "./core/woods";
import {
  exportProject, fileName, importProject, lastProjectId, newProject, store, type Project,
} from "./project";
import ProcessWorker from "./worker?worker";
import type { JobRequest, JobResponse } from "./worker";

// ---------------------------------------------------------------- state

type View = "original" | "woods" | "inlay";
type Zoom = "fit" | "real" | "custom";

interface Work { w: number; h: number; ppm: number; wMm: number; hMm: number; rgba: ImageData; sourcePx: number; imgPerMm: number }
interface Result { res: SimplifyResult; flat: ImageData; inlay: ImageData; outlines: WoodOutline[]; paths: Path2D[]; ms: number }

let P: Project;
let bitmap: ImageBitmap | null = null;
let bitmapOf: Blob | null = null;
let imageUrl: string | null = null;
let work: Work | null = null;
let result: Result | null = null;
let view: View = "inlay";
let zoom: Zoom = "fit";
let customScale = 1; // screen px per mm when zoom === "custom"
let busy = false;
let pending = false;
let jobId = 0;
let workVersion = 0; // bumps whenever the working image changes
let sentKey = ""; // base key of the image the worker last received
let maskBitmap: ImageBitmap | null = null;
let maskOf: Blob | null = null;
let aiStatus = "";

type Tool = "fill" | "merge" | "brush" | "lasso";
let tool: Tool = "fill";
let activeWood = ""; // uid
let brushMm = 3;
let redo: Edit[] = [];
let spaceHeld = false;
let maskTool: "keep" | "cut" | null = null; // image step: fixing the AI mask

/** Is a drawing tool active on the stage (so the left button draws instead of panning)? */
function toolActive(): boolean {
  return P.step === "refine" || (P.step === "image" && !!maskTool && P.maskOn);
}

const CAL_KEY = "kundekar.cssPxPerMm";
let cssPxPerMm = Number(localStorage.getItem(CAL_KEY)) || 96 / 25.4;

const worker = new ProcessWorker();

// ---------------------------------------------------------------- helpers

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
}

// No native confirm(): browsers let users silence it, after which it always
// returns false. Changes apply immediately and the toast offers Undo instead.
function toast(msg: string, action?: { label: string; run: () => void }) {
  document.querySelectorAll(".toast").forEach((x) => x.remove());
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.append(msg);
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => { t.remove(); action.run(); };
    t.append(b);
  }
  document.body.append(t);
  setTimeout(() => t.remove(), action ? 8000 : 2600);
}

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function allWoods(): Wood[] {
  return [P.base, ...P.tones];
}

function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: number | undefined;
  return (...a: A) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); };
}

const STAR = `<svg viewBox="-12 -12 24 24" aria-hidden="true"><g stroke="currentColor" stroke-width=".9" stroke-linejoin="round">
  <rect x="-7.5" y="-7.5" width="15" height="15" fill="#e6d2a8"/><rect x="-7.5" y="-7.5" width="15" height="15" fill="#e6d2a8" transform="rotate(45)"/>
  <polygon points="0,-4.6 3.25,-3.25 4.6,0 3.25,3.25 0,4.6 -3.25,3.25 -4.6,0 -3.25,-3.25" fill="#5b3e2a"/></g></svg>`;

// ---------------------------------------------------------------- steps

interface Step {
  id: string;
  title: string;
  sub: string;
  phase: string;
  view: View;
  /** null = may continue; otherwise the reason it can't yet. */
  blocker: () => string | null;
  render: () => string;
}

const STEPS: Step[] = [
  {
    id: "image", title: "Image & size", sub: "Artwork, board size", phase: "Setup", view: "original",
    blocker: () => (P.image ? null : "Add an image to continue."), render: renderImage,
  },
  { id: "stock", title: "Wood stock", sub: "Base + tone boards", phase: "Setup", view: "inlay", blocker: () => null, render: renderStock },
  { id: "machine", title: "Bit & depths", sub: "V-bit, pocket, surfacing", phase: "Setup", view: "inlay", blocker: () => null, render: renderMachine },
  {
    id: "simplify", title: "Simplify", sub: "Wood regions", phase: "Setup", view: "inlay",
    blocker: () => (work ? null : "Add an image in step 1 first."), render: renderSimplify,
  },
  {
    id: "refine", title: "Refine", sub: "Fix regions by hand", phase: "Setup", view: "woods",
    blocker: () => "Rounds (step 6) is not built yet: it is the next milestone (MVP 2). Your setup is saved.",
    render: renderRefine,
  },
  {
    id: "rounds", title: "Rounds", sub: "Pocket · plug · glue · surface", phase: "Workshop", view: "inlay",
    blocker: () => "Not built yet.", render: () => "",
  },
];

function stepIndex(id = P.step) {
  return Math.max(0, STEPS.findIndex((s) => s.id === id));
}

/** A step can be opened when every step before it can be left. */
function reachable(i: number): boolean {
  if (STEPS[i].id === "rounds") return false;
  for (let j = 0; j < i; j++) if (STEPS[j].blocker() && STEPS[j].id !== "refine") return false;
  return true;
}

function goTo(id: string) {
  P.step = id;
  view = STEPS[stepIndex()].view;
  if (!result && view !== "original") view = "original";
  touch(false);
  renderAll();
  $(".panel")!.scrollTop = 0;
}

function next() {
  const i = stepIndex();
  if (STEPS[i].blocker()) return;
  if (!P.done[STEPS[i].id]) {
    P.done[STEPS[i].id] = Date.now();
    P.log.push({ t: Date.now(), text: `${STEPS[i].title} done` });
  }
  goTo(STEPS[i + 1].id);
}

// ---------------------------------------------------------------- persistence

let saveTimer: number | undefined;
function touch(reprocess: boolean) {
  P.updated = Date.now();
  $(".saved")?.classList.add("dirty");
  const s = $(".saved");
  if (s) s.textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 400);
  if (reprocess) scheduleProcess();
}

async function save() {
  await store.put(P);
  lastProjectId.set(P.id);
  const s = $(".saved");
  if (s) {
    s.classList.remove("dirty");
    s.textContent = "Saved " + new Date(P.updated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}

async function loadProject(p: Project) {
  P = p;
  P.settings = { ...DEFAULT_SETTINGS, ...p.settings }; // projects saved before a setting existed
  const old = p.settings as Partial<typeof P.settings> & { simplify?: number };
  if (old.minLineMm === undefined && old.simplify) {
    // Before v0.2 the line width was "bit limit × simplification".
    P.settings.minLineMm = Math.round(derive(P.settings, P.base, P.tones).minFeatureFine * old.simplify * 10) / 10;
  }
  P.edits ??= [];
  P.mask ??= null;
  P.maskOn ??= false;
  P.maskFixes ??= [];
  maskTool = null;
  redo = [];
  result = null;
  work = null;
  lastProjectId.set(p.id);
  await prepareImage();
  view = STEPS[stepIndex()].view;
  if (!work) view = "original";
  renderAll();
  scheduleProcess(0);
}

// ---------------------------------------------------------------- image + processing

async function prepareImage() {
  if (!P.image) {
    bitmap = null; bitmapOf = null; work = null;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null;
    return;
  }
  if (bitmapOf !== P.image) {
    bitmap = await createImageBitmap(P.image);
    bitmapOf = P.image;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(P.image);
  }
  if (maskOf !== P.mask) {
    maskBitmap = P.mask ? await createImageBitmap(P.mask) : null;
    maskOf = P.mask;
  }
  prepareWork();
}

function prepareWork() {
  if (!bitmap) { work = null; return; }
  const g = boardLayout(P.settings, bitmap.width, bitmap.height);
  if (P.settings.sizeMode === "image") P.settings.heightMm = Math.round(g.hMm * 10) / 10;
  const ppm = pxPerMm(g.wMm, g.hMm);
  const w = Math.max(8, Math.round(g.wMm * ppm)), h = Math.max(8, Math.round(g.hMm * ppm));
  const sx = w / g.wMm, sy = h / g.hMm;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.art.x * sx, g.art.y * sy, g.art.w * sx, g.art.h * sy);
  ctx.clip(); // "fill" crops to the artwork area; the border stays transparent = base wood
  ctx.drawImage(bitmap, g.draw.x * sx, g.draw.y * sy, g.draw.w * sx, g.draw.h * sy);
  if (P.maskOn && maskBitmap) {
    // Background removed: keep the subject; the rest turns transparent = base wood.
    const dw = Math.max(1, Math.round(g.draw.w * sx)), dh = Math.max(1, Math.round(g.draw.h * sy));
    const mc = new OffscreenCanvas(dw, dh);
    const m = mc.getContext("2d")!;
    m.drawImage(maskBitmap, 0, 0, dw, dh);
    for (const f of P.maskFixes) {
      m.beginPath();
      for (let i = 0; i < f.pts.length; i += 2) m.lineTo(f.pts[i] * dw, f.pts[i + 1] * dh);
      m.closePath();
      m.globalCompositeOperation = f.mode === "keep" ? "source-over" : "destination-out";
      m.fillStyle = "#fff";
      m.fill();
    }
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mc, g.draw.x * sx, g.draw.y * sy, g.draw.w * sx, g.draw.h * sy);
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.restore();
  workVersion++;
  work = {
    w, h, ppm: sx, wMm: g.wMm, hMm: g.hMm, rgba: ctx.getImageData(0, 0, w, h),
    sourcePx: Math.max(1, (g.draw.w * sx) / bitmap.width), imgPerMm: bitmap.width / g.draw.w,
  };
}

let processTimer: number | undefined;
function scheduleProcess(delay = 300) {
  clearTimeout(processTimer);
  processTimer = window.setTimeout(runJob, delay);
}

function runJob() {
  if (!work) { result = null; renderStage(); refreshLive(); return; }
  if (busy) { pending = true; return; }
  busy = true;
  pending = false;
  const d = derive(P.settings, P.base, P.tones);
  const woods = allWoods();
  // Everything except the hand edits: if unchanged, the worker reuses its regions.
  const baseKey = JSON.stringify([workVersion, P.settings, woods.map((w) => [w.uid, w.color]), d.minFeature]);
  const req: JobRequest = {
    id: ++jobId,
    baseKey,
    rgba: baseKey === sentKey ? null : work.rgba.data.slice(),
    edits: resolveEdits(),
    width: work.w,
    height: work.h,
    pxPerMm: work.ppm,
    woods: woods.map((w) => ({ color: w.color, figure: w.figure, seed: seedFor(w.uid) })),
    minFeatureMm: d.minFeature,
    minAreaMm2: P.settings.minAreaMm2,
    colorWeight: P.settings.colorWeight,
    smoothing: P.settings.smoothing,
    sourcePx: work.sourcePx,
  };
  sentKey = baseKey;
  worker.postMessage(req, req.rgba ? [req.rgba.buffer] : []);
  updateStatus();
}

/** Hand edits in working pixels; edits for a removed wood are skipped. */
function resolveEdits(): PxEdit[] {
  const g = placement();
  if (!g || !work) return [];
  const index = new Map(allWoods().map((w, i) => [w.uid, i]));
  const ppm = work.ppm, X = (u: number) => (g.draw.x + u * g.draw.w) * ppm, Y = (v: number) => (g.draw.y + v * g.draw.h) * ppm;
  const px = (pts: number[]) => pts.map((t, i) => (i % 2 ? Y(t) : X(t)));
  const out: PxEdit[] = [];
  for (const e of P.edits) {
    if (e.t === "merge") { out.push({ t: "merge", x: X(e.u), y: Y(e.v) }); continue; }
    const lab = index.get(e.wood);
    if (lab === undefined) continue;
    if (e.t === "fill") out.push({ t: "fill", x: X(e.u), y: Y(e.v), lab });
    else if (e.t === "brush") out.push({ t: "brush", pts: px(e.pts), r: e.r * g.draw.w * ppm, lab });
    else out.push({ t: "lasso", pts: px(e.pts), lab });
  }
  return out;
}

worker.onmessage = (e: MessageEvent<JobResponse>) => {
  const r = e.data;
  busy = false;
  if (r.needRgba) { sentKey = ""; runJob(); return; } // worker lost its cache: send the image again
  if (r.error) {
    toast("Processing failed: " + r.error);
  } else if (r.id === jobId && work && r.result && r.flat && r.inlay && r.outlines && r.flat.length === work.w * work.h * 4 && r.result.stats.length === allWoods().length) {
    const firstResult = !result;
    result = {
      res: r.result,
      outlines: r.outlines,
      paths: r.outlines.map((o) => { const p = new Path2D(); for (const l of o.loops) loopToPath2D(p, l); return p; }),
      flat: new ImageData(r.flat as Uint8ClampedArray<ArrayBuffer>, work.w, work.h),
      inlay: new ImageData(r.inlay as Uint8ClampedArray<ArrayBuffer>, work.w, work.h),
      ms: r.ms ?? 0,
    };
    if (firstResult && P.step !== "image") view = STEPS[stepIndex()].view;
    renderStage();
    clearInk();
    refreshLive();
  }
  if (pending) runJob();
  else updateStatus();
};

/** The AI mask, its fixes and the hand edits all belong to one image. */
function forgetImageWork() {
  P.mask = null; P.maskOn = false; P.maskFixes = [];
  P.edits = []; redo = [];
  maskTool = null;
}

async function setImage(file: Blob, name: string) {
  if (!file.type.startsWith("image/")) { toast("That file is not an image."); return; }
  forgetImageWork();
  P.image = file;
  P.imageName = name;
  P.log.push({ t: Date.now(), text: `Image: ${name}` });
  result = null;
  try {
    await prepareImage();
  } catch {
    P.image = null; P.imageName = null;
    await prepareImage();
    toast("Could not read that image.");
  }
  view = "original";
  touch(true);
  renderAll();
}

// ---------------------------------------------------------------- shell

function renderAll() {
  app.innerHTML = `
    <header class="mast">
      <a class="brand" href="./" aria-label="Kündekâr home">${STAR}<div><h1>Kündekâr</h1><small>V-carve inlay workshop</small></div></a>
      <div class="proj">
        <label class="sr" for="pname">Project name</label>
        <input id="pname" type="text" value="${esc(P.name)}" maxlength="80" />
        <span class="saved">Saved</span>
      </div>
      <div class="mast-actions">
        <button class="btn ghost small" data-act="projects">Projects</button>
        <button class="btn ghost small" data-act="export" title="Download this project as a file">Export</button>
        <button class="btn ghost small" data-act="import" title="Open a project file">Import</button>
        <input type="file" id="importFile" accept=".json,application/json" hidden />
      </div>
    </header>
    <nav class="rail" aria-label="Steps"></nav>
    <main class="bench">
      <section class="panel" aria-live="polite"></section>
      <section class="stage" aria-label="Preview"></section>
    </main>
    <footer class="foot"></footer>`;
  renderRail();
  renderPanel();
  renderStageShell();
  renderFoot();
  bindShell();
}

function renderRail() {
  let html = "", phase = "";
  STEPS.forEach((s, i) => {
    if (s.phase !== phase) { phase = s.phase; html += `<div class="phase">${phase}</div>`; }
    const cur = s.id === P.step ? ` aria-current="step"` : "";
    const done = P.done[s.id] ? " done" : "";
    const dis = reachable(i) ? "" : " disabled";
    const num = P.done[s.id] && s.id !== P.step ? "✓" : String(i + 1).padStart(2, "0");
    html += `<button class="${done}" data-goto="${s.id}"${cur}${dis}><span class="num">${num}</span><span class="t">${s.title}</span><span class="s">${s.sub}</span></button>`;
  });
  $(".rail")!.innerHTML = html;
}

function renderFoot() {
  const i = stepIndex();
  const blocker = STEPS[i].blocker();
  $(".foot")!.innerHTML = `
    <button class="btn" data-act="back" ${i === 0 ? "disabled" : ""}>← Back</button>
    <span class="where">Step ${i + 1} of ${STEPS.length}</span>
    <span class="why">${blocker ? esc(blocker) : ""}</span>
    <button class="btn primary" data-act="next" ${blocker ? "disabled" : ""}>Next: ${STEPS[i + 1]?.title ?? ""} →</button>`;
}

function renderPanel() {
  const step = STEPS[stepIndex()];
  $(".panel")!.innerHTML = step.render();
  bindPanel();
  refreshLive();
}

function head(i: number, title: string, text: string) {
  return `<div class="panel-head"><div class="kicker">Step ${String(i).padStart(2, "0")} · ${STEPS[i - 1].phase}</div><h2>${title}</h2><p>${text}</p></div>`;
}

// ---------------------------------------------------------------- step panels

function presetOptions(w: Wood): string {
  const opts = WOOD_PRESETS.map((p) => `<option value="${p.id}" ${p.id === w.presetId ? "selected" : ""}>${p.name}</option>`).join("");
  return `${opts}<option value="" ${w.presetId ? "" : "selected"}>Custom wood…</option>`;
}

function woodCard(w: Wood, idx: number, isBase: boolean): string {
  const preset = presetById(w.presetId);
  return `<li class="wood ${isBase ? "base" : ""}" data-uid="${w.uid}">
    <div class="end"><canvas width="44" height="120" data-swatch="${w.uid}"></canvas><span class="idx">${isBase ? "BASE" : "T" + idx}</span></div>
    <div class="body">
      <div class="row"><select data-act="preset" aria-label="Species">${presetOptions(w)}</select></div>
      ${preset
        ? `<div class="local">${esc(preset.local)}</div>`
        : `<div class="row"><input type="text" data-act="name" value="${esc(w.name)}" aria-label="Wood name" maxlength="40" /></div>`}
      <div class="row">
        <input type="color" data-act="color" value="${w.color}" aria-label="Color of your board" title="Color of your board" />
        <label class="thick"><input type="number" data-act="thick" min="1" max="40" step="0.5" value="${w.thickness}" aria-label="Thickness" /><span class="unit">mm</span></label>
        <span class="profile" title="Edge view, to scale"><i style="height:${clamp(w.thickness * 1.6, 2, 22)}px;background:${w.color}"></i></span>
        <span class="acts">${isBase ? "" : `
          <button class="btn ghost small" data-act="mkbase" title="Use as base board">⇅ base</button>
          <button class="btn ghost small danger" data-act="remove" title="Remove" aria-label="Remove ${esc(w.name)}">✕</button>`}</span>
      </div>
    </div></li>`;
}

function renderStock(): string {
  const kits = WOOD_KITS.map((k) => {
    const bars = [k.base, ...k.tones].map((id) => `<i style="background:${presetById(id)!.color}"></i>`).join("");
    return `<button class="kit" data-kit="${k.id}" title="${esc(k.description)}"><span class="bars">${bars}</span><b>${k.name}</b></button>`;
  }).join("");
  return `${head(2, "Wood stock", "Choose the boards you really have. The base is the ~10 mm board everything is inlaid into; tone woods are the thinner boards the plugs are cut from. Set each color to match your actual board.")}
    <div class="sec"><h3>Start from a kit <span>replaces the list</span></h3><div class="kits">${kits}</div></div>
    <div class="sec"><h3>Your boards <span>${1 + P.tones.length} colors</span></h3>
      <div class="tag-label"><span>Base board</span></div>
      <ul class="woods">${woodCard(P.base, 0, true)}</ul>
      <div class="tag-label"><span>Tone woods</span><span>${P.tones.length} / ${MAX_TONES}</span></div>
      <ul class="woods">${P.tones.map((t, i) => woodCard(t, i + 1, false)).join("")}</ul>
      <p><button class="btn small" data-act="addTone" ${P.tones.length >= MAX_TONES ? "disabled" : ""}>+ Add tone wood</button></p>
    </div>
    <div class="sec" data-live="warns"></div>`;
}

function renderImage(): string {
  const s = P.settings;
  const img = P.image && bitmap
    ? `<div class="imgmeta"><img src="${imageUrl}" alt="" /><div><b>${esc(P.imageName ?? "Image")}</b>
         <div class="muted mono">${bitmap.width} × ${bitmap.height} px</div>
         <p style="margin:6px 0 0"><button class="btn small" data-act="pick">Replace</button>
         <button class="btn small ghost danger" data-act="clearImage">Remove</button></p></div></div>`
    : `<div class="drop" data-act="pick" tabindex="0" role="button"><b>Drop an image here</b>
         <span class="muted">or click to choose · or paste with Ctrl+V<br/>PNG, JPG, WebP · transparent areas become base wood</span></div>`;
  const board = s.sizeMode === "board";
  const chips = SIZE_PRESETS.map((p, i) => `<button class="chip" data-preset="${i}">${p.label} · ${board ? `${p.widthMm}×${p.heightMm}` : p.widthMm}</button>`).join("");
  const modes: [SizeMode, string][] = [["image", "Follow the image"], ["board", "Enter board size"]];
  const fits: [FitMode, string, string][] = [
    ["contain", "Fit", "Whole image visible; leftover space becomes base wood."],
    ["cover", "Fill", "Image fills the board; the overflow is cropped."],
    ["stretch", "Stretch", "Image is distorted to the board's proportions."],
    ["custom", "Free", "Your own size and position. Drag the image on the preview; drag a corner to resize."],
  ];
  return `${head(1, "Image & size", "Detailed artwork is welcome: it will be reduced to your woods in step 4. Size the base board to match the image, or enter your board and place the image on it.")}
    <div class="sec"><h3>Artwork</h3>${img}<input type="file" id="imageFile" accept="image/*" hidden /></div>
    ${P.image ? `<div class="sec"><h3>Background <span>AI · runs in your browser</span></h3>
      ${P.mask
        ? `<label class="check"><input type="checkbox" data-act="maskOn" ${P.maskOn ? "checked" : ""} /> Remove background (keep the subject only)</label>
           ${P.maskOn ? `<div class="field" style="margin:12px 0 0"><label>Fix the mask</label>
             <span class="seg" role="group" aria-label="Fix the mask">
               <button data-masktool="keep" aria-pressed="${maskTool === "keep"}">+ Keep area</button><button data-masktool="cut" aria-pressed="${maskTool === "cut"}">− Cut area</button></span>
             <span class="hint">${maskTool
               ? `Draw around the area on the preview. <b>${maskTool === "keep" ? "Keep" : "Cut"}</b> stays selected for more; click it again when done. Hold <kbd>Space</kbd> to pan.`
               : "The AI missed a part (a shoulder, a hand)? Choose <b>Keep area</b> and draw around it. Left something it shouldn't? Use <b>Cut area</b>."}</span></div>` : ""}
           <p style="margin:8px 0 0;display:flex;gap:6px;flex-wrap:wrap">
             ${P.maskFixes.length ? `<button class="btn small" data-act="undoMaskFix">↶ Undo last fix (${P.maskFixes.length})</button>` : ""}
             <button class="btn small ghost danger" data-act="dropMask">Discard the mask</button></p>`
        : `<button class="btn small" data-act="removeBg" ${aiStatus ? "disabled" : ""}>✦ Remove background</button>`}
      <p class="hint" data-live="aiStatus">${aiStatus ? esc(aiStatus) : "Finds the person (or main subject); everything else becomes base wood. Works best on people and clear subjects. The first use downloads a ~45 MB model; your image is never uploaded."}</p>
    </div>` : ""}
    <div class="sec"><h3>Base board size</h3>
      <div class="field"><span class="seg" role="group" aria-label="Size mode">${modes.map(([m, l]) => `<button data-sizemode="${m}" aria-pressed="${s.sizeMode === m}">${l}</button>`).join("")}</span></div>
      <div class="chips" style="margin-bottom:12px">${chips}</div>
      <div class="field"><label for="f-widthMm">Width</label><span><input id="f-widthMm" type="number" min="20" max="2000" step="1" value="${s.widthMm}" data-set="widthMm" /><span class="unit">mm</span></span></div>
      <div class="field"><label for="f-heightMm">Height</label><span>${board
        ? `<input id="f-heightMm" type="number" min="20" max="2000" step="1" value="${s.heightMm}" data-set="heightMm" /><span class="unit">mm</span>`
        : `<output class="mono" data-live="hOut"></output>`}</span>
        <span class="hint">${board ? `<button class="btn small ghost" data-act="swapWH">⇄ Swap width and height</button>` : "Follows the image's proportions."}</span></div>
      <div class="field"><label for="f-marginMm">Border</label><span><input id="f-marginMm" type="number" min="0" max="200" step="1" value="${s.marginMm}" data-set="marginMm" /><span class="unit">mm</span></span>
        <span class="hint">Plain base wood around the artwork, e.g. room for registration pins.</span></div>
      ${board ? "" : `<p class="muted" style="font-size:12.5px;margin:4px 0 0">To resize or move the image on a board of fixed size, choose <b>Enter board size</b>.</p>`}
    </div>
    ${board ? `<div class="sec"><h3>Image on the board</h3>
      <div class="field"><span class="seg" role="group" aria-label="Image placement">${fits.map(([f, l]) => `<button data-fit="${f}" aria-pressed="${s.fit === f}">${l}</button>`).join("")}</span>
      <span class="hint">${fits.find((f) => f[0] === s.fit)![2]}</span></div>
      <div class="field"><label for="f-imgWidthMm">Image width</label><span><input id="f-imgWidthMm" type="number" min="5" max="5000" step="1" data-place="imgWidthMm" /><span class="unit">mm</span></span>
        <span class="hint" data-live="imgHOut"></span></div>
      <div class="field"><label for="f-imgX">From left</label><span><input id="f-imgX" type="number" min="-5000" max="5000" step="1" data-place="imgX" /><span class="unit">mm</span></span></div>
      <div class="field"><label for="f-imgY">From top</label><span><input id="f-imgY" type="number" min="-5000" max="5000" step="1" data-place="imgY" /><span class="unit">mm</span></span></div>
      <p style="margin:0"><button class="btn small" data-act="centerImg">Center on board</button></p>
    </div>` : ""}
    <div class="sec"><h3>Result</h3><dl class="readout" data-live="size"></dl></div>`;
}

function numField(key: NumericSetting, label: string, hint: string, min: number, max: number, step: number) {
  return `<div class="field"><label for="f-${key}">${label}</label>
    <span><input id="f-${key}" type="number" min="${min}" max="${max}" step="${step}" value="${P.settings[key]}" data-set="${key}" /><span class="unit">mm</span></span>
    <span class="hint">${hint}</span></div>`;
}

function renderMachine(): string {
  const s = P.settings;
  const angles = V_ANGLES.map((a) => `<button data-angle="${a}" aria-pressed="${a === s.vAngle}">${a}°</button>`).join("");
  return `${head(3, "Bit & depths", "These numbers decide how fine the inlay can be. A V-bit cuts narrower where it cuts shallower, and every surfacing pass shaves earlier inlays thinner.")}
    <div class="sec"><h3>V-bit angle</h3>
      <div class="field"><span class="seg" role="group" aria-label="V-bit angle">${angles}</span>
      <span><input type="number" min="10" max="150" step="1" value="${s.vAngle}" data-set="vAngle" aria-label="Custom angle" /><span class="unit">°</span></span>
      <span class="hint">90° is the default for inlays; 60° holds finer detail but needs more passes.</span></div>
    </div>
    <div class="sec"><h3>Depths</h3>
      ${numField("pocketDepth", "Pocket depth", "How deep pockets are cut into the base.", 0.5, 6, 0.1)}
      ${numField("glueGap", "Glue gap", "Plugs are cut this much deeper so they bottom out on the walls, not the floor.", 0, 2, 0.1)}
      ${numField("surfacePerRound", "Surfacing per round", "Removed from the base each time you flatten after gluing.", 0.02, 1, 0.01)}
      ${numField("minRetained", "Thinnest edge kept", "The shallowest inlay edge worth keeping after all surfacing.", 0.1, 3, 0.1)}
    </div>
    <div class="sec"><h3>Cross-section <span>to scale, top of the base board</span></h3><div data-live="section"></div></div>
    <div class="sec"><h3>What this means</h3><dl class="readout" data-live="derived"></dl></div>
    <div class="sec" data-live="warns"></div>`;
}

function renderSimplify(): string {
  const s = P.settings;
  return `${head(4, "Simplify", "The image is reduced to your woods. Lines that are too thin and areas that are too small are merged into the woods around them.")}
    <div class="sec"><h3>Controls</h3>
      <div class="field range"><label for="r-line">Thinnest line</label><output class="mono" data-live="lineOut"></output>
        <input id="r-line" type="range" min="0" max="10" step="0.1" value="${s.minLineMm}" data-set="minLineMm" />
        <span class="hint">Lines, strips and necks thinner than this disappear into their neighbours. It never goes below what your bit can hold.</span></div>
      <div class="field range"><label for="r-area">Smallest area</label><output class="mono" data-live="areaOut"></output>
        <input id="r-area" type="range" min="0" max="100" step="0.5" value="${s.minAreaMm2}" data-set="minAreaMm2" />
        <span class="hint">Dots and islands smaller than this are filled by the wood around them.</span></div>
      <div class="field range"><label for="r-color">Match by</label><output class="mono" data-live="colorOut"></output>
        <input id="r-color" type="range" min="0" max="1.5" step="0.05" value="${s.colorWeight}" data-set="colorWeight" />
        <span class="hint">Left: light/dark only, like an engraving. Right: hue matters more.</span></div>
      <div class="field range"><label for="r-smooth">Edge smoothing</label><output class="mono" data-live="smoothOut"></output>
        <input id="r-smooth" type="range" min="0" max="1" step="0.05" value="${s.smoothing}" data-set="smoothing" />
        <span class="hint">Rounds off jagged, pixel-stepped borders. Higher also softens sharp corners.</span></div>
    </div>
    <div class="sec"><h3>Wood usage</h3><div data-live="stats"></div></div>
    <div class="sec"><h3>Round plan <span>preview</span></h3><div data-live="rounds"></div></div>
    <div class="sec" data-live="warns"></div>`;
}

const TOOLS: [Tool, string, string][] = [
  ["fill", "Fill", "Click a region to change it to the selected wood."],
  ["merge", "Remove", "Click a region to remove it: the wood around it fills in."],
  ["brush", "Brush", "Paint with the selected wood."],
  ["lasso", "Lasso", "Draw around an area to turn it all into the selected wood, e.g. the base wood to clear a background."],
];

function renderRefine(): string {
  const woods = allWoods();
  if (!woods.some((w) => w.uid === activeWood)) activeWood = woods[1]?.uid ?? woods[0].uid;
  const palette = woods.map((w, i) => `<button class="woodpick" data-pick-wood="${w.uid}" aria-pressed="${w.uid === activeWood}">
      <span class="dot" style="background:${w.color}"></span>${esc(w.name)}${i === 0 ? ' <span class="muted">(base)</span>' : ""}</button>`).join("");
  return `${head(5, "Refine", "Fix what the automatic pass got wrong. Edits stay attached to the image and are re-applied when you change woods or settings. The thinnest-line and smallest-area rules still apply.")}
    <div class="sec"><h3>Tool</h3>
      <div class="field"><span class="seg" role="group" aria-label="Tool">${TOOLS.map(([t, l]) => `<button data-tool="${t}" aria-pressed="${t === tool}">${l}</button>`).join("")}</span>
      <span class="hint">${TOOLS.find((t) => t[0] === tool)![2]} Hold <kbd>Space</kbd> and drag (or use the middle button) to pan; the wheel zooms.</span></div>
    </div>
    ${tool === "merge" ? "" : `<div class="sec"><h3>Wood</h3><div class="palette">${palette}</div></div>`}
    ${tool === "brush" ? `<div class="sec"><div class="field range"><label for="r-brush">Brush size</label><output class="mono">${fmt(brushMm * 2, 1)} mm</output>
      <input id="r-brush" type="range" min="0.5" max="20" step="0.5" value="${brushMm}" data-brush /></div></div>` : ""}
    <div class="sec"><h3>History <span>${P.edits.length} edit${P.edits.length === 1 ? "" : "s"}</span></h3>
      <p style="margin:0;display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn small" data-act="undo" ${P.edits.length ? "" : "disabled"} title="Ctrl+Z">↶ Undo</button>
        <button class="btn small" data-act="redo" ${redo.length ? "" : "disabled"} title="Ctrl+Y">↷ Redo</button>
        <button class="btn small ghost danger" data-act="clearEdits" ${P.edits.length ? "" : "disabled"}>Clear all edits</button></p>
    </div>
    <div class="sec"><h3>Wood usage</h3><div data-live="stats"></div></div>
    <div class="sec" data-live="warns"></div>`;
}

function pushEdit(e: Edit) {
  P.edits.push(e);
  redo = [];
  touch(false);
  scheduleProcess(0);
  if (P.step === "refine") renderPanel();
}

function undoMaskFix() {
  if (!P.maskFixes.pop()) return;
  sizeChanged(P.step === "image");
}

function undoEdit() {
  if (P.step === "image") { undoMaskFix(); return; }
  const e = P.edits.pop();
  if (!e) return;
  redo.push(e);
  touch(false); scheduleProcess(0);
  if (P.step === "refine") renderPanel();
}

function redoEdit() {
  const e = redo.pop();
  if (!e) return;
  P.edits.push(e);
  touch(false); scheduleProcess(0);
  if (P.step === "refine") renderPanel();
}

// ---------------------------------------------------------------- live readouts

function refreshLive() {
  const d = derive(P.settings, P.base, P.tones);
  const set = (k: string, html: string) => $$(`[data-live="${k}"]`).forEach((el) => (el.innerHTML = html));

  set("warns", d.warnings.length
    ? `<ul class="warns">${d.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`
    : `<div class="ok">Boards and depths are compatible.</div>`);

  set("derived", `
    <dt>Surfacing over ${Math.max(1, P.tones.length)} rounds (worst case)</dt><dd>${fmt(d.surfTotal)} mm</dd>
    <dt>Depth an edge must reach</dt><dd>${fmt(d.needDepth)} mm</dd>
    <dt>Plug depth</dt><dd>${fmt(d.plugDepth)} mm</dd>
    <dt>Narrowest region the bit can hold</dt><dd class="big">${fmt(d.minFeatureFine, 1)} mm</dd>`);

  set("section", sectionSvg(d));

  if (work) {
    set("hOut", `${fmt(work.hMm, 1)} mm`);
    set("size", `<dt>Board</dt><dd>${fmt(work.wMm, 1)} × ${fmt(work.hMm, 1)} mm</dd>
      <dt>Image detail</dt><dd>${fmt(work.imgPerMm, 1)} px/mm</dd>
      ${work.imgPerMm < 1.5 ? `<dt class="muted" style="grid-column:1/-1;font-size:12px">Low resolution for this size: edges will be smoothed. A larger image gives finer detail.</dt>` : ""}
      <dt>Working resolution</dt><dd>${work.w} × ${work.h} px</dd>
      <dt>Pixel size</dt><dd>${fmt(1 / work.ppm, 2)} mm</dd>
      <dt>Thinnest line kept</dt><dd>${fmt(d.minFeature, 1)} mm</dd>`);
  } else {
    set("hOut", "after an image is added");
    set("size", `<dt class="muted">Add an image to see the board layout.</dt><dd></dd>`);
  }

  syncPlacementFields();
  set("lineOut", P.settings.minLineMm <= d.minFeatureFine
    ? `${fmt(d.minFeatureFine, 1)} mm (bit limit)`
    : `${fmt(P.settings.minLineMm, 1)} mm`);
  set("areaOut", P.settings.minAreaMm2 <= 0 ? "off" : `${fmt(P.settings.minAreaMm2, 1)} mm² (⌀ ${fmt(2 * Math.sqrt(P.settings.minAreaMm2 / Math.PI), 1)} mm)`);
  set("smoothOut", P.settings.smoothing === 0 ? "off" : `${Math.round(P.settings.smoothing * 100)}%`);
  set("colorOut", P.settings.colorWeight < 0.15 ? "lightness" : P.settings.colorWeight > 0.9 ? "color" : "balanced");

  const woods = allWoods();
  if (!work) {
    set("stats", `<p class="muted">Add an image in step 1 to see how much of each wood you need.</p>`);
    set("rounds", "");
  } else if (!result) {
    set("stats", `<p class="muted busy">Reducing the image to your woods</p>`);
    set("rounds", "");
  } else {
    const { stats, adjacency, releasedPct } = result.res;
    const total = stats.reduce((a, s) => a + s.pixels, 0) || 1;
    const rows = stats.map((s, i) => `<tr><td><span class="dot" style="background:${woods[i].color}"></span>${esc(woods[i].name)}${i === 0 ? ' <span class="muted">(base)</span>' : ""}</td>
      <td class="n">${fmt(s.areaMm2 / 100, 1)}</td><td class="n">${fmt((100 * s.pixels) / total, 1)}%</td><td class="n">${s.islands}</td></tr>`).join("");
    set("stats", `<table class="stats"><thead><tr><th>Wood</th><th class="n">cm²</th><th class="n">Share</th><th class="n">Islands</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted" style="margin:8px 0 0;font-size:12px">Cleanup moved ${fmt(releasedPct, 1)}% of the area into neighbouring woods.</p>`);
    const rounds = planRounds(adjacency, stats);
    const unused = stats.map((s, i) => (i > 0 && s.pixels === 0 ? woods[i].name : null)).filter(Boolean);
    set("rounds", rounds.length
      ? `<ol class="rounds">${rounds.map((r) => `<li>${r.map((i) => `<span><span class="dot" style="background:${woods[i].color}"></span>${esc(woods[i].name)}</span>`).join(" ")}</li>`).join("")}</ol>
         <p class="muted" style="margin:8px 0 0;font-size:12px">Woods that never touch share a round. Largest areas go first. ${unused.length ? `Not used: ${esc(unused.join(", "))}.` : ""}</p>`
      : `<p class="muted">Only the base wood is left. Try lower simplification.</p>`);
  }
  updateStatus();
}

/** To-scale V-carve cross-section of the top of the base board. */
function sectionSvg(d: Derived): string {
  const s = P.settings;
  const tan = Math.tan(((s.vAngle / 2) * Math.PI) / 180);
  const W = 22, H = 4.5;
  const D = Math.min(s.pocketDepth, H - 0.5);
  const wideL = 1.6, wideR = 11;
  const vx = 15.5, half = Math.min(d.minFeatureFine / 2, 3), vd = Math.min(d.needDepth, H - 0.5);
  const mid = (wideL + wideR) / 2;
  const floorL = Math.min(wideL + D * tan, mid), floorR = Math.max(wideR - D * tan, mid);
  const wideD = floorL === floorR ? (floorL - wideL) / tan : D;
  const base = P.base.color, tone = P.tones[0]?.color ?? "#5b3e2a";
  const brk = `L${W} ${H - 0.25} L${W - 1.5} ${H} L${W - 3} ${H - 0.3} L${W - 4.5} ${H}`;
  const outline = `M0 0 L${wideL} 0 L${floorL} ${wideD} L${floorR} ${wideD} L${wideR} 0 L${vx - half} 0 L${vx} ${vd} L${vx + half} 0 L${W} 0 ${brk} L0 ${H} Z`;
  const plugs = `M${wideL} 0 L${floorL} ${wideD} L${floorR} ${wideD} L${wideR} 0 Z M${vx - half} 0 L${vx} ${vd} L${vx + half} 0 Z`;
  const st = d.surfTotal, keepBot = Math.min(st + s.minRetained, vd);
  const mono = `font-family="IBM Plex Mono, monospace"`;
  const ly = H + 1.3;
  return `<svg class="section-svg" viewBox="-1.4 -2.4 ${W + 2.4} ${H + 5.2}" role="img" aria-label="Cross-section of a pocket and the narrowest V cut">
    <defs><pattern id="hatch" width=".5" height=".5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2=".5" stroke="#a8402a" stroke-width=".09" opacity=".6"/></pattern></defs>
    <path d="${outline}" fill="${base}" stroke="#231c15" stroke-width=".06"/>
    <path d="${plugs}" fill="${tone}" opacity=".92"/>
    <rect x="0" y="0" width="${W}" height="${st}" fill="url(#hatch)"/>
    <line x1="-.4" x2="${W + .4}" y1="${st}" y2="${st}" stroke="#a8402a" stroke-width=".06" stroke-dasharray=".35 .2"/>
    <line x1="${wideL - .6}" x2="${wideL - .6}" y1="0" y2="${wideD}" stroke="#231c15" stroke-width=".05"/>
    <text x="${wideL - .85}" y="${wideD / 2}" text-anchor="middle" font-size=".7" ${mono} transform="rotate(-90 ${wideL - .85} ${wideD / 2})">${fmt(wideD, 1)} mm</text>
    <text x="${mid}" y="${Math.min(wideD + 0.95, H - .25)}" text-anchor="middle" font-size=".75" ${mono}>pocket · ${s.vAngle}°</text>
    <line x1="${vx - half}" x2="${vx + half}" y1="-.8" y2="-.8" stroke="#1c6b66" stroke-width=".07"/>
    <line x1="${vx - half}" x2="${vx - half}" y1="-1.15" y2="-.2" stroke="#1c6b66" stroke-width=".05"/>
    <line x1="${vx + half}" x2="${vx + half}" y1="-1.15" y2="-.2" stroke="#1c6b66" stroke-width=".05"/>
    <text x="${vx}" y="-1.35" text-anchor="middle" font-size=".8" fill="#1c6b66" ${mono}>${fmt(d.minFeatureFine, 1)} mm narrowest</text>
    <line x1="${vx + half + .35}" x2="${vx + half + .35}" y1="${st}" y2="${keepBot}" stroke="#231c15" stroke-width=".05"/>
    <text x="${vx + half + .6}" y="${(st + keepBot) / 2 + .25}" font-size=".7" ${mono}>${fmt(s.minRetained, 1)} kept</text>
    <rect x="0" y="${ly - .55}" width="1.4" height=".7" fill="url(#hatch)" stroke="#a8402a" stroke-width=".04"/>
    <text x="1.9" y="${ly}" font-size=".72" fill="#4a3f33" ${mono}>surfaced away over ${Math.max(1, P.tones.length)} rounds: ${fmt(st)} mm</text>
    <rect x="0" y="${ly + .55}" width="1.4" height=".7" fill="${tone}" stroke="#231c15" stroke-width=".04"/>
    <text x="1.9" y="${ly + 1.1}" font-size=".72" fill="#4a3f33" ${mono}>plug (tone wood)</text>
  </svg>`;
}

// ---------------------------------------------------------------- stage

function renderStageShell() {
  const views: [View, string][] = [["original", "Original"], ["woods", "Woods"], ["inlay", "Inlay"]];
  $(".stage")!.innerHTML = `
    <div class="stage-bar">
      <span class="seg" role="group" aria-label="Preview">${views.map(([v, l]) => `<button data-view="${v}" aria-pressed="${v === view}">${l}</button>`).join("")}</span>
      <span class="seg" role="group" aria-label="Zoom"><button data-zoom="fit" aria-pressed="${zoom === "fit"}">Fit</button><button data-zoom="real" aria-pressed="${zoom === "real"}" title="Shown at real physical size">1 : 1 real size</button></span>
      <span class="spacer"></span>
      <button class="btn small" data-act="calibrate" title="Make 1:1 match your screen">Calibrate screen</button>
      <button class="btn small" data-act="png" ${work ? "" : "disabled"} title="Raster image at working resolution">Save PNG</button>
      <button class="btn small" data-act="svg" ${result ? "" : "disabled"} title="Vector outlines of every wood, in millimetres">Save SVG</button>
    </div>
    <div class="stage-scroll"></div>
    <div class="stage-foot"></div>`;
  bindStageScroll();
  renderStage();
}

function renderStage() {
  const scroll = $(".stage-scroll");
  if (!scroll) return;
  $$<HTMLButtonElement>("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
  const png = $<HTMLButtonElement>('[data-act="png"]');
  if (png) png.disabled = !work;
  const svg = $<HTMLButtonElement>('[data-act="svg"]');
  if (svg) svg.disabled = !result;
  if (!work) {
    scroll.innerHTML = `<div class="stage-empty"><div>${STAR.replace("<svg", '<svg style="color:#e9dfcd"')}
      <h3>No image yet</h3><p>Add artwork in step 1 (Image & size), or drop an image anywhere on this page.</p></div></div>`;
    updateStatus();
    return;
  }
  if (!$("canvas.view", scroll)) {
    scroll.innerHTML = `<div class="stage-grid"><div class="corner">mm</div><canvas class="rx"></canvas><canvas class="ry"></canvas>
      <div class="viewbox"><canvas class="view"></canvas><canvas class="vec" aria-hidden="true"></canvas>
        <svg class="ink" preserveAspectRatio="none" aria-hidden="true"><path class="stroke"/><circle class="cursor" r="0"/></svg>
        <div class="artbox"></div>
        <div class="placer" title="Drag to move · drag a corner to resize"><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i><span class="pl-dim"></span></div>
      </div></div>`;
    bindPlacer();
  }
  const cv = $<HTMLCanvasElement>("canvas.view", scroll)!;
  cv.width = work.w; cv.height = work.h;
  const ctx = cv.getContext("2d")!;
  if (view === "original" || !result) {
    // Show the board in its base wood, with the image on top.
    const tmp = new OffscreenCanvas(work.w, work.h);
    tmp.getContext("2d")!.putImageData(work.rgba, 0, 0);
    ctx.fillStyle = P.base.color;
    ctx.fillRect(0, 0, work.w, work.h);
    ctx.drawImage(tmp, 0, 0);
  } else {
    ctx.putImageData(view === "woods" ? result.flat : result.inlay, 0, 0);
  }
  layoutStage();
  updateToolCursor();
  updateStatus();
}

function layoutStage() {
  const scroll = $(".stage-scroll");
  const grid = $(".stage-grid");
  if (!scroll || !grid || !work) return;
  const R = 24;
  const scale = currentScale();
  const W = Math.round(work.wMm * scale), H = Math.round(work.hMm * scale);
  grid.style.gridTemplateColumns = `${R}px ${W}px`;
  grid.style.gridTemplateRows = `${R}px ${H}px`;
  grid.style.marginTop = `${Math.max(0, (scroll.clientHeight - H - R - 24) / 2)}px`;
  const vb = $<HTMLElement>(".viewbox", grid)!;
  vb.style.width = W + "px"; vb.style.height = H + "px";
  $(".ink", vb)?.setAttribute("viewBox", `0 0 ${work.wMm} ${work.hMm}`);
  drawRuler($<HTMLCanvasElement>("canvas.rx", grid)!, W, R, scale, true);
  drawRuler($<HTMLCanvasElement>("canvas.ry", grid)!, H, R, scale, false);
  drawVector();
  positionPlacer();
}

// ---- Image placement on a board of fixed size

function placement() {
  return bitmap ? boardLayout(P.settings, bitmap.width, bitmap.height) : null;
}

/** Switch to free placement, starting from wherever the image is now. */
function toCustom() {
  const g = placement();
  if (!g || (P.settings.fit === "custom" && P.settings.imgWidthMm > 0)) return;
  Object.assign(P.settings, { fit: "custom", imgX: g.draw.x, imgY: g.draw.y, imgWidthMm: g.draw.w });
  $$<HTMLButtonElement>("[data-fit]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.fit === "custom")));
}

function positionPlacer() {
  const placer = $(".placer"), artbox = $(".artbox");
  const g = placement();
  const show = !!(g && work && P.step === "image" && view === "original" && !maskTool);
  if (artbox) artbox.style.display = show && P.settings.marginMm > 0 ? "block" : "none";
  if (placer) placer.style.display = show && P.settings.sizeMode === "board" ? "block" : "none";
  if (!show || !g) return;
  const s = currentScale();
  const box = (el: HTMLElement | null, r: { x: number; y: number; w: number; h: number }) => {
    if (el) Object.assign(el.style, { left: `${r.x * s}px`, top: `${r.y * s}px`, width: `${r.w * s}px`, height: `${r.h * s}px` });
  };
  box(artbox, g.art);
  box(placer, g.draw);
  const dim = $(".pl-dim");
  if (dim) dim.textContent = `${fmt(g.draw.w, 0)} × ${fmt(g.draw.h, 0)} mm`;
}

function syncPlacementFields() {
  const g = placement();
  if (!g) return;
  const vals: Record<string, number> = { imgWidthMm: g.draw.w, imgX: g.draw.x, imgY: g.draw.y };
  $$<HTMLInputElement>("[data-place]").forEach((el) => {
    if (document.activeElement !== el) el.value = fmt(vals[el.dataset.place!], 1);
  });
  $$("[data-live=\"imgHOut\"]").forEach((el) => (el.textContent = `Height ${fmt(g.draw.h, 1)} mm (keeps the image's proportions)`));
}

let liveFrame = 0;
/** Re-draw the original view right away; processing follows after a pause. */
function placementChanged() {
  if (!liveFrame) liveFrame = requestAnimationFrame(() => { liveFrame = 0; prepareWork(); renderStage(); syncPlacementFields(); });
  touch(false);
  reprepare();
}

function bindPlacer() {
  const placer = $(".placer");
  if (!placer) return;
  let d: { h: string; x0: number; y0: number; x: number; y: number; w: number; ar: number; id: number } | null = null;
  placer.addEventListener("pointerdown", (e) => {
    if (!bitmap) return;
    e.stopPropagation();
    e.preventDefault();
    toCustom();
    const s = P.settings;
    d = { h: (e.target as HTMLElement).dataset.h ?? "move", x0: e.clientX, y0: e.clientY, x: s.imgX, y: s.imgY, w: s.imgWidthMm, ar: bitmap.height / bitmap.width, id: e.pointerId };
    placer.setPointerCapture(e.pointerId);
  });
  placer.addEventListener("pointermove", (e) => {
    if (!d || e.pointerId !== d.id) return;
    const sc = currentScale(), dx = (e.clientX - d.x0) / sc, dy = (e.clientY - d.y0) / sc;
    const s = P.settings, h0 = d.w * d.ar;
    if (d.h === "move") { s.imgX = d.x + dx; s.imgY = d.y + dy; }
    else {
      const sx = d.h.includes("e") ? 1 : -1, sy = d.h.includes("s") ? 1 : -1;
      const w = Math.max(5, d.w + (sx * dx + (sy * dy) / d.ar) / 2); // proportional
      const h = w * d.ar;
      s.imgWidthMm = w;
      s.imgX = sx > 0 ? d.x : d.x + d.w - w; // the opposite corner stays put
      s.imgY = sy > 0 ? d.y : d.y + h0 - h;
    }
    positionPlacer();
    placementChanged();
  });
  const end = () => { if (d) { d = null; renderPanel(); } };
  placer.addEventListener("pointerup", end);
  placer.addEventListener("pointercancel", end);
}

// ---- Vector preview: only the visible part is drawn, at screen resolution,
// so borders stay sharp at any zoom.

const tileCache = new Map<string, HTMLCanvasElement>();
const TILE_MM_PER_PX = 0.2;
function grainTile(w: Wood): HTMLCanvasElement {
  const key = `${w.color}|${w.figure}|${w.uid}`;
  let c = tileCache.get(key);
  if (!c) {
    c = document.createElement("canvas");
    c.width = c.height = 640; // 128 mm repeat
    paintSeamlessTile(c, w.color, w.figure, seedFor(w.uid), TILE_MM_PER_PX);
    tileCache.set(key, c);
  }
  return c;
}

let vecFrame = 0;
function requestVector() {
  if (!vecFrame) vecFrame = requestAnimationFrame(() => { vecFrame = 0; drawVector(); });
}

function drawVector() {
  const scroll = $(".stage-scroll"), vb = $(".viewbox"), vec = $<HTMLCanvasElement>("canvas.vec");
  if (!scroll || !vb || !vec || !work) return;
  if (!result || view === "original") { vec.style.display = "none"; return; }
  const sr = scroll.getBoundingClientRect(), br = vb.getBoundingClientRect();
  const x0 = Math.max(sr.left, br.left), y0 = Math.max(sr.top, br.top);
  const x1 = Math.min(sr.right, br.right), y1 = Math.min(sr.bottom, br.bottom);
  if (x1 <= x0 || y1 <= y0) { vec.style.display = "none"; return; }
  const dpr = window.devicePixelRatio || 1, s = currentScale();
  const cw = x1 - x0, ch = y1 - y0;
  Object.assign(vec.style, { display: "block", left: `${x0 - br.left}px`, top: `${y0 - br.top}px`, width: `${cw}px`, height: `${ch}px` });
  vec.width = Math.round(cw * dpr); vec.height = Math.round(ch * dpr);
  const ctx = vec.getContext("2d")!;
  ctx.setTransform(dpr * s, 0, 0, dpr * s, -(x0 - br.left) * dpr, -(y0 - br.top) * dpr); // mm -> device px
  const woods = allWoods();
  const textured = view === "inlay";
  const fill = (i: number) => {
    if (!textured) return woods[i].color;
    const pat = ctx.createPattern(grainTile(woods[i]), "repeat")!;
    pat.setTransform(new DOMMatrix().scale(TILE_MM_PER_PX));
    return pat;
  };
  ctx.fillStyle = fill(0);
  ctx.fillRect(0, 0, work.wMm, work.hMm);
  const px = 1 / s; // one screen pixel, in mm
  result.outlines.forEach((o, n) => {
    const path = result!.paths[n], f = fill(o.wood);
    // A thin stroke in the wood's own color closes anti-aliasing seams between neighbours.
    ctx.strokeStyle = f; ctx.lineWidth = 0.8 * px; ctx.stroke(path);
    ctx.fillStyle = f; ctx.fill(path, "evenodd");
  });
  if (textured) {
    ctx.strokeStyle = "rgba(30, 20, 12, 0.55)";
    ctx.lineWidth = Math.max(0.9 * px, 0.08); // glue line
    for (const p of result.paths) ctx.stroke(p);
  }
}

function exportSvg() {
  if (!result || !work) return;
  const woods = allWoods();
  const W = fmt(work.wMm, 3), H = fmt(work.hMm, 3);
  const groups = result.outlines.map((o) => {
    const d = o.loops.map((l) => loopToSvg(l)).join("");
    return `  <path id="wood-${o.wood}" fill="${woods[o.wood].color}" fill-rule="evenodd" d="${d}"><title>${esc(woods[o.wood].name)}</title></path>`;
  }).join("\n");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Kundekar: ${esc(P.name)}. Units are millimetres. Base wood: ${esc(woods[0].name)}. -->
<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">
  <rect id="wood-0" width="${W}" height="${H}" fill="${woods[0].color}"><title>${esc(woods[0].name)} (base)</title></rect>
${groups}
</svg>
`;
  download(new Blob([svg], { type: "image/svg+xml" }), fileName(P).replace(".kundekar.json", "-woods.svg"));
}

function fitScale(): number {
  const scroll = $(".stage-scroll");
  if (!scroll || !work) return 1;
  return Math.max(0.05, Math.min((scroll.clientWidth - 24 - 40) / work.wMm, (scroll.clientHeight - 24 - 40) / work.hMm));
}

/** Largest zoom: ~4 screen px per image pixel, and rulers within canvas size limits. */
function maxScale(): number {
  if (!work) return 10;
  const dpr = window.devicePixelRatio || 1;
  return Math.min(work.ppm * 4, 30000 / dpr / Math.max(work.wMm, work.hMm));
}

function currentScale(): number {
  if (zoom === "real") return cssPxPerMm;
  if (zoom === "custom") return customScale;
  return fitScale();
}

function setZoom(z: Zoom, scale?: number) {
  zoom = z;
  if (scale !== undefined) customScale = scale;
  $$<HTMLButtonElement>("[data-zoom]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.zoom === zoom)));
  layoutStage();
  updateStatus();
}

/** Zoom by `factor`, keeping the image point under (clientX, clientY) in place. */
function zoomAt(factor: number, clientX: number, clientY: number) {
  const scroll = $(".stage-scroll"), cv = $<HTMLCanvasElement>("canvas.view");
  if (!scroll || !cv || !work) return;
  const s0 = currentScale();
  const s1 = clamp(s0 * factor, Math.min(fitScale(), cssPxPerMm) * 0.5, maxScale());
  if (Math.abs(s1 - s0) < 1e-6) return;
  const r0 = cv.getBoundingClientRect();
  const mx = (clientX - r0.left) / s0, my = (clientY - r0.top) / s0; // mm under the cursor
  setZoom("custom", s1);
  const r1 = cv.getBoundingClientRect();
  scroll.scrollLeft += r1.left + mx * s1 - clientX;
  scroll.scrollTop += r1.top + my * s1 - clientY;
}

function bindStageScroll() {
  const scroll = $(".stage-scroll");
  if (!scroll) return;
  scroll.addEventListener("wheel", (e) => {
    if (!work) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // lines -> px
    zoomAt(Math.exp(-dy * 0.0015), e.clientX, e.clientY);
  }, { passive: false });
  // Drag to pan.
  let drag: { x: number; y: number; sl: number; st: number; id: number } | null = null;
  scroll.addEventListener("pointerdown", (e) => {
    if (!work || (e.button !== 0 && e.button !== 1)) return;
    if (!(e.target as Element).closest(".stage-grid")) return; // leave the scrollbars alone
    if (toolActive() && e.button === 0 && !spaceHeld) return; // the drawing tools own the left button
    drag = { x: e.clientX, y: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop, id: e.pointerId };
    scroll.setPointerCapture(e.pointerId);
    scroll.classList.add("panning");
  });
  scroll.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    scroll.scrollLeft = drag.sl - (e.clientX - drag.x);
    scroll.scrollTop = drag.st - (e.clientY - drag.y);
  });
  const end = () => { drag = null; scroll.classList.remove("panning"); };
  scroll.addEventListener("pointerup", end);
  scroll.addEventListener("pointercancel", end);
  scroll.addEventListener("dblclick", () => work && setZoom("fit"));
  scroll.addEventListener("scroll", requestVector, { passive: true });
  bindTools(scroll);
}

// ---- Refine tools on the stage

function clearInk() {
  $(".ink .stroke")?.setAttribute("d", "");
}

function updateToolCursor() {
  const scroll = $(".stage-scroll");
  scroll?.classList.toggle("toolmode", toolActive() && !spaceHeld);
  scroll?.classList.toggle("spacepan", toolActive() && spaceHeld);
  if (P.step !== "refine" || tool !== "brush") $(".ink .cursor")?.setAttribute("r", "0");
}

function bindTools(scroll: HTMLElement) {
  const toMm = (e: PointerEvent) => {
    const r = $(".viewbox")!.getBoundingClientRect(), s = currentScale();
    return [(e.clientX - r.left) / s, (e.clientY - r.top) / s];
  };
  const toUv = (x: number, y: number) => {
    const g = placement()!;
    return [(x - g.draw.x) / g.draw.w, (y - g.draw.y) / g.draw.h];
  };
  let stroke: { pts: number[]; id: number } | null = null; // mm
  const woodColor = () => allWoods().find((w) => w.uid === activeWood)?.color ?? "#000";
  const drawStroke = () => {
    const path = $(".ink .stroke");
    if (!path || !stroke) return;
    const p = stroke.pts;
    let d = `M${p[0]} ${p[1]}`;
    for (let i = 2; i < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
    if (P.step === "image") {
      d += "Z";
      const keep = maskTool === "keep";
      Object.assign(path.style, { stroke: keep ? "#1c6b66" : "#a8402a", strokeWidth: "", fill: keep ? "#8fd0c6" : "#f1d9cf", strokeDasharray: "4 3", opacity: "0.55" });
    } else if (tool === "brush") {
      if (p.length === 2) d += `L${p[0] + 0.01} ${p[1]}`;
      Object.assign(path.style, { stroke: woodColor(), strokeWidth: `${brushMm * 2}`, fill: "none", strokeDasharray: "", opacity: "0.85" });
    } else {
      d += "Z";
      Object.assign(path.style, { stroke: "#1c6b66", strokeWidth: "", fill: woodColor(), strokeDasharray: "4 3", opacity: "0.6" });
    }
    path.setAttribute("d", d);
  };
  scroll.addEventListener("pointerdown", (e) => {
    if (!toolActive() || e.button !== 0 || spaceHeld || !work || !bitmap) return;
    if (P.step === "refine" && !result) return;
    if (!(e.target as Element).closest(".viewbox")) return;
    e.preventDefault();
    const [x, y] = toMm(e);
    const [u, v] = toUv(x, y);
    if (P.step === "image") { stroke = { pts: [x, y], id: e.pointerId }; scroll.setPointerCapture(e.pointerId); drawStroke(); return; }
    if (tool === "fill") { pushEdit({ t: "fill", u, v, wood: activeWood }); return; }
    if (tool === "merge") { pushEdit({ t: "merge", u, v }); return; }
    stroke = { pts: [x, y], id: e.pointerId };
    scroll.setPointerCapture(e.pointerId);
    drawStroke();
  });
  scroll.addEventListener("pointermove", (e) => {
    if (!toolActive() || !work) return;
    const [x, y] = toMm(e);
    const cur = $(".ink .cursor");
    if (cur && P.step === "refine" && tool === "brush" && !spaceHeld) {
      cur.setAttribute("cx", String(x)); cur.setAttribute("cy", String(y)); cur.setAttribute("r", String(brushMm));
    }
    if (!stroke || e.pointerId !== stroke.id) return;
    const p = stroke.pts, lx = p[p.length - 2], ly = p[p.length - 1];
    if (Math.hypot(x - lx, y - ly) < 0.25) return;
    p.push(x, y);
    drawStroke();
  });
  const end = (e: PointerEvent) => {
    if (!stroke || e.pointerId !== stroke.id) return;
    const uv: number[] = [];
    for (let i = 0; i < stroke.pts.length; i += 2) uv.push(...toUv(stroke.pts[i], stroke.pts[i + 1]));
    const g = placement()!;
    stroke = null;
    if (P.step === "image") {
      if (uv.length >= 6 && maskTool) { P.maskFixes.push({ mode: maskTool, pts: uv }); sizeChanged(true); } else clearInk();
      return;
    }
    if (tool === "brush") pushEdit({ t: "brush", pts: uv, r: brushMm / g.draw.w, wood: activeWood });
    else if (uv.length >= 6) pushEdit({ t: "lasso", pts: uv, wood: activeWood });
    else clearInk();
    stroke = null;
  };
  scroll.addEventListener("pointerup", end);
  scroll.addEventListener("pointercancel", end);
  scroll.addEventListener("pointerleave", () => $(".ink .cursor")?.setAttribute("r", "0"));
}

function drawRuler(c: HTMLCanvasElement, len: number, thick: number, scale: number, horiz: boolean) {
  const dpr = window.devicePixelRatio || 1;
  const cw = horiz ? len : thick, ch = horiz ? thick : len;
  c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
  c.style.width = cw + "px"; c.style.height = ch + "px";
  const ctx = c.getContext("2d")!;
  ctx.scale(dpr, dpr);
  const minor = [1, 2, 5, 10, 20, 50, 100].find((s) => s * scale >= 5) ?? 100;
  const major = [10, 50, 100, 200, 500, 1000].find((s) => s * scale >= 55 && s % minor === 0) ?? 1000;
  const mm = len / scale;
  ctx.strokeStyle = "#8d7d66"; ctx.fillStyle = "#b5a68e"; ctx.lineWidth = 1;
  ctx.font = "9px 'IBM Plex Mono', monospace";
  ctx.beginPath();
  for (let v = 0; v <= mm + 1e-6; v += minor) {
    const p = Math.round(v * scale) + 0.5;
    const isMajor = Math.abs(v % major) < 1e-6;
    const isMid = !isMajor && Math.abs(v % (major / 2)) < 1e-6;
    const t = isMajor ? thick * 0.7 : isMid ? thick * 0.45 : thick * 0.25;
    if (horiz) { ctx.moveTo(p, thick); ctx.lineTo(p, thick - t); } else { ctx.moveTo(thick, p); ctx.lineTo(thick - t, p); }
    if (isMajor && v > 0) {
      if (horiz) ctx.fillText(String(Math.round(v)), p + 2, 9);
      else { ctx.save(); ctx.translate(9, p - 2); ctx.rotate(-Math.PI / 2); ctx.fillText(String(Math.round(v)), 0, 0); ctx.restore(); }
    }
  }
  ctx.stroke();
}

function updateStatus() {
  const f = $(".stage-foot");
  if (!f) return;
  if (!work) { f.innerHTML = `<span>No image</span>`; return; }
  f.innerHTML = `<span>${fmt(work.wMm, 0)} × ${fmt(work.hMm, 0)} mm</span>
    <span>${work.w} × ${work.h} px · ${fmt(work.ppm, 2)} px/mm</span>
    <span>${zoom === "real" ? `1:1 real size` : zoom === "fit" ? "fit to window" : `${Math.round((100 * customScale) / cssPxPerMm)}% of real size`} · wheel to zoom, drag to pan, double-click to fit</span>
    ${busy ? `<span class="busy">processing</span>` : result ? `<span>processed in ${fmt(result.ms / 1000, 1)} s</span>` : ""}`;
}

// ---------------------------------------------------------------- dialogs

async function openProjects() {
  const list = await store.list();
  const dlg = document.createElement("dialog");
  const rows = list.map((p) => `<li class="${p.id === P.id ? "current" : ""}">
      <span class="pn">${esc(p.name)}</span>
      <span class="pa">${p.id === P.id ? `<span class="muted mono" style="font-size:11px;align-self:center">open</span>` : `<button class="btn small" data-open="${p.id}">Open</button>`}
        <button class="btn small ghost danger" data-del="${p.id}" aria-label="Delete ${esc(p.name)}">Delete</button></span>
      <span class="pm">Step: ${esc(STEPS.find((s) => s.id === p.step)?.title ?? p.step)} · ${p.tones.length + 1} woods · edited ${new Date(p.updated).toLocaleString()}</span>
    </li>`).join("");
  dlg.innerHTML = `<div class="dlg-head"><h2>Projects</h2><button class="btn ghost small" data-close>Close</button></div>
    <div class="dlg-body"><p class="muted" style="margin-top:0">Projects are saved in this browser automatically. Use <b>Export</b> for a backup file or to move a project to another computer.</p>
      <ul class="plist">${rows}</ul></div>
    <div class="dlg-foot"><button class="btn primary" data-new>New project</button></div>`;
  document.body.append(dlg);
  dlg.showModal();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t === dlg || t.closest("[data-close]")) dlg.close();
    const open = t.closest<HTMLElement>("[data-open]")?.dataset.open;
    if (open) { const p = await store.get(open); if (p) { await save(); dlg.close(); await loadProject(p); } }
    const del = t.closest<HTMLElement>("[data-del]")?.dataset.del;
    if (del) {
      const btn = t.closest<HTMLButtonElement>("[data-del]")!;
      if (!btn.dataset.armed) {
        // Two-step delete: first click arms the button.
        btn.dataset.armed = "1";
        btn.textContent = "Click again to delete";
        btn.classList.remove("ghost");
        setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = "Delete"; btn.classList.add("ghost"); } }, 4000);
        return;
      }
      await store.remove(del);
      dlg.close();
      if (del === P.id) {
        const rest = await store.list();
        await loadProject(rest[0] ?? newProject());
        if (!rest.length) await save();
      }
      openProjects();
    }
    if (t.closest("[data-new]")) {
      await save();
      dlg.close();
      await loadProject(newProject());
      await save();
      toast("New project started");
    }
  });
}

function openCalibrate() {
  const dlg = document.createElement("dialog");
  const W = 85.6, H = 53.98;
  dlg.innerHTML = `<div class="dlg-head"><h2>Calibrate 1 : 1</h2><button class="btn ghost small" data-close>Close</button></div>
    <div class="dlg-body"><p style="margin-top:0">Hold a bank card (85.6 × 54 mm) against the screen and drag the slider until the outline matches its edges.
      Then <b>1 : 1 real size</b> shows the inlay at its true size on this screen.</p>
      <div class="card-cal"></div>
      <input type="range" min="2" max="8" step="0.01" value="${cssPxPerMm}" aria-label="Screen pixels per millimetre" />
      <p class="mono muted" data-out></p></div>
    <div class="dlg-foot"><button class="btn ghost" data-reset>Reset</button><button class="btn primary" data-save>Save</button></div>`;
  document.body.append(dlg);
  const card = $(".card-cal", dlg)!, range = $<HTMLInputElement>("input", dlg)!, out = $("[data-out]", dlg)!;
  const apply = (v: number) => {
    card.style.width = W * v + "px"; card.style.height = H * v + "px";
    out.textContent = `${v.toFixed(2)} screen px per mm`;
  };
  apply(cssPxPerMm);
  range.oninput = () => apply(Number(range.value));
  dlg.showModal();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t === dlg || t.closest("[data-close]")) dlg.close();
    if (t.closest("[data-reset]")) { range.value = String(96 / 25.4); apply(96 / 25.4); }
    if (t.closest("[data-save]")) {
      cssPxPerMm = Number(range.value);
      localStorage.setItem(CAL_KEY, String(cssPxPerMm));
      dlg.close();
      layoutStage(); updateStatus();
      toast("Screen calibrated");
    }
  });
}

// ---------------------------------------------------------------- events

function bindShell() {
  $<HTMLInputElement>("#pname")!.addEventListener("input", (e) => {
    P.name = (e.target as HTMLInputElement).value.trim() || "Untitled inlay";
    touch(false);
  });
  $(".mast-actions")!.addEventListener("click", async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "projects") openProjects();
    if (act === "export") { download(await exportProject(P), fileName(P)); toast("Project exported"); }
    if (act === "import") $<HTMLInputElement>("#importFile")!.click();
  });
  $<HTMLInputElement>("#importFile")!.addEventListener("change", async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const p = await importProject(f);
      await save();
      await loadProject(p);
      await save();
      toast(`Imported "${p.name}"`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not import that file.");
    }
  });
  $(".rail")!.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-goto]")?.dataset.goto;
    if (id) goTo(id);
  });
  $(".foot")!.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "back") goTo(STEPS[Math.max(0, stepIndex() - 1)].id);
    if (act === "next") next();
  });
  $(".stage")!.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const v = t.closest<HTMLElement>("[data-view]")?.dataset.view as View | undefined;
    if (v) { view = v; renderStage(); }
    const z = t.closest<HTMLElement>("[data-zoom]")?.dataset.zoom as Zoom | undefined;
    if (z) setZoom(z);
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "calibrate") openCalibrate();
    if (act === "svg") exportSvg();
    if (act === "png") {
      $<HTMLCanvasElement>("canvas.view")?.toBlob((b) => b && download(b, fileName(P).replace(".kundekar.json", `-${view}.png`)));
    }
  });
}

function refreshAfterWoodChange(rerender: boolean) {
  // A result computed for a different number of woods can't be drawn any more.
  if (result && result.res.stats.length !== allWoods().length) { result = null; renderStage(); }
  touch(true);
  if (rerender) renderPanel(); else refreshLive();
}

function bindPanel() {
  const panel = $(".panel")!;
  $$<HTMLCanvasElement>("canvas[data-swatch]", panel).forEach((c) => {
    const w = allWoods().find((x) => x.uid === c.dataset.swatch);
    if (w) paintSwatch(c, w.color, w.figure, seedFor(w.uid), 0.5);
  });

  panel.onclick = (e) => {
    const t = e.target as HTMLElement;
    const mt = t.closest<HTMLElement>("[data-masktool]")?.dataset.masktool as "keep" | "cut" | undefined;
    if (mt) { maskTool = maskTool === mt ? null : mt; view = "original"; renderPanel(); renderStage(); return; }
    const tl = t.closest<HTMLElement>("[data-tool]")?.dataset.tool as Tool | undefined;
    if (tl) { tool = tl; renderPanel(); updateToolCursor(); return; }
    const pick = t.closest<HTMLElement>("[data-pick-wood]")?.dataset.pickWood;
    if (pick) { activeWood = pick; renderPanel(); return; }
    const kit = t.closest<HTMLElement>("[data-kit]")?.dataset.kit;
    if (kit) {
      const k = WOOD_KITS.find((x) => x.id === kit)!;
      const before = { base: P.base, tones: P.tones };
      const { base, tones } = woodsFromKit(k);
      P.base = base; P.tones = tones;
      P.log.push({ t: Date.now(), text: `Kit: ${k.name}` });
      refreshAfterWoodChange(true);
      toast(`"${k.name}" applied`, {
        label: "Undo",
        run: () => { P.base = before.base; P.tones = before.tones; refreshAfterWoodChange(true); },
      });
      return;
    }
    const preset = t.closest<HTMLElement>("[data-preset]")?.dataset.preset;
    if (preset) {
      const p = SIZE_PRESETS[Number(preset)];
      P.settings.widthMm = p.widthMm;
      if (P.settings.sizeMode === "board") P.settings.heightMm = p.heightMm;
      sizeChanged(true);
      return;
    }
    const mode = t.closest<HTMLElement>("[data-sizemode]")?.dataset.sizemode as SizeMode | undefined;
    if (mode) { P.settings.sizeMode = mode; sizeChanged(true); return; }
    const fit = t.closest<HTMLElement>("[data-fit]")?.dataset.fit as FitMode | undefined;
    if (fit) {
      if (fit === "custom") toCustom(); else P.settings.fit = fit;
      sizeChanged(true);
      return;
    }
    const angle = t.closest<HTMLElement>("[data-angle]")?.dataset.angle;
    if (angle) { setSetting("vAngle", Number(angle)); renderPanel(); return; }

    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "pick") { $<HTMLInputElement>("#imageFile")?.click(); return; }
    if (act === "undo") { undoEdit(); return; }
    if (act === "undoMaskFix") { undoMaskFix(); return; }
    if (act === "redo") { redoEdit(); return; }
    if (act === "clearEdits") {
      const btn = t.closest<HTMLButtonElement>("[data-act]")!;
      if (!btn.dataset.armed) {
        btn.dataset.armed = "1"; btn.textContent = "Click again to clear all";
        setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = "Clear all edits"; } }, 4000);
        return;
      }
      redo = [...P.edits].reverse();
      P.edits = [];
      touch(false); scheduleProcess(0); renderPanel();
      toast("All edits cleared", { label: "Undo", run: () => { P.edits = [...redo].reverse(); redo = []; touch(false); scheduleProcess(0); renderPanel(); } });
      return;
    }
    if (act === "removeBg") { runRemoveBackground(); return; }
    if (act === "dropMask") {
      P.mask = null; P.maskOn = false;
      prepareImage().then(() => sizeChanged(true));
      return;
    }
    if (act === "centerImg") {
      toCustom();
      const g = placement();
      if (g) { P.settings.imgX = (g.wMm - g.draw.w) / 2; P.settings.imgY = (g.hMm - g.draw.h) / 2; }
      placementChanged();
      renderPanel();
      return;
    }
    if (act === "swapWH") {
      [P.settings.widthMm, P.settings.heightMm] = [P.settings.heightMm, P.settings.widthMm];
      sizeChanged(true);
      return;
    }
    if (act === "clearImage") {
      P.image = null; P.imageName = null; result = null;
      forgetImageWork();
      prepareImage().then(() => { touch(true); renderAll(); });
      return;
    }
    if (act === "addTone") {
      const used = new Set(allWoods().map((w) => w.presetId));
      const pick = WOOD_PRESETS.find((p) => !used.has(p.id)) ?? WOOD_PRESETS[0];
      P.tones.push(woodFromPreset(pick.id, TONE_THICKNESS));
      refreshAfterWoodChange(true);
      return;
    }
    const uid = t.closest<HTMLElement>("[data-uid]")?.dataset.uid;
    const i = P.tones.findIndex((w) => w.uid === uid);
    if (act === "remove" && i >= 0) {
      if (P.tones.length <= 1) { toast("Keep at least one tone wood."); return; }
      P.tones.splice(i, 1);
      refreshAfterWoodChange(true);
    }
    if (act === "mkbase" && i >= 0) {
      const old = P.base;
      P.base = { ...P.tones[i], thickness: old.thickness };
      P.tones[i] = { ...old, thickness: P.tones[i].thickness };
      refreshAfterWoodChange(true);
    }
  };

  panel.onchange = (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.act === "maskOn") {
      P.maskOn = t.checked;
      sizeChanged(false);
      return;
    }
    if (t.id === "imageFile") {
      const f = t.files?.[0];
      if (f) setImage(f, f.name);
      return;
    }
    const wood = woodFor(t);
    if (!wood) return;
    if (t.dataset.act === "preset") {
      const p = presetById(t.value);
      if (p) Object.assign(wood, { presetId: p.id, name: p.name, color: p.color, figure: p.figure });
      else Object.assign(wood, { presetId: null, name: wood.name.startsWith("Custom") ? wood.name : `Custom (${wood.name})` });
      refreshAfterWoodChange(true);
    }
    if (t.dataset.act === "color") refreshAfterWoodChange(true);
  };

  panel.oninput = (e) => {
    const t = e.target as HTMLInputElement;
    if (t.hasAttribute("data-brush")) {
      brushMm = Number(t.value);
      const o = t.closest(".field")?.querySelector("output");
      if (o) o.textContent = `${fmt(brushMm * 2, 1)} mm`;
      return;
    }
    const place = t.dataset.place as "imgWidthMm" | "imgX" | "imgY" | undefined;
    if (place) {
      const v = Number(t.value);
      if (t.value === "" || !Number.isFinite(v)) return;
      toCustom();
      const s = P.settings;
      if (place === "imgWidthMm") {
        const g = placement()!;
        const cx = g.draw.x + g.draw.w / 2, cy = g.draw.y + g.draw.h / 2, ar = g.draw.h / g.draw.w;
        s.imgWidthMm = clamp(v, 5, 5000);
        s.imgX = cx - s.imgWidthMm / 2; s.imgY = cy - (s.imgWidthMm * ar) / 2; // resize around the centre
      } else s[place] = clamp(v, -5000, 5000);
      placementChanged();
      return;
    }
    const key = t.dataset.set as NumericSetting | undefined;
    if (key) {
      const v = Number(t.value);
      if (t.value === "" || !Number.isFinite(v)) return;
      setSetting(key, v);
      if (key === "vAngle") $$<HTMLButtonElement>("[data-angle]", panel).forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.angle) === v)));
      return;
    }
    const wood = woodFor(t);
    if (!wood) return;
    if (t.dataset.act === "thick") {
      const v = Number(t.value);
      if (!Number.isFinite(v) || v <= 0) return;
      wood.thickness = clamp(v, 0.5, 60);
      const bar = t.closest(".row")?.querySelector<HTMLElement>(".profile i");
      if (bar) bar.style.height = clamp(wood.thickness * 1.6, 2, 22) + "px";
      touch(false);
      refreshLive();
    }
    if (t.dataset.act === "name") { wood.name = t.value.trim() || "Custom wood"; touch(false); }
    if (t.dataset.act === "color") {
      wood.color = t.value;
      if (wood.presetId) { wood.name = `Custom (${wood.name})`; wood.presetId = null; }
      const c = $<HTMLCanvasElement>(`canvas[data-swatch="${wood.uid}"]`, panel);
      if (c) paintSwatch(c, wood.color, wood.figure, seedFor(wood.uid), 0.5);
      touch(true);
    }
  };
}

function woodFor(el: HTMLElement): Wood | undefined {
  const uid = el.closest<HTMLElement>("[data-uid]")?.dataset.uid;
  return uid ? allWoods().find((w) => w.uid === uid) : undefined;
}

const reprepare = debounce(() => {
  jobId++; // a job still running was for the old size: ignore its result
  prepareWork();
  result = null;
  renderStage();
  clearInk();
  refreshLive();
  scheduleProcess(0);
}, 250);

async function runRemoveBackground() {
  if (!P.image || aiStatus) return;
  const status = (text: string) => { aiStatus = text; $$('[data-live="aiStatus"]').forEach((el) => (el.textContent = text)); };
  status("Starting…");
  if (P.step === "image") renderPanel();
  try {
    P.mask = await removeBackground(P.image, status);
    P.maskOn = true;
    P.log.push({ t: Date.now(), text: "Background removed (AI)" });
    aiStatus = "";
    await prepareImage();
    sizeChanged(P.step === "image");
    toast("Background removed. Untick the box to bring it back.");
  } catch (err) {
    aiStatus = "";
    if (P.step === "image") renderPanel();
    toast("Background removal failed: " + (err instanceof Error ? err.message : String(err)));
  }
}

function sizeChanged(rerender: boolean) {
  touch(false);
  if (rerender) renderPanel();
  reprepare();
}

function setSetting(key: NumericSetting, v: number) {
  const limits: Record<NumericSetting, [number, number]> = {
    widthMm: [20, 2000], heightMm: [20, 2000], marginMm: [0, 200], imgX: [-5000, 5000], imgY: [-5000, 5000], imgWidthMm: [5, 5000], vAngle: [10, 150], pocketDepth: [0.2, 10], glueGap: [0, 3],
    surfacePerRound: [0, 2], minRetained: [0.05, 5], minLineMm: [0, 10], minAreaMm2: [0, 100], colorWeight: [0, 1.5], smoothing: [0, 1],
  };
  const [lo, hi] = limits[key];
  P.settings[key] = clamp(v, lo, hi);
  if (key === "widthMm" || key === "heightMm" || key === "marginMm") { sizeChanged(false); return; }
  else touch(true);
  refreshLive();
}

// Image anywhere: drop or paste.
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); $(".drop")?.classList.add("over"); }
});
window.addEventListener("dragleave", () => $(".drop")?.classList.remove("over"));
window.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  e.preventDefault();
  if (f.name.endsWith(".json")) { importFromDrop(f); return; }
  setImage(f, f.name);
});
window.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
  const f = item?.getAsFile();
  if (f) setImage(f, f.name || "Pasted image");
});
window.addEventListener("resize", debounce(layoutStage, 100));
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
window.addEventListener("keydown", (e) => {
  if (typing(e.target)) return;
  if (e.code === "Space" && P && toolActive() && !spaceHeld) { spaceHeld = true; updateToolCursor(); e.preventDefault(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undoEdit(); }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redoEdit(); }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && spaceHeld) { spaceHeld = false; updateToolCursor(); }
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.target as HTMLElement).closest?.(".drop")) $<HTMLInputElement>("#imageFile")?.click();
});

async function importFromDrop(f: File) {
  try {
    const p = await importProject(f);
    await save();
    await loadProject(p);
    await save();
    toast(`Imported "${p.name}"`);
  } catch (err) {
    toast(err instanceof Error ? err.message : "Could not import that file.");
  }
}

// ---------------------------------------------------------------- boot

const app = document.getElementById("app")!;

(async () => {
  let p: Project | undefined;
  try {
    const last = lastProjectId.get();
    p = (last && (await store.get(last))) || (await store.list())[0];
  } catch {
    toast("Browser storage is unavailable; this project will not be saved.");
  }
  await loadProject(p ?? newProject());
  if (!p) await save().catch(() => {});
})();
