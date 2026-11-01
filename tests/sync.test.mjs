// Run with: node tests/sync.test.mjs
import { onsetFeatures, findOffsets, SAMPLE_RATE as SR } from '../js/sync.js';
import { makeSong, makePracticeRecording } from './synth.mjs';

const song = makeSong(SR, 130, 1);
let failures = 0;

function check(name, { refStart, refLen, songStart, leadIn, seconds, tolerance = 0.012, acceptInTop = 1 }) {
  // "Official" video audio: clean song from refStart for refLen seconds.
  const ref = song.slice(Math.round(refStart * SR), Math.round((refStart + refLen) * SR));
  const prac = makePracticeRecording(song, SR, { songStart, leadIn, seconds });
  // Practice time t <-> song time (t - leadIn + songStart) <-> ref time (that - refStart)
  const expected = songStart - leadIn - refStart;
  const t0 = performance.now();
  const cands = findOffsets(onsetFeatures(prac), onsetFeatures(ref));
  const ms = (performance.now() - t0).toFixed(0);
  const idx = cands.findIndex((c) => Math.abs(c.offset - expected) <= tolerance);
  const ok = idx >= 0 && idx < acceptInTop;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}: expected ${expected.toFixed(3)}s, got ` +
      cands.map((c) => `${c.offset.toFixed(3)} (${c.score.toFixed(3)})`).join(', ') +
      ` | confidence ${cands[0]?.confidence} | match #${idx + 1} | ${ms} ms`,
  );
}

check('practice starts mid-song with chatter lead-in', { refStart: 0, refLen: 125, songStart: 13.37, leadIn: 4, seconds: 50 });
check('practice starts before reference (negative offset)', { refStart: 6, refLen: 120, songStart: 0, leadIn: 2.5, seconds: 60 });
check('full run-through, long', { refStart: 0, refLen: 128, songStart: 0, leadIn: 8.21, seconds: 125 });
// A short clip of only a repeated chorus is genuinely ambiguous; the right
// answer should at least be among the candidates offered.
check('short chorus-only clip (ambiguous)', { refStart: 0, refLen: 125, songStart: 15.48, leadIn: 1, seconds: 16, acceptInTop: 3 });
check('short clip, later chorus (ambiguous)', { refStart: 0, refLen: 125, songStart: 46.45, leadIn: 1, seconds: 16, acceptInTop: 3 });
check('24 s clip with lead-in', { refStart: 0, refLen: 125, songStart: 15.48, leadIn: 1, seconds: 24 });
check('starts exactly at song start', { refStart: 0, refLen: 125, songStart: 0, leadIn: 0, seconds: 40 });

process.exit(failures ? 1 : 0);
