// Synthetic "song" + simulated phone-in-a-dance-studio recording, for testing
// the audio sync without needing real copyrighted music.

export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A pop-song-like track: drums + melody, with a repeated chorus. */
export function makeSong(sr, seconds, seed = 1) {
  const rng = makeRng(seed);
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  const bpm = 124;
  const beat = 60 / bpm;
  const scale = [0, 2, 4, 7, 9, 12, 14, 16];

  // 8-bar phrases; chorus phrase repeats verbatim.
  const phrase = () => Array.from({ length: 32 }, () => (rng() < 0.75 ? scale[Math.floor(rng() * scale.length)] : null));
  const chorus = phrase();
  const sections = [phrase(), chorus, phrase(), chorus, phrase(), chorus, chorus, phrase()];

  const add = (t0, dur, fn) => {
    const a = Math.floor(t0 * sr);
    const b = Math.min(n, a + Math.floor(dur * sr));
    for (let i = Math.max(0, a); i < b; i++) out[i] += fn((i - a) / sr);
  };

  const totalBeats = Math.floor(seconds / beat);
  for (let b = 0; b < totalBeats; b++) {
    const t = b * beat;
    add(t, 0.25, (x) => Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-x * 30)) * x) * Math.exp(-x * 12) * 0.8); // kick
  }
  // Snare (noise) on 2 and 4, hats on 8ths with random accents.
  for (let b = 0; b < totalBeats; b++) {
    const t = b * beat;
    if (b % 2 === 1) add(t, 0.18, (x) => (rng() * 2 - 1) * Math.exp(-x * 20) * 0.5);
    for (let h = 0; h < 2; h++) {
      const acc = 0.08 + 0.12 * rng();
      add(t + h * beat / 2, 0.05, (x) => (rng() * 2 - 1) * Math.exp(-x * 80) * acc);
    }
  }
  // Melody: one note per beat from the section's phrase.
  for (let b = 0; b < totalBeats; b++) {
    const sec = sections[Math.floor(b / 32) % sections.length];
    const note = sec[b % 32];
    if (note === null) continue;
    const f = 330 * Math.pow(2, note / 12);
    add(b * beat, beat * 0.9, (x) => (Math.sin(2 * Math.PI * f * x) + 0.3 * Math.sin(4 * Math.PI * f * x)) * Math.exp(-x * 4) * 0.3);
  }
  return out;
}

/**
 * Simulate a phone recording of `song` played on a speaker in a studio:
 * starts `leadIn` seconds before song time `songStart` (lead-in is chatter),
 * lasts `seconds`, with low-pass, echo, noise, talking, and lower volume.
 */
export function makePracticeRecording(song, sr, { songStart, leadIn, seconds, seed = 7 }) {
  const rng = makeRng(seed);
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  const offsetSamples = Math.round((songStart - leadIn) * sr);
  for (let i = 0; i < n; i++) {
    const j = i + offsetSamples;
    if (i >= leadIn * sr && j >= 0 && j < song.length) out[i] = song[j] * 0.35;
  }
  // Echo
  const echo = [[Math.round(0.06 * sr), 0.4], [Math.round(0.14 * sr), 0.25], [Math.round(0.23 * sr), 0.12]];
  const dry = out.slice();
  for (const [d, g] of echo) for (let i = d; i < n; i++) out[i] += dry[i - d] * g;
  // One-pole low-pass (cheap phone speaker/mic)
  let y = 0;
  for (let i = 0; i < n; i++) { y += 0.35 * (out[i] - y); out[i] = y; }
  // Background noise + "talking" bursts (modulated noise) + footsteps
  let talk = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.max(0, Math.sin(2 * Math.PI * 0.7 * t) * Math.sin(2 * Math.PI * 3.1 * t));
    talk += 0.2 * ((rng() * 2 - 1) - talk);
    out[i] += (rng() * 2 - 1) * 0.02 + talk * env * 0.15;
  }
  for (let k = 0; k < seconds * 3; k++) {
    const at = Math.floor(rng() * n);
    for (let i = 0; i < sr * 0.04 && at + i < n; i++) out[at + i] += (rng() * 2 - 1) * Math.exp(-i / (sr * 0.008)) * 0.3;
  }
  return out;
}

export function writeWav(path, samples, sr, fs) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 20000))), 44 + i * 2);
  fs.writeFileSync(path, buf);
}
