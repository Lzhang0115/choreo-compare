// Follow one member through a video, given the dancers found by dancers.js.
//
// How a member is recognized from frame to frame:
//   - outfit colors (top and bottom separately)
//   - height, corrected for distance from the camera (people further back
//     look smaller)
//   - movement: where they should be given where they were going
//   - formation spot: where the matching member is in the OTHER video,
//     mapped onto this video's formation. Choreography makes people hide
//     behind each other at the same moments in both videos, so this is what
//     finds a member again after they've been covered up.
// When nobody matches well enough, the member is assumed hidden and their
// position is predicted until they reappear.
//
// Pure functions, no DOM: unit-testable in Node.

function iou(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a.w * a.h + b.w * b.h - i || 1);
}

function bc(a, b) {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += Math.sqrt(a[k] * b[k]);
  return s;
}

const median = (arr) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// ---------------------------------------------------------------- prepare

/**
 * Filter + enrich raw analysis data.
 * ignore: [{x0,y0,x1,y1}] in 0..1 video coords; dancers whose feet are inside are dropped (mirrors etc).
 */
export function prepare(data, { ignore = [] } = {}) {
  const { W, H, step } = data;
  const inIgnored = (d) => {
    const fx = (d.x + d.w / 2) / W, fy = (d.y + d.h) / H;
    return ignore.some((r) => fx >= r.x0 && fx <= r.x1 && fy >= r.y0 && fy <= r.y1);
  };
  const frames = data.frames.map((dets) => {
    const kept = dets
      .filter((d) => d.s >= 0.25 && !inIgnored(d))
      .sort((a, b) => b.s - a.s);
    // drop near-duplicate boxes
    const out = [];
    for (const d of kept) if (!out.some((o) => iou(o, d) > 0.7)) out.push(d);
    return out.map((d) => ({ ...d, cx: d.x + d.w / 2, cy: d.y + d.h / 2, fy: d.y + d.h }));
  });

  // Perspective: how tall a person looks depending on where their feet are.
  // Robust straight-line fit of height vs foot position.
  const pts = [];
  for (const f of frames) for (const d of f) if (d.s >= 0.4) pts.push([d.fy, d.h]);
  let a = median(pts.map((p) => p[1])) || H / 3, b = 0;
  for (let iter = 0; iter < 4 && pts.length > 10; iter++) {
    const res = pts.map(([x, y]) => Math.abs(y - (a + b * x)));
    const cut = Math.max(2, median(res) * 2.5);
    const use = pts.filter(([x, y], i) => res[i] <= cut);
    const n = use.length;
    const mx = use.reduce((s, p) => s + p[0], 0) / n, my = use.reduce((s, p) => s + p[1], 0) / n;
    let sxy = 0, sxx = 0;
    for (const [x, y] of use) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
    b = sxx > 0 ? Math.max(0, sxy / sxx) : 0;
    a = my - b * mx;
  }
  const medH = median(pts.map((p) => p[1])) || H / 3;
  const expectedH = (fy) => Math.max(medH * 0.3, a + b * fy);
  for (const f of frames) for (const d of f) d.rh = d.h / expectedH(d.fy);

  return { W, H, step, frames, expectedH, medH, stats: formationStats(frames, step) };
}

// ---------------------------------------------------------------- formation

/** Per-frame formation center / spread / typical dancer height, smoothed over ~1.5 s. */
function formationStats(frames, step) {
  const raw = frames.map((f) => {
    const ds = f.filter((d) => d.s >= 0.35);
    if (!ds.length) return null;
    const mh = median(ds.map((d) => d.h));
    const use = ds.filter((d) => d.h > mh * 0.45);
    const cx = use.reduce((s, d) => s + d.cx, 0) / use.length;
    const cy = use.reduce((s, d) => s + d.cy, 0) / use.length;
    const spread = Math.sqrt(use.reduce((s, d) => s + (d.cx - cx) ** 2 + (d.cy - cy) ** 2, 0) / use.length);
    return { cx, cy, spread, h: mh, n: use.length };
  });
  const half = Math.max(1, Math.round(0.75 / step));
  return raw.map((_, i) => {
    const win = [];
    for (let k = i - half; k <= i + half; k++) if (raw[k]) win.push(raw[k]);
    if (!win.length) return null;
    return {
      cx: median(win.map((s) => s.cx)),
      cy: median(win.map((s) => s.cy)),
      spread: median(win.map((s) => s.spread)),
      h: median(win.map((s) => s.h)),
      n: median(win.map((s) => s.n)),
    };
  });
}

/** Formation stats at time t (seconds), in display coords (mirrored if needed). */
export function formationAt(prep, t, mirror = false) {
  const i = Math.round(t / prep.step);
  const s = prep.stats[Math.max(0, Math.min(prep.stats.length - 1, i))];
  if (!s) return null;
  return { ...s, cx: mirror ? prep.W - s.cx : s.cx };
}

/**
 * Transform from the official video's display coords to the practice video's
 * display coords, lining up formation centers and scaling by formation
 * spread (default) or by dancer height.
 * Returns {s, ox, oy, cO, cP} with practice = cP + s * (official - cO).
 */
export function formationTransform(fP, fO, mode = 'spread') {
  if (!fP || !fO) return null;
  const heightScale = fP.h / fO.h;
  let s = heightScale;
  if (mode === 'spread' && fP.n >= 2 && fO.n >= 2 && fP.spread > fP.h * 0.4 && fO.spread > fO.h * 0.4) {
    s = fP.spread / fO.spread;
    // A missing/merged detection can distort spread: stay within 2x of the height-based scale.
    s = Math.min(heightScale * 2, Math.max(heightScale / 2, s));
  }
  return { s, cO: { x: fO.cx, y: fO.cy }, cP: { x: fP.cx, y: fP.cy } };
}

// ---------------------------------------------------------------- tracking

function scoreDet(m, d, pred, lostSec, prior) {
  // Both the top AND the bottom have to match (geometric mean): a green top
  // with black pants must not pass for an all-black outfit.
  const app = Math.pow(Math.max(1e-6, bc(m.up, d.up)), 0.55) * Math.pow(Math.max(1e-6, bc(m.lo, d.lo)), 0.45);
  const lr = Math.log(d.rh / m.rh);
  const size = Math.exp(-(lr * lr) / (2 * 0.22 * 0.22));
  // A box much wider than this member usually is probably contains two
  // people merged together: trust it less.
  const wr = (d.w / d.h) / m.ar;
  const merged = wr > 1.3;
  const shape = merged ? Math.exp(-(((wr - 1.3) / 0.6) ** 2)) : 1;
  const sig = (0.5 + 0.8 * Math.min(lostSec, 3)) * m.h;
  const dx = d.cx - pred.cx, dy = d.fy - pred.fy;
  const motion = Math.exp(-(dx * dx + dy * dy) / (2 * sig * sig));
  let pr = 1, priorDist = Infinity;
  if (prior) {
    const ex = d.cx - prior.cx, ey = d.fy - prior.fy;
    priorDist = Math.hypot(ex, ey) / m.h;
    pr = 0.15 + 0.85 * Math.exp(-(priorDist * priorDist) / (2 * 0.5 * 0.5));
  }
  return { score: app ** 3 * size * shape * motion * pr, app, size, merged, wr, priorDist };
}

const ACCEPT = 0.01;

/**
 * Follow from one starting point in one direction.
 * Returns Map(frameIndex -> {x,y,w,h,conf,seen}).
 */
function runPass(prep, i0, anchor, dir, iEnd, priorAt) {
  const { frames, step } = prep;
  const out = new Map();
  const m = {
    up: [...anchor.up], lo: [...anchor.lo],
    rh: anchor.h / prep.expectedH(anchor.y + anchor.h),
    ar: anchor.w / anchor.h,
    cx: anchor.x + anchor.w / 2, fy: anchor.y + anchor.h, w: anchor.w, h: anchor.h,
    vx: 0, vy: 0,
    typ: 0.92, // how well this member usually matches themself
  };
  out.set(i0, { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h, conf: 1, seen: true });
  let lost = 0;
  for (let i = i0 + dir; dir > 0 ? i <= iEnd : i >= iEnd; i += dir) {
    const dets = frames[i] || [];
    const pred = { cx: m.cx + m.vx, fy: m.fy + m.vy };
    const prior = priorAt ? priorAt(i) : null;
    let best = null, second = null;
    // Nobody moves further than this between looks; the limit grows while
    // the member is hidden.
    const gate = (0.9 + 1.5 * Math.min(lost, 3)) * m.h;
    for (const d of dets) {
      const near = Math.hypot(d.cx - pred.cx, d.fy - pred.fy) < gate;
      const nearPrior = prior && Math.hypot(d.cx - prior.cx, d.fy - prior.fy) < 0.8 * m.h;
      if (!near && !nearPrior) continue;
      const c = { d, ...scoreDet(m, d, pred, lost, prior) };
      // Clearly worse outfit match than usual: not them (they're probably hidden).
      if (c.app < Math.max(0.55, m.typ - 0.16)) continue;
      if (!best || c.score > best.score) { second = best; best = c; }
      else if (!second || c.score > second.score) second = c;
    }
    let accept = false, conf = 0;
    if (best && best.score > ACCEPT) {
      const ambiguous = second && second.score > best.score * 0.6 && iou(best.d, second.d) < 0.5;
      const nearPred = Math.hypot(best.d.cx - pred.cx, best.d.fy - pred.fy) < 0.35 * m.h;
      // After being hidden for a while, only pick someone up again on a
      // clear outfit match (or if they're right where the formation says).
      const reacquireOk = lost < 0.6 || best.app > 0.72 || best.priorDist < 0.6;
      if ((!ambiguous || nearPred) && reacquireOk) {
        accept = true;
        conf = Math.min(1, best.app * best.size * (ambiguous ? 0.6 : 1) * (best.merged ? 0.6 : 1));
      }
    }
    if (accept) {
      const d = best.d;
      // Learn only from boxes that are clearly just this person.
      const crowded = best.wr > 1.15 || dets.some((o) => o !== d && iou(o, d) > 0.2);
      let ncx = d.cx;
      if (best.merged) {
        // Somewhere inside a merged box: move only part-way from the
        // prediction, and stay inside the box.
        ncx = pred.cx + 0.35 * (d.cx - pred.cx);
        ncx = Math.max(d.x + m.w / 2, Math.min(d.x + d.w - m.w / 2, ncx));
      }
      const k = Math.min(1, lost / step + 1);
      const vGain = crowded ? 0.2 : 0.5;
      m.vx = (1 - vGain) * m.vx + vGain * (ncx - m.cx) / k;
      m.vy = (1 - vGain) * m.vy + vGain * (d.fy - m.fy) / k;
      const vmax = 0.3 * m.h;
      m.vx = Math.max(-vmax, Math.min(vmax, m.vx));
      m.vy = Math.max(-vmax, Math.min(vmax, m.vy));
      m.cx = ncx; m.fy = d.fy;
      if (!best.merged) {
        m.h = 0.7 * m.h + 0.3 * d.h;
        m.w = 0.7 * m.w + 0.3 * d.w;
        m.rh = 0.9 * m.rh + 0.1 * d.rh;
      }
      // Learn appearance only from clean views (not overlapping anyone).
      if (!crowded) m.typ = 0.9 * m.typ + 0.1 * best.app;
      if (!crowded && best.app > 0.55) {
        m.ar = 0.95 * m.ar + 0.05 * (d.w / d.h);
        for (let k2 = 0; k2 < m.up.length; k2++) {
          m.up[k2] = 0.92 * m.up[k2] + 0.08 * d.up[k2];
          m.lo[k2] = 0.92 * m.lo[k2] + 0.08 * d.lo[k2];
        }
      }
      lost = 0;
      const box = best.merged
        ? { x: m.cx - m.w / 2, y: m.fy - m.h, w: m.w, h: m.h }
        : { x: d.x, y: d.y, w: d.w, h: d.h };
      out.set(i, { ...box, conf, seen: true });
    } else {
      // Hidden or not found: predict.
      m.cx += m.vx; m.fy += m.vy;
      m.vx *= 0.6; m.vy *= 0.6;
      lost += step;
      if (prior && lost > 0.3) {
        m.cx += (prior.cx - m.cx) * 0.25;
        m.fy += (prior.fy - m.fy) * 0.25;
      }
      out.set(i, { x: m.cx - m.w / 2, y: m.fy - m.h, w: m.w, h: m.h, conf: Math.max(0.05, 0.6 * Math.exp(-lost)), seen: false });
    }
  }
  return out;
}

/**
 * Anchors: [{t, x, y, w, h, up, lo}] — moments where the user pointed at the
 * member. Returns per-frame [{x,y,w,h,conf,seen}] (raw video coords).
 */
export function trackMember(prep, anchors, priorAt = null) {
  const n = prep.frames.length;
  const track = new Array(n).fill(null);
  if (!anchors.length) return track;
  const idx = anchors
    .map((a) => ({ a, i: Math.max(0, Math.min(n - 1, Math.round(a.t / prep.step))) }))
    .sort((p, q) => p.i - q.i);
  const better = (p, q) => {
    if (!p) return q;
    if (!q) return p;
    if (p.seen !== q.seen) return p.seen ? p : q;
    return p.conf >= q.conf ? p : q;
  };
  const put = (map) => { for (const [i, v] of map) track[i] = better(track[i], v); };
  put(runPass(prep, idx[0].i, idx[0].a, -1, 0, priorAt));
  for (let k = 0; k < idx.length; k++) {
    const end = k + 1 < idx.length ? idx[k + 1].i - 1 : n - 1;
    if (end > idx[k].i) put(runPass(prep, idx[k].i, idx[k].a, +1, end, priorAt));
    if (k + 1 < idx.length && idx[k + 1].i - 1 > idx[k].i) put(runPass(prep, idx[k + 1].i, idx[k + 1].a, -1, idx[k].i + 1, priorAt));
  }
  // Anchors are certain.
  for (const { a, i } of idx) track[i] = { x: a.x, y: a.y, w: a.w, h: a.h, conf: 1, seen: true };
  return track;
}

/**
 * Track a member in both videos, letting each video's formation tell the
 * other where to look when the member is hidden.
 *   offset: official time = practice time + offset
 *   mirror: {practice, reference} display mirroring
 */
export function trackPair(prepP, prepO, anchorsP, anchorsO, { offset = 0, mirror = {}, scaleMode = 'spread' } = {}) {
  const tP0 = trackMember(prepP, anchorsP);
  const tO0 = trackMember(prepO, anchorsO);
  if (!anchorsP.length || !anchorsO.length) return { practice: tP0, official: tO0 };
  const priorFrom = (srcPrep, srcTrack, dstPrep, dt, srcMirror, dstMirror, toPractice) => (i) => {
    const t = i * dstPrep.step;
    const ts = t + dt;
    const j = Math.round(ts / srcPrep.step);
    const b = srcTrack[j];
    if (!b || b.conf < 0.2) return null;
    const fDst = formationAt(dstPrep, t, dstMirror);
    const fSrc = formationAt(srcPrep, ts, srcMirror);
    const T = toPractice ? formationTransform(fDst, fSrc, scaleMode) : formationTransform(fSrc, fDst, scaleMode);
    if (!T) return null;
    // source raw -> source display
    let sx = b.x + b.w / 2;
    if (srcMirror) sx = srcPrep.W - sx;
    const sfy = b.y + b.h;
    let dx, dfy;
    if (toPractice) { // official -> practice
      dx = T.cP.x + T.s * (sx - T.cO.x);
      dfy = T.cP.y + T.s * (sfy - T.cO.y);
    } else {          // practice -> official
      dx = T.cO.x + (sx - T.cP.x) / T.s;
      dfy = T.cO.y + (sfy - T.cP.y) / T.s;
    }
    if (dstMirror) dx = dstPrep.W - dx;
    return { cx: dx, fy: dfy };
  };
  const mP = !!mirror.practice, mO = !!mirror.reference;
  const practice = trackMember(prepP, anchorsP, priorFrom(prepO, tO0, prepP, offset, mO, mP, true));
  const official = trackMember(prepO, anchorsO, priorFrom(prepP, tP0, prepO, -offset, mP, mO, false));
  return { practice, official };
}

// ---------------------------------------------------------------- camera path

/**
 * Turn a track into a smooth camera path for close-ups: gaps filled,
 * position smoothed over ~0.3 s, size over ~1.5 s (so the zoom doesn't pump).
 * Returns {cx, cy, h} Float32Arrays (raw coords) per frame, or null.
 */
export function cameraPath(track, step) {
  const n = track.length;
  const known = [];
  for (let i = 0; i < n; i++) if (track[i]) known.push(i);
  if (!known.length) return null;
  const cx = new Float32Array(n), cy = new Float32Array(n), h = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let b = track[i];
    if (!b) {
      // interpolate between nearest known frames
      let lo = -1, hi = -1;
      for (let k = i - 1; k >= 0; k--) if (track[k]) { lo = k; break; }
      for (let k = i + 1; k < n; k++) if (track[k]) { hi = k; break; }
      const A = track[lo >= 0 ? lo : hi], B = track[hi >= 0 ? hi : lo];
      const f = lo >= 0 && hi >= 0 ? (i - lo) / (hi - lo) : 0;
      b = { x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f, w: A.w + (B.w - A.w) * f, h: A.h + (B.h - A.h) * f };
    }
    cx[i] = b.x + b.w / 2; cy[i] = b.y + b.h / 2; h[i] = b.h;
  }
  const smooth = (arr, sigmaSec) => {
    const sig = sigmaSec / step, R = Math.ceil(sig * 2.5);
    const wts = Array.from({ length: 2 * R + 1 }, (_, k) => Math.exp(-((k - R) ** 2) / (2 * sig * sig)));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, ws = 0;
      for (let k = -R; k <= R; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        s += arr[j] * wts[k + R]; ws += wts[k + R];
      }
      out[i] = s / ws;
    }
    return out;
  };
  // Size: rolling median first (ignores brief merged/partial boxes), then smooth.
  const hm = new Float32Array(n);
  const R = Math.round(1.5 / step);
  for (let i = 0; i < n; i++) hm[i] = median(Array.from(h.subarray(Math.max(0, i - R), Math.min(n, i + R + 1))));
  return { cx: smooth(cx, 0.3), cy: smooth(cy, 0.3), h: smooth(hm, 1.5) };
}
