// AI background removal, entirely in the browser.
//
// Model: onnx-community/ormbg-ONNX (ORMBG, Apache-2.0), 8-bit quantized (~44 MB),
// run with transformers.js. MODNet was tried first but left holes in faces on
// old black-and-white portraits. The library and the model are downloaded on
// first use and cached by the browser; the user's image never leaves the computer.

type Segmenter = (input: string) => Promise<{ data: Uint8ClampedArray; width: number; height: number; channels: number }>;

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";

let segmenter: Promise<Segmenter> | null = null;

export async function removeBackground(image: Blob, onStatus: (text: string) => void): Promise<Blob> {
  if (!segmenter) {
    onStatus("Loading the AI library…");
    segmenter = (async () => {
      // Loaded from the CDN rather than bundled: keeps the site small, and GitHub's
      // secret scanning flags a false positive inside the minified library.
      const { pipeline } = await import(/* @vite-ignore */ TRANSFORMERS_URL);
      const files: Record<string, { loaded: number; total: number }> = {};
      const pipe = await pipeline("background-removal", "onnx-community/ormbg-ONNX", {
        dtype: "q8",
        progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
          if (p.status === "progress" && p.file) {
            files[p.file] = { loaded: p.loaded ?? 0, total: p.total ?? 0 };
            const loaded = Object.values(files).reduce((a, f) => a + f.loaded, 0);
            const total = Object.values(files).reduce((a, f) => a + f.total, 0);
            onStatus(`Downloading the model (first time only)… ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`);
          }
        },
      });
      return pipe as unknown as Segmenter;
    })();
    segmenter.catch(() => { segmenter = null; }); // allow a retry after a network error
  }
  const run = await segmenter;
  onStatus("Finding the subject…");
  const url = URL.createObjectURL(image);
  try {
    const out = await run(url);
    // Keep only the alpha channel as a mask image (white, alpha = subject).
    const { width, height, channels, data } = out;
    const mask = new ImageData(width, height);
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      mask.data[o] = mask.data[o + 1] = mask.data[o + 2] = 255;
      mask.data[o + 3] = channels === 4 ? data[i * 4 + 3] : data[i];
    }
    const c = new OffscreenCanvas(width, height);
    c.getContext("2d")!.putImageData(mask, 0, 0);
    return await c.convertToBlob({ type: "image/png" });
  } finally {
    URL.revokeObjectURL(url);
  }
}
