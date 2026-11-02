// Runs the audio analysis off the main thread so the page stays responsive.
import { onsetFeatures, findOffsets, ENV_RATE } from './sync.js?v=4';

let practiceFeat = null;
let referenceFeat = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'analyze') {
      practiceFeat = onsetFeatures(data.practice);
      referenceFeat = onsetFeatures(data.reference);
      const candidates = findOffsets(practiceFeat, referenceFeat, { maxCandidates: 5 });
      self.postMessage({ type: 'result', id: data.id, candidates });
    } else if (data.type === 'local') {
      // Re-sync using only a window of the practice video around `time`.
      // Useful when a practice recording has several runs that restart the
      // music from different points.
      if (!practiceFeat) throw new Error('Run a full analysis first.');
      const n = practiceFeat[0].length;
      const a = Math.max(0, Math.round((data.time - data.window / 2) * ENV_RATE));
      const b = Math.min(n, Math.round((data.time + data.window / 2) * ENV_RATE));
      if (b - a < ENV_RATE * 4) throw new Error('Not enough audio around this point.');
      const slice = practiceFeat.map((band) => band.subarray(a, b));
      const shift = a / ENV_RATE;
      const candidates = findOffsets(slice, referenceFeat, { maxCandidates: 5, minOverlapSec: 4 })
        .map((c) => ({ ...c, offset: c.offset - shift }));
      self.postMessage({ type: 'result', id: data.id, candidates });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: data.id, message: String(err?.message || err) });
  }
};
