// Bump ?v= in index.html, here, and in sync-worker.js on every release so
// browsers don't keep running an old cached copy.
import { decodeAudioMono } from './sync.js?v=3';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const FRAME = 1 / 30;
const ROLES = ['practice', 'reference'];

const els = {
  loader: $('#loader'),
  player: $('#player'),
  panels: $('#panels'),
  scrub: $('#scrub'),
  loopRegion: $('#loop-region'),
  tPractice: $('#t-practice'),
  tReference: $('#t-reference'),
  tDuration: $('#t-duration'),
  play: $('#play'),
  speed: $('#speed'),
  audio: $('#audio'),
  syncStatus: $('#sync-status'),
  offset: $('#offset'),
  nextMatch: $('#next-match'),
  resyncHere: $('#resync-here'),
  manual: $('#manual'),
  loopClear: $('#loop-clear'),
  layout: $('#layout'),
  toast: $('#toast'),
};

const panel = Object.fromEntries(ROLES.map((r) => {
  const root = $(`.panel[data-role="${r}"]`);
  return [r, {
    root,
    video: $('video', root),
    stage: $('.stage', root),
    pan: $('.pan', root),
    msg: $('.stage-msg', root),
    manual: $('.manual-controls', root),
  }];
}));
const P = panel.practice.video;  // master clock
const R = panel.reference.video; // follows P with an offset

const state = {
  files: { practice: null, reference: null },
  offset: 0,            // reference time = practice time + offset
  candidates: [],
  candIndex: 0,
  rate: 1,
  playing: false,
  manual: false,
  loopA: null,
  loopB: null,
  scrubbing: false,
  mirror: { practice: false, reference: false },
  zoom: { practice: { s: 1, x: 0, y: 0 }, reference: { s: 1, x: 0, y: 0 } },
  analysisId: 0,
};

// ---------------------------------------------------------------- helpers

function fmt(t) {
  if (!isFinite(t)) t = 0;
  const sign = t < 0 ? '−' : '';
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${sign}${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let toastTimer;
function toast(msg, ms = 2600) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), ms);
}

function setStatus(html) { els.syncStatus.innerHTML = html; }

function storageKey() {
  const f = state.files;
  return `cc:v1:${f.practice.name}:${f.practice.size}|${f.reference.name}:${f.reference.size}`;
}
function save() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({ offset: state.offset, mirror: state.mirror }));
  } catch { /* private mode etc. */ }
}
function loadSaved() {
  try {
    const raw = localStorage.getItem(storageKey());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- worker

const worker = new Worker(new URL('./sync-worker.js?v=3', import.meta.url), { type: 'module' });
const pending = new Map();
let nextId = 1;
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  data.type === 'error' ? p.reject(new Error(data.message)) : p.resolve(data);
};
function ask(msg, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

// ---------------------------------------------------------------- loading

for (const drop of $$('.drop')) {
  const role = drop.dataset.role;
  const input = $('input', drop);
  input.addEventListener('change', () => input.files[0] && setFile(role, input.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) setFile(role, f);
  });
}

function setFile(role, file) {
  state.files[role] = file;
  const drop = $(`.drop[data-role="${role}"]`);
  drop.classList.add('done');
  $('.drop-file', drop).textContent = `✓ ${file.name}`;
  if (state.files.practice && state.files.reference) startCompare();
}

function startCompare() {
  pause();
  for (const r of ROLES) {
    const v = panel[r].video;
    if (v.src) URL.revokeObjectURL(v.src);
    v.src = URL.createObjectURL(state.files[r]);
  }
  state.candidates = [];
  state.candIndex = 0;
  tempoWarned = false;
  corrections = 0;
  state.loopA = state.loopB = null;
  updateLoop();
  const saved = loadSaved();
  state.offset = saved?.offset ?? 0;
  state.mirror = saved?.mirror ?? { practice: false, reference: false };
  applyMirror();
  updateOffset();
  setManual(false);
  els.loader.hidden = true;
  els.player.hidden = false;
  analyze(saved);
}

async function analyze(saved) {
  const id = ++state.analysisId;
  els.nextMatch.disabled = els.resyncHere.disabled = true;
  setStatus(saved
    ? 'Using your saved sync for these videos. Re-checking the music in the background…'
    : '⏳ Reading the audio from both videos…');
  try {
    // Decode one at a time to keep memory down on phones.
    const practice = await decodeAudioMono(state.files.practice);
    if (id !== state.analysisId) return;
    const reference = await decodeAudioMono(state.files.reference);
    if (id !== state.analysisId) return;
    if (!saved) setStatus('⏳ Matching the music…');
    const { candidates } = await ask({ type: 'analyze', practice, reference }, [practice.buffer, reference.buffer]);
    if (id !== state.analysisId) return;
    if (!candidates.length) throw new Error('No match found');
    state.candidates = candidates;
    state.candIndex = 0;
    els.nextMatch.disabled = candidates.length < 2;
    els.resyncHere.disabled = false;
    if (saved) {
      const diff = saved.offset - candidates[0].offset;
      const ms = Math.round(Math.abs(diff) * 1000);
      setStatus(Math.abs(diff) < 0.05
        ? `<span class="ok">✓ Synced</span> (your saved sync, confirmed by the music)`
        : Math.abs(diff) < 1
          ? `<span class="ok">✓ Synced</span> using your saved fine-tuning (${ms} ms ${diff > 0 ? 'later' : 'earlier'} than auto-sync). <button class="btn sm" id="use-auto">Use auto-sync</button>`
          : `Using your saved sync, but the music suggests a different one. <button class="btn sm" id="use-auto">Use auto-sync</button>`);
      $('#use-auto')?.addEventListener('click', () => applyCandidate(0));
    } else {
      applyCandidate(0);
    }
  } catch (err) {
    if (id !== state.analysisId) return;
    console.error(err);
    setStatus(`<span class="bad">Couldn't match the music automatically</span> (${err.message}). Use <b>Manual sync</b> to line them up yourself.`);
  }
}

function applyCandidate(i) {
  const c = state.candidates[i];
  if (!c) return;
  state.candIndex = i;
  state.offset = c.offset;
  updateOffset();
  syncReference(true);
  save();
  const conf = i === 0 ? c.confidence : null;
  const where = `practice ${fmt(0)} lines up with official ${fmt(c.offset)}`;
  if (i > 0) {
    setStatus(`Showing match ${i + 1} of ${state.candidates.length}: ${where}`);
  } else if (conf === 'high') {
    setStatus(`<span class="ok">✓ Synced by music</span>: ${where}`);
  } else if (conf === 'medium') {
    setStatus(`<span class="ok">✓ Synced by music</span>: ${where}. If it looks off, press <b>Try next match</b>.`);
  } else {
    setStatus(`<span class="warn">Synced, but not certain</span>: ${where}. The song may repeat a section here. If it looks off, press <b>Try next match</b> or use <b>Manual sync</b>.`);
  }
}

// ---------------------------------------------------------------- sync engine

function refTarget() { return P.currentTime + state.offset; }

// Drift control. Both videos ALWAYS play at exactly the chosen speed:
// playbackRate is never used for corrections. If the two drift apart (e.g.
// one video stutters while decoding), the video you're NOT listening to is
// jumped back into place, at most about once a second. The video you're
// hearing is never touched.
const DRIFT_FIX = 0.035;  // > 35 ms (about 1 frame) apart: re-align
let drift = 0;            // smoothed (official - expected official time)
let lastCheck = 0;
let lastJump = 0;
let seekLead = 0.03;      // learned: how far behind a jumped video lands (seek latency)
let pendingLeadCheck = false;
let corrections = 0;
const driftLog = [];      // [wall s, drift s] between corrections, to spot tempo mismatches
let tempoWarned = false;

/** Which video gets re-aligned: the one you're not listening to. */
function follower() { return els.audio.value === 'reference' ? P : R; }

function resetDrift() {
  drift = 0;
  driftLog.length = 0;
  if (P.playbackRate !== state.rate) P.playbackRate = state.rate;
  if (R.playbackRate !== state.rate) R.playbackRate = state.rate;
}

/** Jump the follower so the two line up again. */
function realign() {
  // Aim slightly ahead: a playing video lands a little late after a jump.
  const lead = state.playing ? seekLead * state.rate : 0;
  if (follower() === P) P.currentTime = clamp(R.currentTime - state.offset + lead, 0, P.duration || 0);
  else R.currentTime = refTarget() + lead;
  resetDrift();
}

function refInRange(t) { return t >= 0 && (!R.duration || t < R.duration - 0.03); }

/** Keep the official video locked to the practice video. */
function syncReference(force = false) {
  if (state.manual) return;
  const t = refTarget();
  const inRange = refInRange(t);
  const msg = panel.reference.msg;
  if (!inRange) {
    msg.hidden = false;
    msg.textContent = t < 0
      ? `Official video starts in ${(-t).toFixed(1)} s`
      : 'Official video has ended';
    if (!R.paused) R.pause();
    const clampT = t < 0 ? 0 : (R.duration || 0);
    if (force || Math.abs(R.currentTime - clampT) > 0.1) R.currentTime = clampT;
    return;
  }
  msg.hidden = true;
  if (state.playing) {
    if (R.paused) {
      R.currentTime = t;
      resetDrift();
      R.play().catch(() => {});
      return;
    }
    if (P.seeking || R.seeking) return;
    const now = performance.now();
    if (!force && now - lastCheck < 100) return; // ~10 checks per second is plenty
    lastCheck = now;

    // currentTime readings jitter a little, so smooth before reacting.
    const raw = R.currentTime - t; // > 0: official is ahead of practice
    drift = Math.abs(raw - drift) > 0.2 ? raw : drift * 0.7 + raw * 0.3;

    if (pendingLeadCheck && now - lastJump > 400) {
      // Learn the seek latency from where the last jump actually landed.
      pendingLeadCheck = false;
      const behind = follower() === P ? raw : -raw; // > 0: follower still behind
      seekLead = clamp(seekLead + behind * 0.8, 0, 0.4);
    }

    if (force || (Math.abs(drift) > DRIFT_FIX && now - lastJump > 1000)) {
      lastJump = now;
      if (!force) corrections++;
      pendingLeadCheck = true;
      realign();
      return;
    }

    // If drift keeps growing steadily between corrections, the two
    // recordings run at different tempos (e.g. the music was played at a
    // different speed during practice). Tell the user instead of hiding it.
    driftLog.push([now / 1000, raw]);
    if (driftLog.length > 80) driftLog.shift();
    if (!tempoWarned && driftLog.length >= 50) {
      const n = driftLog.length;
      const [t0, d0] = driftLog[0], [t1, d1] = driftLog[n - 1];
      const ratePerSec = (d1 - d0) / (t1 - t0);
      if (t1 - t0 > 4 && Math.abs(ratePerSec) > 0.004) {
        tempoWarned = true;
        toast(`Heads up: the two videos run at slightly different speeds (${(Math.abs(ratePerSec) * 100).toFixed(1)}%). Was the music played faster/slower in one of them?`, 8000);
      }
    }
  } else if (force || Math.abs(R.currentTime - t) > 0.004) {
    R.currentTime = t;
  }
}

function play() {
  if (!P.src) return;
  if (state.loopA !== null && state.loopB !== null && (P.currentTime < state.loopA || P.currentTime >= state.loopB)) {
    P.currentTime = state.loopA;
  } else if (P.ended || P.currentTime >= P.duration - 0.05) {
    P.currentTime = 0;
  }
  state.playing = true;
  resetDrift();
  P.play().catch((e) => { toast(`Can't play the practice video: ${e.message}`); pause(); });
  // Start the official video inside this click so phones allow its sound.
  if (state.manual) {
    R.play().catch(() => {});
  } else {
    const t = refTarget();
    if (refInRange(t)) R.currentTime = t;
    R.play().then(() => { if (!refInRange(refTarget())) R.pause(); }).catch(() => {});
  }
  els.play.textContent = '❚❚';
}

function pause() {
  state.playing = false;
  P.pause();
  R.pause();
  resetDrift();
  els.play.textContent = '▶';
  syncReference(true);
}

function togglePlay() { state.playing ? pause() : play(); }

function seek(t) {
  P.currentTime = clamp(t, 0, P.duration || 0);
  syncReference(true);
}

function step(dt) {
  if (state.playing) pause();
  seek(P.currentTime + dt);
}

// Add ?debug to the URL to see each video's real speed and the drift live.
const debugEl = new URLSearchParams(location.search).has('debug')
  ? Object.assign(document.body.appendChild(document.createElement('pre')), { className: 'debug' })
  : null;

function tick() {
  const dur = P.duration || 0;
  if (state.playing) {
    if (state.loopA !== null && state.loopB !== null && P.currentTime >= state.loopB) {
      P.currentTime = state.loopA;
      syncReference(true);
    } else if (P.ended) {
      pause();
    } else {
      syncReference();
    }
  }
  if (!state.scrubbing && dur) els.scrub.value = String(P.currentTime / dur);
  els.tPractice.textContent = fmt(P.currentTime);
  els.tReference.textContent = state.manual ? `official ${fmt(R.currentTime)}` : `official ${fmt(refTarget())}`;
  els.tDuration.textContent = `/ ${fmt(dur)}`;
  if (debugEl) {
    debugEl.textContent =
      `practice ${P.currentTime.toFixed(3)}s @ ${P.playbackRate.toFixed(3)}×\n` +
      `official ${R.currentTime.toFixed(3)}s @ ${R.playbackRate.toFixed(3)}×\n` +
      `drift ${(drift * 1000).toFixed(0)} ms · re-aligned ${corrections}× (moves ${follower() === P ? 'practice' : 'official'})\n` +
      `chosen speed ${state.rate}×`;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------- controls

els.play.addEventListener('click', togglePlay);
$('#back5').addEventListener('click', () => seek(P.currentTime - 5));
$('#fwd5').addEventListener('click', () => seek(P.currentTime + 5));
$('#frame-back').addEventListener('click', () => step(-FRAME));
$('#frame-fwd').addEventListener('click', () => step(FRAME));

els.scrub.addEventListener('pointerdown', () => (state.scrubbing = true));
els.scrub.addEventListener('input', () => {
  state.scrubbing = true;
  seek(Number(els.scrub.value) * (P.duration || 0));
});
els.scrub.addEventListener('change', () => (state.scrubbing = false));
window.addEventListener('pointerup', () => (state.scrubbing = false));

els.speed.addEventListener('change', () => {
  state.rate = Number(els.speed.value);
  resetDrift();
});

function applyAudio() {
  const a = els.audio.value;
  P.muted = !(a === 'practice' || a === 'both');
  R.muted = !(a === 'reference' || a === 'both');
}
els.audio.addEventListener('change', () => { applyAudio(); resetDrift(); });
applyAudio();

function updateLoop() {
  const dur = P.duration || 0;
  const { loopA: a, loopB: b } = state;
  els.loopClear.disabled = a === null && b === null;
  $('#loop-a').classList.toggle('active', a !== null);
  $('#loop-b').classList.toggle('active', b !== null);
  if (a !== null && b !== null && dur) {
    els.loopRegion.hidden = false;
    els.loopRegion.style.left = `${(a / dur) * 100}%`;
    els.loopRegion.style.width = `${((b - a) / dur) * 100}%`;
  } else {
    els.loopRegion.hidden = true;
  }
}
function setLoopA() {
  state.loopA = P.currentTime;
  if (state.loopB !== null && state.loopB <= state.loopA + 0.1) state.loopB = null;
  updateLoop();
  toast(`Loop start ${fmt(state.loopA)}`);
}
function setLoopB() {
  const t = P.currentTime;
  if (state.loopA === null || t <= state.loopA + 0.1) {
    if (state.loopA === null) state.loopA = Math.max(0, t - 8);
    else return toast('Loop end must be after loop start');
  }
  state.loopB = t;
  updateLoop();
  toast(`Looping ${fmt(state.loopA)} → ${fmt(state.loopB)}`);
}
function clearLoop() { state.loopA = state.loopB = null; updateLoop(); }
$('#loop-a').addEventListener('click', setLoopA);
$('#loop-b').addEventListener('click', setLoopB);
els.loopClear.addEventListener('click', clearLoop);
P.addEventListener('loadedmetadata', updateLoop);

els.layout.addEventListener('click', () => {
  const stacked = els.panels.classList.toggle('stacked');
  els.layout.textContent = stacked ? 'Side by side' : 'Stack';
});

function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  const el = els.player;
  (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el)?.catch?.(() => toast('Fullscreen not available here'));
  if (!el.requestFullscreen && !el.webkitRequestFullscreen) toast('Fullscreen not available here. Try rotating your phone.');
}
$('#fullscreen').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => els.player.classList.toggle('is-fullscreen', !!document.fullscreenElement));

$('#change-videos').addEventListener('click', () => {
  pause();
  state.analysisId++;
  els.player.hidden = true;
  els.loader.hidden = false;
});

// ---------------------------------------------------------------- sync controls

function updateOffset() {
  const o = state.offset;
  els.offset.textContent = `${o >= 0 ? '+' : '−'}${Math.abs(o).toFixed(3)}s`;
  els.offset.title = 'Official video time minus practice video time';
}

function nudge(d) {
  state.offset += d;
  updateOffset();
  syncReference(true);
  save();
}
$$('[data-nudge]').forEach((b) => b.addEventListener('click', () => nudge(Number(b.dataset.nudge))));

els.nextMatch.addEventListener('click', () => {
  if (state.candidates.length < 2) return;
  applyCandidate((state.candIndex + 1) % state.candidates.length);
});

els.resyncHere.addEventListener('click', async () => {
  els.resyncHere.disabled = true;
  setStatus('⏳ Re-matching the music around this point…');
  try {
    const { candidates } = await ask({ type: 'local', time: P.currentTime, window: 30 });
    if (!candidates.length) throw new Error('No match found here');
    state.candidates = candidates;
    els.nextMatch.disabled = candidates.length < 2;
    applyCandidate(0);
  } catch (err) {
    setStatus(`<span class="bad">${err.message}</span>`);
  } finally {
    els.resyncHere.disabled = false;
  }
});

function setManual(on) {
  state.manual = on;
  if (state.playing) pause();
  els.manual.textContent = on ? 'Lock sync here' : 'Manual sync';
  els.manual.classList.toggle('active', on);
  for (const r of ROLES) panel[r].manual.hidden = !on;
  if (on) {
    panel.reference.msg.hidden = true;
    setStatus('Manual sync: find the same moment in both videos (a clap or a clear move works well). Use the controls under each video, then press <b>Lock sync here</b>.');
  }
}
els.manual.addEventListener('click', () => {
  if (!state.manual) return setManual(true);
  state.offset = R.currentTime - P.currentTime;
  setManual(false);
  updateOffset();
  syncReference(true);
  save();
  setStatus(`<span class="ok">✓ Synced manually</span>: practice ${fmt(P.currentTime)} = official ${fmt(R.currentTime)}`);
});

// Per-video stepping + scrubbing while in manual mode.
for (const r of ROLES) {
  const { manual, video } = panel[r];
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0'; range.max = '1'; range.step = '0.0001'; range.value = '0';
  range.style.flexBasis = '100%';
  range.setAttribute('aria-label', `${r} position`);
  manual.prepend(range);
  range.addEventListener('input', () => { video.currentTime = Number(range.value) * (video.duration || 0); });
  video.addEventListener('timeupdate', () => { if (state.manual && video.duration) range.value = String(video.currentTime / video.duration); });
  video.addEventListener('seeked', () => { if (state.manual && video.duration) range.value = String(video.currentTime / video.duration); });
  $$('[data-step]', manual).forEach((b) => b.addEventListener('click', () => {
    video.pause();
    if (r === 'practice') state.playing = false, (els.play.textContent = '▶');
    video.currentTime = clamp(video.currentTime + Number(b.dataset.step), 0, video.duration || 0);
  }));
}

// ---------------------------------------------------------------- mirror + zoom

function applyMirror() {
  for (const r of ROLES) {
    panel[r].video.classList.toggle('mirrored', state.mirror[r]);
    $('[data-act="mirror"]', panel[r].root).classList.toggle('active', state.mirror[r]);
  }
}
function toggleMirror(r) {
  state.mirror[r] = !state.mirror[r];
  applyMirror();
  save();
}

for (const r of ROLES) {
  const { root, stage, pan } = panel[r];
  const z = state.zoom[r];
  $('[data-act="mirror"]', root).addEventListener('click', () => toggleMirror(r));
  $('[data-act="zoom-reset"]', root).addEventListener('click', () => resetZoom());

  function apply() {
    const w = stage.clientWidth, h = stage.clientHeight;
    z.s = clamp(z.s, 1, 8);
    z.x = clamp(z.x, w - w * z.s, 0);
    z.y = clamp(z.y, h - h * z.s, 0);
    pan.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
  }
  function zoomAt(px, py, factor) {
    const ns = clamp(z.s * factor, 1, 8);
    z.x = px - (px - z.x) * (ns / z.s);
    z.y = py - (py - z.y) * (ns / z.s);
    z.s = ns;
    apply();
  }
  function resetZoom() { z.s = 1; z.x = 0; z.y = 0; apply(); }
  const local = (e) => { const b = stage.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = local(e);
    zoomAt(x, y, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  const pointers = new Map();
  let pinch = null;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    stage.classList.add('grabbing');
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const cur = local(e);
    pointers.set(e.pointerId, cur);
    if (pointers.size === 1) {
      z.x += cur[0] - prev[0];
      z.y += cur[1] - prev[1];
      apply();
    } else if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      z.x += mx - pinch.mx;
      z.y += my - pinch.my;
      zoomAt(mx, my, d / (pinch.d || d));
      pinch = { d, mx, my };
    }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) stage.classList.remove('grabbing');
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('dblclick', resetZoom);
  new ResizeObserver(apply).observe(stage);
}

// ---------------------------------------------------------------- errors

for (const r of ROLES) {
  panel[r].video.addEventListener('error', () => {
    const name = r === 'practice' ? 'practice' : 'official';
    panel[r].msg.hidden = false;
    panel[r].msg.textContent = `This browser can't play the ${name} video's format. Try Chrome or Safari, or convert it to MP4 (H.264). On iPhone: Settings → Camera → Formats → Most Compatible.`;
  });
}

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  if (els.player.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === 'SELECT' || (tag === 'INPUT' && e.target.type !== 'range') || tag === 'TEXTAREA') return;
  const k = e.key;
  const handled = {
    ' ': togglePlay,
    k: togglePlay,
    ArrowLeft: () => seek(P.currentTime - (e.shiftKey ? 1 : 5)),
    ArrowRight: () => seek(P.currentTime + (e.shiftKey ? 1 : 5)),
    ',': () => step(-FRAME),
    '.': () => step(FRAME),
    a: setLoopA,
    b: setLoopB,
    l: clearLoop,
    m: () => toggleMirror('practice'),
    n: () => toggleMirror('reference'),
    '[': () => nudge(-FRAME),
    ']': () => nudge(FRAME),
    f: toggleFullscreen,
  }[k.length === 1 ? k.toLowerCase() : k];
  if (handled) {
    e.preventDefault();
    handled();
  }
});

// Expose for debugging / automated tests.
window.__cc = { state, P, R, syncReference };
