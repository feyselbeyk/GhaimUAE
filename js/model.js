// On-device sky-type classifier (EfficientNet-B0, ONNX, runs in WebAssembly).
// Preprocessing matches cloudapp/predictor.py: short side resized to the model size,
// up to three square crops along the long side, ImageNet normalisation, mean softmax.
/* global ort */
import { CLASSES } from "./rain.js";

let session = null, meta = null, loading = null;

export function loadModel(onProgress) {
  if (loading) return loading;
  loading = (async () => {
    ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
    ort.env.wasm.numThreads = 1; // static hosting has no cross-origin isolation
    meta = await (await fetch(new URL("../model/labels.json", import.meta.url))).json();
    if (JSON.stringify(meta.classes) !== JSON.stringify(CLASSES)) throw new Error("Model classes do not match the app");
    const bytes = await fetchWithProgress(new URL("../model/skycast_phone.onnx", import.meta.url), onProgress);
    session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    return session;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

async function fetchWithProgress(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not download the model (${r.status})`);
  const total = Number(r.headers.get("content-length")) || 16040737;
  if (!r.body || !onProgress) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// source: HTMLImageElement | ImageBitmap | HTMLVideoElement | HTMLCanvasElement
export async function classify(source, w, h) {
  await loadModel();
  const n = meta.input[3];
  const s = n / Math.min(w, h);
  const W = Math.max(n, Math.round(w * s)), H = Math.max(n, Math.round(h * s));
  const canvas = new OffscreenCanvasOr(W, H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, W, H);

  let boxes;
  if (W === H) boxes = [[0, 0]];
  else if (W > H) boxes = [...new Set([0, Math.floor((W - n) / 2), W - n])].sort((a, b) => a - b).map((x) => [x, 0]);
  else boxes = [...new Set([0, Math.floor((H - n) / 2), H - n])].sort((a, b) => a - b).map((y) => [0, y]);

  const [mr, mg, mb] = meta.mean, [sr, sg, sb] = meta.std;
  const plane = n * n;
  const data = new Float32Array(boxes.length * 3 * plane);
  boxes.forEach(([x, y], bi) => {
    const px = ctx.getImageData(x, y, n, n).data;
    const off = bi * 3 * plane;
    for (let i = 0, j = 0; i < plane; i++, j += 4) {
      data[off + i] = (px[j] / 255 - mr) / sr;
      data[off + plane + i] = (px[j + 1] / 255 - mg) / sg;
      data[off + 2 * plane + i] = (px[j + 2] / 255 - mb) / sb;
    }
  });
  const input = new ort.Tensor("float32", data, [boxes.length, 3, n, n]);
  const out = await session.run({ [session.inputNames[0]]: input });
  const logits = out[session.outputNames[0]].data;
  const k = CLASSES.length;
  const probs = new Array(k).fill(0);
  for (let b = 0; b < boxes.length; b++) {
    const row = logits.slice(b * k, b * k + k);
    const m = Math.max(...row);
    const e = Array.from(row, (v) => Math.exp(v - m));
    const z = e.reduce((a, c) => a + c, 0);
    e.forEach((v, i) => { probs[i] += v / z / boxes.length; });
  }
  return Object.fromEntries(CLASSES.map((c, i) => [c, probs[i]]));
}

function OffscreenCanvasOr(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
