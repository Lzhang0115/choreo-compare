// Audio-based alignment of two recordings of the same song.
//
// Approach: turn each audio track into an "onset strength" envelope (how much
// new sound energy appears at each moment: beats, vocal attacks, hits), then
// cross-correlate the two envelopes to find the time shift where they line up
// best. Onset envelopes are robust to the things that differ between a clean
// official video and a phone recording in a dance studio: volume, EQ, room
// echo, people talking, and background noise.

import { fft, nextPow2 } from './fft.js';

export const SAMPLE_RATE = 8000; // plenty for rhythm; keeps memory low
const FRAME = 512;               // 64 ms analysis window
const HOP = 40;                  // 5 ms between envelope samples
export const ENV_RATE = SAMPLE_RATE / HOP; // 200 envelope samples per second
const PHAT = 0.7;                // whitening strength for candidate search (0 = none, 1 = full PHAT)

/** Decode a media file's audio track to mono Float32Array at SAMPLE_RATE (browser only). */
export async function decodeAudioMono(file) {
  const data = await file.arrayBuffer();
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 1, SAMPLE_RATE);
  const audio = await new Promise((resolve, reject) => {
    // Callback form for older Safari; promise form elsewhere.
    const p = ctx.decodeAudioData(data, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
  const n = audio.length;
  const out = new Float32Array(n);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  if (audio.numberOfChannels > 1) {
    const s = 1 / audio.numberOfChannels;
    for (let i = 0; i < n; i++) out[i] *= s;
  }
  return out;
}

/**
 * Multi-band spectral-flux onset features, sampled at ENV_RATE.
 *
 * Returns one onset envelope per ~1/3-octave frequency band. Matching band by
 * band (instead of one combined envelope) keeps track of *which* sounds start
 * when: a kick, a vocal note, a synth stab. With a single combined envelope,
 * pop songs that repeat the same drum pattern every bar look identical one
 * bar apart, and the sync can snap to the wrong bar.
 */
export function onsetFeatures(samples) {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const bins = FRAME / 2;
  const binHz = SAMPLE_RATE / FRAME;

  // 1/3-octave band edges from 60 Hz up to just below Nyquist.
  const bandOf = new Int16Array(bins).fill(-1);
  let nb = 0;
  for (let lo = 60; lo * Math.pow(2, 1 / 3) < SAMPLE_RATE / 2 * 0.95; lo *= Math.pow(2, 1 / 3)) {
    const hi = lo * Math.pow(2, 1 / 3);
    const k0 = Math.max(1, Math.round(lo / binHz));
    const k1 = Math.max(k0 + 1, Math.round(hi / binHz));
    let any = false;
    for (let k = k0; k < k1 && k < bins; k++) {
      if (bandOf[k] === -1) { bandOf[k] = nb; any = true; }
    }
    if (any) nb++;
  }

  const env = Array.from({ length: nb }, () => new Float32Array(frames));
  const energy = Array.from({ length: nb }, () => new Float32Array(frames));
  const bandBins = new Float32Array(nb);
  for (let k = 0; k < bins; k++) if (bandOf[k] >= 0) bandBins[bandOf[k]]++;
  const win = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < bins; k++) {
      const mag = Math.log1p(100 * Math.hypot(re[k], im[k]));
      cur[k] = mag;
      const b = bandOf[k];
      if (b >= 0) {
        const d = mag - prev[k];
        if (d > 0) env[b][f] += d;
        energy[b][f] += mag / bandBins[b];
      }
    }
    const t = prev; prev = cur; cur = t;
  }

  // The first frame has no predecessor, so it would register as a huge onset
  // in every recording. Drop it.
  for (const e of env) if (frames) e[0] = 0;
  // Onset bands: remove the slowly varying trend (0.5 s moving average) and
  // keep only the peaks above it.
  const onsets = env.map((e) => detrend(e, Math.round(ENV_RATE * 0.25), true));
  // Energy bands: which notes/chords are sounding. Removing a 2 s moving
  // average cancels out EQ and volume differences between the recordings.
  const levels = energy.map((e) => detrend(e, Math.round(ENV_RATE * 1), false));
  const all = onsets.concat(levels);
  for (const e of all) {
    let m = 0;
    for (let i = 0; i < frames; i++) m += e[i];
    m /= frames || 1;
    for (let i = 0; i < frames; i++) e[i] -= m;
  }
  return all;
}

function detrend(e, halfWindow, rectify) {
  const frames = e.length;
  const prefix = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) prefix[i + 1] = prefix[i] + e[i];
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - halfWindow);
    const b = Math.min(frames, i + halfWindow + 1);
    const v = e[i] - (prefix[b] - prefix[a]) / (b - a);
    out[i] = rectify ? (v > 0 ? v : 0) : v;
  }
  return out;
}

/**
 * Find how far the reference (official) audio is shifted relative to the
 * practice audio, given onsetFeatures() of each.
 *
 * Returns candidates sorted best-first. Each candidate's `offset` (seconds)
 * means: the musical moment at practice time t happens at reference time
 * t + offset.
 *
 * Two stages:
 *  1. Whitened (GCC-PHAT style) cross-correlation over every possible lag.
 *     Dividing the cross-spectrum by a power of its magnitude flattens strong
 *     periodic components (a beat repeating every bar) so non-repeating
 *     detail (melody, lyrics, fills) decides where the peak is. Peaks are
 *     sharp, which gives precise offsets. Its weakness: it also treats the
 *     start/end of each recording as features, producing fake peaks where
 *     the files' edges line up.
 *  2. Each candidate peak is re-checked by directly correlating the
 *     overlapping parts of the two recordings (no whitening, so no edge
 *     artifacts), and candidates are ranked by that. Stage 1 only proposes
 *     candidates and supplies the precise sub-frame offset.
 */
export function findOffsets(practiceFeat, referenceFeat, { maxCandidates = 3, minOverlapSec = 8, phat = PHAT } = {}) {
  const nbands = Math.min(practiceFeat.length, referenceFeat.length);
  const np = practiceFeat[0]?.length ?? 0;
  const nr = referenceFeat[0]?.length ?? 0;
  if (!nbands || np < ENV_RATE || nr < ENV_RATE) return [];

  const minOverlap = Math.min(Math.round(minOverlapSec * ENV_RATE), Math.floor(Math.min(np, nr) * 0.5));
  const kMin = -(np - minOverlap);
  const kMax = nr - minOverlap;
  const len = kMax - kMin + 1;
  if (len <= 0) return [];

  // ---- Stage 1: whitened cross-correlation over all lags ----
  const score = new Float64Array(len);
  const n = nextPow2(np + nr);
  const pr = new Float64Array(n), pi = new Float64Array(n);
  const rr = new Float64Array(n), ri = new Float64Array(n);
  for (let b = 0; b < nbands; b++) {
    const p = practiceFeat[b], r = referenceFeat[b];
    pr.fill(0); pi.fill(0); rr.fill(0); ri.fill(0);
    pr.set(p);
    rr.set(r);
    fft(pr, pi);
    fft(rr, ri);
    // conj(P) * R  ->  c[k] = sum_t p[t] * r[t + k], then whiten.
    let msum = 0;
    for (let i = 0; i < n; i++) {
      const a = pr[i], bb = -pi[i], c = rr[i], d = ri[i];
      const x = a * c - bb * d;
      const y = a * d + bb * c;
      const m = Math.pow(Math.hypot(x, y) + 1e-12, phat);
      pr[i] = x / m;
      pi[i] = y / m;
      msum += Math.hypot(pr[i], pi[i]);
    }
    if (!(msum > 0)) continue;
    fft(pr, pi, true);
    const norm = 1 / (msum * nbands);
    for (let k = kMin; k <= kMax; k++) score[k - kMin] += pr[(k + n) % n] * norm;
  }

  // Distinct peaks, at least 1 s apart.
  const sep = ENV_RATE;
  const used = new Uint8Array(len);
  const peaks = [];
  for (let c = 0; c < 12; c++) {
    let best = -1, bestV = -Infinity;
    for (let i = 0; i < len; i++) {
      if (!used[i] && score[i] > bestV) { bestV = score[i]; best = i; }
    }
    if (best < 0 || bestV <= 0) break;
    let frac = 0; // sub-sample refinement via parabolic interpolation
    if (best > 0 && best < len - 1) {
      const y0 = score[best - 1], y1 = score[best], y2 = score[best + 1];
      const den = y0 - 2 * y1 + y2;
      if (den < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
    }
    peaks.push({ lag: best + kMin, offset: (best + kMin + frac) / ENV_RATE, whitened: bestV });
    for (let i = Math.max(0, best - sep); i <= Math.min(len - 1, best + sep); i++) used[i] = 1;
  }
  if (!peaks.length) return [];

  // ---- Stage 2: re-check each candidate on the actual overlap ----
  const shorter = Math.min(np, nr);
  for (const pk of peaks) {
    let best = -Infinity;
    for (let d = -2; d <= 2; d++) best = Math.max(best, overlapCorrelation(practiceFeat, referenceFeat, pk.lag + d, nbands));
    const t0 = Math.max(0, -pk.lag), t1 = Math.min(np, nr - pk.lag);
    const coverage = Math.sqrt(Math.max(0, t1 - t0) / shorter);
    pk.direct = Math.max(0, best) * coverage;
    pk.score = pk.direct;
  }
  peaks.sort((a, b) => b.score - a.score);

  // Confidence: how much the best match stands out from the runner-up.
  // (Wrong-but-plausible offsets, e.g. one bar or one chorus away, still
  // share the beat pattern, so even a clearly correct match only beats them
  // by a modest relative margin.)
  const top = peaks[0].score;
  const second = peaks[1]?.score ?? 0;
  const gap = top > 0 ? (top - second) / top : 0;
  return peaks.slice(0, maxCandidates).map((p, i) => ({
    offset: p.offset,
    score: p.score,
    confidence: i === 0 ? (gap > 0.07 ? 'high' : gap > 0.025 ? 'medium' : 'low') : undefined,
  }));
}

/** Mean over bands of the normalized correlation of the overlapping part at integer lag k. */
function overlapCorrelation(pf, rf, k, nbands) {
  const np = pf[0].length, nr = rf[0].length;
  const t0 = Math.max(0, -k), t1 = Math.min(np, nr - k);
  if (t1 - t0 < ENV_RATE) return 0;
  let total = 0;
  for (let b = 0; b < nbands; b++) {
    const p = pf[b], r = rf[b];
    let sp = 0, sr = 0;
    for (let t = t0; t < t1; t++) { sp += p[t]; sr += r[t + k]; }
    const m = t1 - t0, mp = sp / m, mr = sr / m;
    let xy = 0, xx = 0, yy = 0;
    for (let t = t0; t < t1; t++) {
      const x = p[t] - mp, y = r[t + k] - mr;
      xy += x * y; xx += x * x; yy += y * y;
    }
    if (xx > 0 && yy > 0) total += xy / Math.sqrt(xx * yy);
  }
  return total / nbands;
}
