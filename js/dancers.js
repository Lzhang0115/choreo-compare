// Analyze a video once: find every dancer at regular time steps and describe
// their outfit colors. Results are cached on this device (IndexedDB) so each
// video only has to be analyzed once.

const VERSION = 4;
const MODEL_URL = new URL('../models/efficientdet_lite2.tflite', import.meta.url).href;
const WASM_BASE = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
export const STEP = 0.2;            // seconds between analyzed frames
const MAX_WIDTH = 960;              // analysis resolution
const BG_FRAMES = 24;

// ---------------------------------------------------------------- cache

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('choreo-compare', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('dancers');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const r = db.transaction('dancers').objectStore('dancers').get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch { return null; }
}
async function cachePut(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction('dancers', 'readwrite');
      tx.objectStore('dancers').put(value, key);
      tx.oncomplete = tx.onerror = () => resolve();
    });
  } catch { /* storage unavailable: just don't cache */ }
}

export function cacheKey(file) {
  return `v${VERSION}:${file.name}:${file.size}:${file.lastModified}:${STEP}`;
}

export function getCached(file) { return cacheGet(cacheKey(file)); }

// ---------------------------------------------------------------- worker

let worker = null;
let ready = null;
const pending = new Map();
let nextId = 1;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./detect-worker.js?v=4', import.meta.url), { type: 'module' });
    ready = new Promise((resolve, reject) => {
      const onFirst = ({ data }) => {
        if (data.type === 'ready') { worker.removeEventListener('message', onFirst); resolve(); }
      };
      worker.addEventListener('message', onFirst);
      worker.addEventListener('error', (e) => reject(new Error(e.message || 'Dancer finder failed to start')));
    });
    worker.addEventListener('message', ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      data.type === 'error' ? p.reject(new Error(data.message)) : p.resolve(data);
    });
  }
  return ready;
}

function ask(msg, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

// ---------------------------------------------------------------- frames

function once(el, ev) { return new Promise((r) => el.addEventListener(ev, r, { once: true })); }

async function seek(v, t) {
  if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2) return;
  const p = once(v, 'seeked');
  v.currentTime = t;
  await p;
}

function grab(v, canvas, w, h) {
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(v, 0, 0, w, h);
  return createImageBitmap(canvas);
}

/**
 * Analyze one video file. Returns
 * {version, W, H, step, duration, frames: [[det, ...], ...]}
 * where frames[i] holds the dancers found at time i * step.
 */
export async function analyzeVideo(file, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const key = cacheKey(file);
  const cached = await cacheGet(key);
  if (cached) return cached;

  await getWorker();
  await ask({ type: 'init', wasmBase: WASM_BASE, modelUrl: MODEL_URL });

  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.appendChild(v);
  const url = URL.createObjectURL(file);
  v.src = url;
  try {
    await once(v, 'loadeddata');
    const scale = Math.min(1, MAX_WIDTH / v.videoWidth);
    const W = Math.round(v.videoWidth * scale), H = Math.round(v.videoHeight * scale);
    const duration = v.duration;
    const canvas = document.createElement('canvas');

    // 1) Empty-room background: median of frames spread across the video.
    for (let k = 0; k < BG_FRAMES; k++) {
      if (isCancelled()) throw new Error('cancelled');
      await seek(v, ((k + 0.5) / BG_FRAMES) * duration);
      const bmp = await grab(v, canvas, Math.round(W / 4), Math.round(H / 4));
      await ask({ type: 'bg-frame', bitmap: bmp }, [bmp]);
      onProgress((k + 1) / BG_FRAMES * 0.05, 'Learning what the empty room looks like…');
    }
    await ask({ type: 'bg-done' });

    // 2) Find dancers every STEP seconds. The next seek overlaps with the
    //    current frame's detection.
    const n = Math.max(1, Math.floor(duration / STEP) + 1);
    const frames = new Array(n);
    let delegate = null;
    const t0 = performance.now();
    await seek(v, 0);
    let bmp = await grab(v, canvas, W, H);
    for (let i = 0; i < n; i++) {
      if (isCancelled()) throw new Error('cancelled');
      const job = ask({ type: 'detect', bitmap: bmp }, [bmp]);
      let nextBmp = null;
      if (i + 1 < n) {
        await seek(v, Math.min(duration - 0.01, (i + 1) * STEP));
        nextBmp = await grab(v, canvas, W, H);
      }
      const res = await job;
      frames[i] = res.dets;
      delegate = res.delegate;
      bmp = nextBmp;
      const done = (i + 1) / n;
      const elapsed = (performance.now() - t0) / 1000;
      const eta = elapsed / done - elapsed;
      onProgress(0.05 + 0.95 * done, `Finding dancers… ${Math.round(done * 100)}% (about ${eta < 60 ? Math.ceil(eta) + ' s' : Math.ceil(eta / 60) + ' min'} left)`);
    }
    const result = { version: VERSION, W, H, step: STEP, duration, delegate, frames };
    await cachePut(key, result);
    return result;
  } finally {
    v.removeAttribute('src');
    v.load();
    v.remove();
    URL.revokeObjectURL(url);
  }
}
