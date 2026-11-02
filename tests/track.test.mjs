// Member-tracking accuracy on a synthetic 5-dancer practice/official pair
// (mirror reflections, clutter, crossings, an all-black outfit).
// Fixtures: real detector output from the app (js/dancers.js) on videos made
// by tests/dance-gen, plus ground-truth positions.
//
// Run with: node tests/track.test.mjs
import fs from 'fs';
import zlib from 'zlib';
import { prepare, trackPair } from '../js/tracker.js';

const F = new URL('./fixtures/dance/', import.meta.url);
const read = (n) => JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(n, F))));
const truth = read('truth.json.gz');
const data = { practice: read('practice.dets.json.gz'), official: read('official.dets.json.gz') };
const M = truth.mirror, W = truth.W, H = truth.H;
const ignoreP = [{ x0: M[0] / W, y0: M[1] / H, x1: M[2] / W, y1: M[3] / H }]; // "ignore area" over the mirror
const OFFSET = 3.0; // official time = practice time + 3 s

const iouB = (a, b) => {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a[2] * a[3] + b[2] * b[3] - i);
};
const truthAt = (which, t) => truth[which][Math.min(truth[which].length - 1, Math.round(t * truth.fps))].people.filter((p) => typeof p.id === 'number');
function visible(people, p) {
  const foot = p.box[1] + p.box[3];
  for (const q of people) {
    if (q === p || q.box[1] + q.box[3] <= foot) continue;
    const x0 = Math.max(p.box[0], q.box[0]), x1 = Math.min(p.box[0] + p.box[2], q.box[0] + q.box[2]);
    if (x1 > x0 && (x1 - x0) / p.box[2] > 0.5) return false;
  }
  return true;
}
// A simulated tap: the first moment from t0 where the member is clearly visible and boxed on their own.
function tap(prep, which, id, t0) {
  for (let t = t0; t < t0 + 15; t += prep.step) {
    const i = Math.round(t / prep.step), ppl = truthAt(which, i * prep.step), gt = ppl.find((p) => p.id === id);
    if (!gt || !visible(ppl, gt)) continue;
    const d = (prep.frames[i] || []).find((d) => iouB([d.x, d.y, d.w, d.h], gt.box) > 0.6
      && ppl.every((p) => p === gt || iouB([d.x, d.y, d.w, d.h], p.box) < 0.25));
    if (d) return { t: i * prep.step, x: d.x, y: d.y, w: d.w, h: d.h, up: d.up, lo: d.lo };
  }
  return null;
}
function accuracy(prep, which, id, track) {
  let ok = 0, n = 0;
  track.forEach((b, i) => {
    const ppl = truthAt(which, i * prep.step), gt = ppl.find((p) => p.id === id);
    if (!gt || !visible(ppl, gt) || !b) return;
    n++;
    const c = [b.x + b.w / 2, b.y + b.h / 2];
    const inside = c[0] >= gt.box[0] && c[0] <= gt.box[0] + gt.box[2] && c[1] >= gt.box[1] && c[1] <= gt.box[1] + gt.box[3];
    const mine = iouB([b.x, b.y, b.w, b.h], gt.box);
    const other = Math.max(0, ...ppl.filter((p) => p !== gt).map((p) => iouB([b.x, b.y, b.w, b.h], p.box)));
    if (inside && mine >= other) ok++;
  });
  return ok / n;
}

const prepP = prepare(data.practice, { ignore: ignoreP }), prepO = prepare(data.official);
let failures = 0;
const results = [];
for (const t0 of [1, 8, 12, 18, 25, 32]) {
  let sp = 0, so = 0;
  for (let id = 0; id < 5; id++) {
    const aP = tap(prepP, 'practice', id, t0), aO = tap(prepO, 'official', id, t0 + OFFSET);
    const pair = trackPair(prepP, prepO, [aP], [aO], { offset: OFFSET });
    sp += accuracy(prepP, 'practice', id, pair.practice) / 5;
    so += accuracy(prepO, 'official', id, pair.official) / 5;
  }
  results.push([t0, sp, so]);
  console.log(`taps near ${String(t0).padStart(2)} s: practice ${(sp * 100).toFixed(0)}%, official ${(so * 100).toFixed(0)}%`);
}
const avgP = results.reduce((s, r) => s + r[1], 0) / results.length;
const avgO = results.reduce((s, r) => s + r[2], 0) / results.length;
const ok = avgP >= 0.85 && avgO >= 0.85;
if (!ok) failures++;
console.log(`${ok ? 'PASS' : 'FAIL'} average with one tap per video: practice ${(avgP * 100).toFixed(1)}%, official ${(avgO * 100).toFixed(1)}% (need >= 85%)`);
process.exit(failures ? 1 : 0);
