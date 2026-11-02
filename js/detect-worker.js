// Finds people in video frames and describes each one's outfit colors.
// Runs in a worker so the page stays responsive while analyzing.
//
// Messages in:
//   {type:'init', wasmBase, modelUrl}
//   {type:'bg-frame', bitmap}            frames for the empty-room background (small)
//   {type:'bg-done'}                     compute the background
//   {type:'detect', bitmap, id}          returns {dets}
// Each det: {x, y, w, h, s, up:[28], lo:[28]}  (pixels in the analysis frame,
// score, outfit color histograms for the top and bottom half of the body)

// MediaPipe loads its wasm glue with importScripts(), which module workers
// don't allow. Load it with a synchronous request + global eval instead.
self.importScripts = (url) => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', String(url), false);
  xhr.send();
  if (xhr.status !== 200) throw new Error(`Failed to load ${url}`);
  (0, eval)(xhr.responseText);
};

const { FilesetResolver, ObjectDetector } = await import('../vendor/mediapipe/vision_bundle.mjs?v=4');

const BG_SCALE = 4;   // background is kept at 1/4 resolution
const BINS = 28;      // 12 hues x 2 saturations + 4 grays
let fileset = null;
let modelUrl = '';
let detector = null;
let delegate = null;  // 'GPU' or 'CPU', decided on the first frame
let bgFrames = [];
let bg = null;        // {w, h, data: Uint8ClampedArray RGBA}
let canvas = null;
let ctx = null;

async function makeDetector(d) {
  return ObjectDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelUrl, delegate: d },
    runningMode: 'IMAGE',
    scoreThreshold: 0.2,
    maxResults: 30,
    categoryAllowlist: ['person'],
  });
}

function runDetect(det, source) {
  return det.detect(source).detections.map((d) => ({
    x: d.boundingBox.originX,
    y: d.boundingBox.originY,
    w: d.boundingBox.width,
    h: d.boundingBox.height,
    s: d.categories[0]?.score ?? 0,
  }));
}

/**
 * Pick GPU when it works. Some devices' GPU path silently returns nothing,
 * so compare against CPU on the first frame.
 */
async function chooseDetector(source) {
  let cpu = await makeDetector('CPU');
  const cpuDets = runDetect(cpu, source);
  try {
    const gpu = await makeDetector('GPU');
    const gpuDets = runDetect(gpu, source);
    if (gpuDets.length >= Math.max(1, cpuDets.length * 0.7) || (cpuDets.length === 0 && gpuDets.length === 0)) {
      cpu.close();
      cpu = null;
      detector = gpu;
      delegate = 'GPU';
      return gpuDets;
    }
    gpu.close();
  } catch { /* no GPU */ }
  detector = cpu;
  delegate = 'CPU';
  return cpuDets;
}

function computeBackground() {
  if (!bgFrames.length) return;
  const { w, h } = bgFrames[0];
  const n = bgFrames.length;
  const data = new Uint8ClampedArray(w * h * 4);
  const vals = new Uint8Array(n);
  for (let p = 0; p < w * h; p++) {
    for (let c = 0; c < 3; c++) {
      for (let k = 0; k < n; k++) vals[k] = bgFrames[k].data[p * 4 + c];
      vals.sort();
      data[p * 4 + c] = vals[n >> 1];
    }
    data[p * 4 + 3] = 255;
  }
  bg = { w, h, data };
  bgFrames = [];
}

function bitmapPixels(bitmap) {
  if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

function colorBin(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const v = mx / 255;
  const s = mx === 0 ? 0 : (mx - mn) / mx;
  if (s > 0.28 && v > 0.22) {
    let hue;
    if (mx === r) hue = ((g - b) / (mx - mn) + 6) % 6;
    else if (mx === g) hue = (b - r) / (mx - mn) + 2;
    else hue = (r - g) / (mx - mn) + 4;
    return Math.min(11, Math.floor(hue * 2)) * 2 + (s > 0.6 ? 1 : 0);
  }
  return 24 + (v < 0.25 ? 0 : v < 0.5 ? 1 : v < 0.75 ? 2 : 3);
}

/** Outfit color histogram of a body region, using only pixels that differ from the empty room. */
function regionHist(px, W, H, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
  const fg = new Float32Array(BINS);
  const all = new Float32Array(BINS);
  let nfg = 0, nall = 0;
  const stepPx = Math.max(1, Math.floor((x1 - x0) / 40));
  for (let y = y0; y < y1; y += stepPx) {
    for (let x = x0; x < x1; x += stepPx) {
      const i = (y * W + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const bin = colorBin(r, g, b);
      all[bin]++; nall++;
      if (bg) {
        const bx = Math.min(bg.w - 1, (x / BG_SCALE) | 0), by = Math.min(bg.h - 1, (y / BG_SCALE) | 0);
        const j = (by * bg.w + bx) * 4;
        const d = Math.abs(r - bg.data[j]) + Math.abs(g - bg.data[j + 1]) + Math.abs(b - bg.data[j + 2]);
        if (d > 60) { fg[bin]++; nfg++; }
      }
    }
  }
  // Fall back to all pixels if almost nothing differs from the background
  // (camera moved, or the outfit matches the wall).
  const use = nfg > nall * 0.15 ? fg : all;
  const total = nfg > nall * 0.15 ? nfg : nall;
  const out = new Array(BINS);
  for (let k = 0; k < BINS; k++) out[k] = total ? Math.round((use[k] / total) * 1000) / 1000 : 0;
  return out;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      modelUrl = data.modelUrl;
      fileset = await FilesetResolver.forVisionTasks(data.wasmBase);
      bgFrames = []; bg = null; detector?.close?.(); detector = null; delegate = null;
      self.postMessage({ type: 'ok', id: data.id });
    } else if (data.type === 'bg-frame') {
      const px = bitmapPixels(data.bitmap);
      bgFrames.push({ w: data.bitmap.width, h: data.bitmap.height, data: new Uint8ClampedArray(px) });
      data.bitmap.close();
      self.postMessage({ type: 'ok', id: data.id });
    } else if (data.type === 'bg-done') {
      computeBackground();
      self.postMessage({ type: 'ok', id: data.id });
    } else if (data.type === 'detect') {
      const bmp = data.bitmap;
      const W = bmp.width, H = bmp.height;
      const raw = detector ? runDetect(detector, bmp) : await chooseDetector(bmp);
      const px = bitmapPixels(bmp);
      bmp.close();
      const dets = raw
        .filter((d) => d.w > 4 && d.h > 8)
        .map((d) => ({
          x: Math.round(d.x * 10) / 10, y: Math.round(d.y * 10) / 10,
          w: Math.round(d.w * 10) / 10, h: Math.round(d.h * 10) / 10,
          s: Math.round(d.s * 100) / 100,
          up: regionHist(px, W, H, d.x + d.w * 0.25, d.y + d.h * 0.18, d.x + d.w * 0.75, d.y + d.h * 0.5),
          lo: regionHist(px, W, H, d.x + d.w * 0.25, d.y + d.h * 0.52, d.x + d.w * 0.75, d.y + d.h * 0.88),
        }));
      self.postMessage({ type: 'dets', id: data.id, dets, delegate });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, message: String(err?.message || err) });
  }
};

self.postMessage({ type: 'ready' });
