// Dancer features: find dancers, follow a member with auto close-ups in both
// videos, ignore areas (mirrors), and the formation overlay.

import { analyzeVideo, getCached } from './dancers.js?v=4';
import { prepare, trackPair, cameraPath, formationAt, formationTransform } from './tracker.js?v=4';

export function initDancers({ panel, P, R, state, hooks, toast, roles, pairKey, fmt }) {
  const $ = (s) => document.querySelector(s);
  const ui = {
    status: $('#dancer-status'),
    start: $('#dancer-start'),
    find: $('#find-dancers'),
    ignorePre: $('#ignore-mode-pre'),
    progress: $('#dancer-progress'),
    bar: $('#dancer-progress-bar'),
    cancel: $('#dancer-cancel'),
    tools: $('#dancer-tools'),
    select: $('#member-select'),
    add: $('#member-add'),
    rename: $('#member-rename'),
    del: $('#member-delete'),
    closeup: $('#closeup'),
    zoom: $('#closeup-zoom'),
    boxes: $('#show-boxes'),
    ignore: $('#ignore-mode'),
    ignoreClear: $('#ignore-clear'),
    overlay: $('#overlay'),
    opacity: $('#overlay-opacity'),
    scale: $('#overlay-scale'),
    strip: $('#track-strip'),
    panels: $('#panels'),
  };
  const VIDEO = { practice: P, reference: R };
  const NAME = { practice: 'practice', reference: 'official' };
  const COLOR = { practice: '#ff5fa2', reference: '#8f7bff' };

  const D = {
    data: { practice: null, reference: null },
    prep: { practice: null, reference: null },
    ignore: { practice: [], reference: [] },
    members: [],
    current: null,
    tracks: null,
    paths: null,
    closeup: false,
    showBoxes: true,
    ignoreMode: false,
    overlay: false,
    zoom: 0.7,
    opacity: 0.45,
    scaleMode: 'spread',
    analyzing: false,
    cancel: false,
    drawing: null,
  };

  // ------------------------------------------------------------ storage

  const fileKey = (f) => `${f.name}:${f.size}:${f.lastModified}`;
  const load = (k, fallback) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full/private */ } };
  const ignoreKey = (role) => `cc:ignore:v1:${fileKey(state.files[role])}`;
  const membersKey = () => `cc:members:v1:${pairKey()}`;
  const saveMembers = () => store(membersKey(), { members: D.members, current: D.current });
  const savePrefs = () => store('cc:dancer-prefs', { zoom: D.zoom, opacity: D.opacity, scaleMode: D.scaleMode, showBoxes: D.showBoxes });
  Object.assign(D, load('cc:dancer-prefs', {}));
  ui.zoom.value = D.zoom;
  ui.opacity.value = D.opacity;
  ui.scale.value = D.scaleMode;

  // ------------------------------------------------------------ geometry

  // Analysis coords (pixels in the analyzed frame) <-> on-screen positions.
  function geom(role) {
    const { stage } = panel[role];
    const v = VIDEO[role];
    const data = D.data[role];
    const w = stage.clientWidth, h = stage.clientHeight;
    const vw = v.videoWidth || data?.W || 16, vh = v.videoHeight || data?.H || 9;
    const k = Math.min(w / vw, h / vh);
    const W = data?.W ?? vw, H = data?.H ?? vh;
    return { w, h, ox: (w - vw * k) / 2, oy: (h - vh * k) / 2, kA: (k * vw) / W, W, H, mirror: !!state.mirror[role] };
  }
  const toPan = (g, x, y) => [g.ox + (g.mirror ? g.W - x : x) * g.kA, g.oy + y * g.kA];
  function fromStage(role, sx, sy) {
    const g = geom(role), z = panel[role].z;
    const px = (sx - z.x) / z.s, py = (sy - z.y) / z.s;
    let x = (px - g.ox) / g.kA;
    if (g.mirror) x = g.W - x;
    return [x, (py - g.oy) / g.kA, g];
  }
  function frameAt(role, t = VIDEO[role].currentTime) {
    const d = D.data[role];
    if (!d) return -1;
    return Math.max(0, Math.min(d.frames.length - 1, Math.round(t / d.step)));
  }

  // ------------------------------------------------------------ canvases

  const canvases = {};
  for (const role of roles) {
    const c = document.createElement('canvas');
    c.className = 'overlay-canvas';
    panel[role].pan.appendChild(c);
    canvases[role] = c;
  }
  function sizeCanvas(c, w, h) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  // ------------------------------------------------------------ members

  const member = () => D.members.find((m) => m.id === D.current) || null;
  function addMember(name) {
    const n = D.members.length + 1;
    const m = { id: `m${Date.now().toString(36)}${n}`, name: name || `Member ${n}`, anchors: { practice: [], reference: [] } };
    D.members.push(m);
    D.current = m.id;
    saveMembers();
    renderMembers();
    return m;
  }
  function renderMembers() {
    ui.select.innerHTML = '';
    if (!D.members.length) {
      const o = document.createElement('option');
      o.textContent = '(tap a dancer)';
      o.value = '';
      ui.select.appendChild(o);
    }
    for (const m of D.members) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name;
      ui.select.appendChild(o);
    }
    ui.select.value = D.current || '';
    ui.rename.disabled = ui.del.disabled = !member();
  }

  // ------------------------------------------------------------ analysis

  function reset() {
    D.cancel = true;
    D.data = { practice: null, reference: null };
    D.prep = { practice: null, reference: null };
    D.tracks = D.paths = null;
    D.closeup = false;
    setOverlay(false);
    setIgnoreMode(false);
    ui.tools.hidden = true;
    ui.start.hidden = false;
    ui.progress.hidden = true;
    ui.strip.hidden = true;
  }

  async function onVideosLoaded() {
    reset();
    D.cancel = false;
    for (const role of roles) D.ignore[role] = load(ignoreKey(role), []);
    const saved = load(membersKey(), { members: [], current: null });
    D.members = saved.members;
    D.current = saved.current;
    renderMembers();
    setStatus('Follow a member with automatic close-ups, or overlay the official formation on yours. Start with <b>Find dancers</b>.');
    // Already analyzed on this device? Load instantly.
    const [cp, cr] = await Promise.all([getCached(state.files.practice), getCached(state.files.reference)]);
    if (cp && cr && !D.data.practice) {
      D.data.practice = cp;
      D.data.reference = cr;
      afterAnalysis();
    }
  }

  async function findDancers() {
    if (D.analyzing) return;
    D.analyzing = true;
    D.cancel = false;
    ui.start.hidden = true;
    ui.progress.hidden = false;
    ui.bar.value = 0;
    try {
      for (let k = 0; k < roles.length; k++) {
        const role = roles[k];
        if (D.data[role]) continue;
        D.data[role] = await analyzeVideo(state.files[role], {
          onProgress: (p, msg) => {
            ui.bar.value = (k + p) / roles.length;
            setStatus(`<b>${NAME[role] === 'practice' ? 'Practice' : 'Official'} video</b> (${k + 1} of 2): ${msg} You can keep watching meanwhile.`);
          },
          isCancelled: () => D.cancel,
        });
      }
      afterAnalysis();
    } catch (err) {
      ui.start.hidden = false;
      if (err.message === 'cancelled') setStatus('Stopped. Press <b>Find dancers</b> to continue; finished videos are remembered.');
      else { console.error(err); setStatus(`Couldn't analyze the dancers: ${err.message}`); }
    } finally {
      D.analyzing = false;
      ui.progress.hidden = true;
    }
  }

  function prepAll() {
    for (const role of roles) if (D.data[role]) D.prep[role] = prepare(D.data[role], { ignore: D.ignore[role] });
  }

  function afterAnalysis() {
    prepAll();
    ui.start.hidden = true;
    ui.tools.hidden = false;
    renderMembers();
    retrack();
    applyToggles();
  }

  // ------------------------------------------------------------ tracking

  function retrack() {
    const m = member();
    if (!m || !D.prep.practice || !D.prep.reference) {
      D.tracks = D.paths = null;
    } else {
      D.tracks = trackPair(D.prep.practice, D.prep.reference, m.anchors.practice, m.anchors.reference, {
        offset: state.offset, mirror: state.mirror, scaleMode: D.scaleMode,
      });
      D.paths = {
        practice: m.anchors.practice.length ? cameraPath(D.tracks.practice, D.prep.practice.step) : null,
        reference: m.anchors.reference.length ? cameraPath(D.tracks.official, D.prep.reference.step) : null,
      };
    }
    drawStrip();
    updateStatus();
  }

  function trackOf(role) { return D.tracks ? (role === 'practice' ? D.tracks.practice : D.tracks.official) : null; }

  function updateStatus() {
    if (!D.prep.practice) return;
    const m = member();
    if (!m) return setStatus('Tap a dancer in your <b>practice</b> video to start following them. (Pausing first makes it easier.)');
    const needP = !m.anchors.practice.length, needR = !m.anchors.reference.length;
    if (needP) return setStatus(`Tap <b>${esc(m.name)}</b> in your <b>practice</b> video.`);
    if (needR) return setStatus(`Now tap <b>${esc(m.name)}</b> in the <b>official</b> video (the same member's part).`);
    const tr = D.tracks.practice;
    const seen = tr.filter((b) => b && b.seen).length / tr.length;
    setStatus(`Following <b>${esc(m.name)}</b> (seen ${Math.round(seen * 100)}% of the practice video; the rest is hidden behind others or predicted). If the close-up follows the wrong person, pause and tap the right one.`);
  }

  // ------------------------------------------------------------ taps

  hooks.tap = (role, pt) => {
    if (!D.prep[role] || D.ignoreMode) return;
    const [x, y] = fromStage(role, pt[0], pt[1]);
    const i = frameAt(role);
    const dets = D.prep[role].frames[i] || [];
    const inside = dets.filter((d) => x >= d.x && x <= d.x + d.w && y >= d.y && y <= d.y + d.h);
    let d = null;
    if (inside.length) {
      // Several overlapping boxes: the one whose center is closest to the tap.
      d = inside.reduce((a, b) => (Math.hypot(a.cx - x, a.cy - y) <= Math.hypot(b.cx - x, b.cy - y) ? a : b));
    } else {
      const near = dets.map((q) => ({ q, dist: Math.hypot(q.cx - x, q.cy - y) / q.h })).sort((a, b) => a.dist - b.dist)[0];
      if (near && near.dist < 0.6) d = near.q;
    }
    if (!d) return toast('Tap on one of the dancer boxes. If nobody is boxed here, try a moment where they are clearly visible.');
    let m = member();
    if (!m) m = addMember();
    const t = i * D.prep[role].step;
    const hadBoth = m.anchors.practice.length && m.anchors.reference.length;
    m.anchors[role] = m.anchors[role]
      .filter((a) => Math.abs(a.t - t) > 1)
      .concat({ t, x: d.x, y: d.y, w: d.w, h: d.h, up: d.up, lo: d.lo })
      .sort((a, b) => a.t - b.t);
    saveMembers();
    retrack();
    if (hadBoth) toast(`Got it: following ${m.name} from this person at ${fmt(t)} in the ${NAME[role]} video.`);
    else if (m.anchors.practice.length && m.anchors.reference.length) {
      setCloseup(true);
      toast(`Following ${m.name} in both videos.`);
    }
  };

  // ------------------------------------------------------------ ignore areas

  function setIgnoreMode(on) {
    D.ignoreMode = on;
    ui.ignore.classList.toggle('active', on);
    ui.ignorePre.classList.toggle('active', on);
    for (const role of roles) panel[role].stage.classList.toggle('drawing', on);
    if (on) toast('Drag a box over the mirror (or anything else to skip). Dancers whose feet are inside are ignored.', 4000);
  }

  hooks.pointer = (phase, role, e, pt) => {
    if (!D.ignoreMode) return false;
    const [x, y, g] = fromStage(role, pt[0], pt[1]);
    const nx = Math.max(0, Math.min(1, x / g.W)), ny = Math.max(0, Math.min(1, y / g.H));
    if (phase === 'down') D.drawing = { role, x0: nx, y0: ny, x1: nx, y1: ny };
    else if (D.drawing && D.drawing.role === role) {
      D.drawing.x1 = nx;
      D.drawing.y1 = ny;
      if (phase === 'up') {
        const r = {
          x0: Math.min(D.drawing.x0, D.drawing.x1), x1: Math.max(D.drawing.x0, D.drawing.x1),
          y0: Math.min(D.drawing.y0, D.drawing.y1), y1: Math.max(D.drawing.y0, D.drawing.y1),
        };
        D.drawing = null;
        if ((r.x1 - r.x0) * (r.y1 - r.y0) > 0.002) {
          D.ignore[role].push(r);
          store(ignoreKey(role), D.ignore[role]);
          if (D.data[role]) { prepAll(); retrack(); }
          toast(`Ignoring that area in the ${NAME[role]} video.`);
        }
      }
    }
    return true;
  };

  // ------------------------------------------------------------ close-up camera

  hooks.lockView = (role) => D.closeup && !!D.paths?.[role];

  function camera(role) {
    const path = D.paths?.[role];
    const data = D.data[role];
    if (!path || !data) return;
    const t = VIDEO[role].currentTime / data.step;
    const i0 = Math.max(0, Math.min(path.cx.length - 1, Math.floor(t)));
    const i1 = Math.min(path.cx.length - 1, i0 + 1);
    const f = Math.max(0, Math.min(1, t - i0));
    const cx = path.cx[i0] + (path.cx[i1] - path.cx[i0]) * f;
    const cy = path.cy[i0] + (path.cy[i1] - path.cy[i0]) * f;
    const h = path.h[i0] + (path.h[i1] - path.h[i0]) * f;
    const g = geom(role);
    const z = panel[role].z;
    const s = Math.max(1, Math.min(8, (D.zoom * g.h) / (h * g.kA)));
    const [px, py] = toPan(g, cx, cy);
    z.s = s;
    z.x = g.w / 2 - s * px;
    z.y = g.h / 2 - s * py;
    panel[role].apply();
  }

  function setCloseup(on) {
    D.closeup = on;
    ui.closeup.classList.toggle('active', on);
    if (!on) for (const role of roles) panel[role].resetZoom();
    if (on && !D.paths) toast('Tap a dancer first to choose who to follow.');
  }

  // ------------------------------------------------------------ formation overlay

  function setOverlay(on) {
    D.overlay = on;
    ui.overlay.classList.toggle('active', on);
    ui.panels.classList.toggle('overlay-mode', on);
    if (on) toast('Official video shown see-through over yours, lined up by formation. Adjust "Official" to fade it.', 4000);
  }

  function drawGhost(ctx) {
    if (!D.prep.practice || !D.prep.reference || !R.videoWidth) return;
    const gP = geom('practice');
    const fP = formationAt(D.prep.practice, P.currentTime, gP.mirror);
    const fO = formationAt(D.prep.reference, R.currentTime, !!state.mirror.reference);
    const T = formationTransform(fP, fO, D.scaleMode);
    if (!T) return;
    const dO = D.data.reference;
    ctx.save();
    ctx.globalAlpha = D.opacity;
    // practice display coords -> screen
    ctx.translate(gP.ox, gP.oy);
    ctx.scale(gP.kA, gP.kA);
    // official display coords -> practice display coords (line up formations)
    ctx.translate(T.cP.x, T.cP.y);
    ctx.scale(T.s, T.s);
    ctx.translate(-T.cO.x, -T.cO.y);
    // official video -> official display coords (mirror if needed)
    if (state.mirror.reference) { ctx.translate(dO.W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(R, 0, 0, dO.W, dO.H);
    ctx.restore();
  }

  // ------------------------------------------------------------ drawing

  function drawPanel(role) {
    const g = geom(role);
    const ctx = sizeCanvas(canvases[role], g.w, g.h);
    const z = panel[role].z;
    const lw = 2 / z.s;
    if (role === 'practice' && D.overlay) drawGhost(ctx);

    // ignore areas
    const showIgnore = D.ignoreMode || (D.showBoxes && D.prep[role]);
    if (showIgnore) {
      for (const r of D.ignore[role].concat(D.drawing?.role === role ? [{
        x0: Math.min(D.drawing.x0, D.drawing.x1), x1: Math.max(D.drawing.x0, D.drawing.x1),
        y0: Math.min(D.drawing.y0, D.drawing.y1), y1: Math.max(D.drawing.y0, D.drawing.y1),
      }] : [])) {
        const [ax, ay] = toPan(g, r.x0 * g.W, r.y0 * g.H);
        const [bx, by] = toPan(g, r.x1 * g.W, r.y1 * g.H);
        ctx.fillStyle = 'rgba(255, 80, 80, 0.18)';
        ctx.strokeStyle = 'rgba(255, 110, 110, 0.9)';
        ctx.lineWidth = lw;
        ctx.setLineDash([6 / z.s, 4 / z.s]);
        ctx.fillRect(Math.min(ax, bx), ay, Math.abs(bx - ax), by - ay);
        ctx.strokeRect(Math.min(ax, bx), ay, Math.abs(bx - ax), by - ay);
        ctx.setLineDash([]);
      }
    }

    const prep = D.prep[role];
    if (!prep) return;
    const i = frameAt(role);
    // all dancers
    if (D.showBoxes) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      for (const d of prep.frames[i] || []) {
        const [ax, ay] = toPan(g, d.x, d.y);
        const [bx, by] = toPan(g, d.x + d.w, d.y + d.h);
        ctx.strokeRect(Math.min(ax, bx), ay, Math.abs(bx - ax), by - ay);
      }
    }
    // followed member
    const tr = trackOf(role);
    const b = tr?.[i];
    const m = member();
    if (b && m && m.anchors[role].length) {
      const [ax, ay] = toPan(g, b.x, b.y);
      const [bx, by] = toPan(g, b.x + b.w, b.y + b.h);
      const x0 = Math.min(ax, bx), w = Math.abs(bx - ax);
      ctx.lineWidth = 3 / z.s;
      ctx.strokeStyle = COLOR[role];
      ctx.setLineDash(b.seen ? [] : [8 / z.s, 6 / z.s]);
      ctx.strokeRect(x0, ay, w, by - ay);
      ctx.setLineDash([]);
      const label = b.seen ? m.name : `${m.name} (hidden?)`;
      ctx.font = `${13 / z.s}px system-ui, sans-serif`;
      const tw = ctx.measureText(label).width + 10 / z.s;
      ctx.fillStyle = COLOR[role];
      ctx.fillRect(x0, ay - 18 / z.s, tw, 18 / z.s);
      ctx.fillStyle = '#12091a';
      ctx.fillText(label, x0 + 5 / z.s, ay - 5 / z.s);
    }
  }

  function drawStrip() {
    const tr = D.tracks?.practice;
    const m = member();
    if (!tr || !m?.anchors.practice.length) { ui.strip.hidden = true; return; }
    ui.strip.hidden = false;
    const w = ui.strip.clientWidth || 600, h = 4;
    const dpr = window.devicePixelRatio || 1;
    ui.strip.width = Math.round(w * dpr);
    ui.strip.height = Math.round(h * dpr);
    const ctx = ui.strip.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const dur = P.duration || tr.length * D.prep.practice.step;
    const step = D.prep.practice.step;
    for (let i = 0; i < tr.length; i++) {
      const b = tr[i];
      if (!b) continue;
      ctx.fillStyle = b.seen ? 'rgba(255, 95, 162, 0.95)' : 'rgba(255, 255, 255, 0.25)';
      ctx.fillRect((i * step / dur) * w, 0, Math.max(1, (step / dur) * w + 0.5), h);
    }
  }

  hooks.tick.push(() => {
    if (els_hidden()) return;
    if (D.closeup) for (const role of roles) camera(role);
    for (const role of roles) drawPanel(role);
  });
  const els_hidden = () => document.getElementById('player').hidden;

  // ------------------------------------------------------------ controls

  function setStatus(html) { ui.status.innerHTML = html; }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function applyToggles() {
    ui.boxes.classList.toggle('active', D.showBoxes);
    ui.closeup.classList.toggle('active', D.closeup);
    ui.overlay.classList.toggle('active', D.overlay);
  }

  ui.find.addEventListener('click', findDancers);
  ui.cancel.addEventListener('click', () => { D.cancel = true; });
  ui.ignore.addEventListener('click', () => setIgnoreMode(!D.ignoreMode));
  ui.ignorePre.addEventListener('click', () => setIgnoreMode(!D.ignoreMode));
  ui.ignoreClear.addEventListener('click', () => {
    for (const role of roles) { D.ignore[role] = []; store(ignoreKey(role), []); }
    prepAll();
    retrack();
    toast('Ignore areas cleared.');
  });
  ui.boxes.addEventListener('click', () => { D.showBoxes = !D.showBoxes; applyToggles(); savePrefs(); });
  ui.closeup.addEventListener('click', () => setCloseup(!D.closeup));
  ui.zoom.addEventListener('input', () => { D.zoom = Number(ui.zoom.value); savePrefs(); });
  ui.overlay.addEventListener('click', () => setOverlay(!D.overlay));
  ui.opacity.addEventListener('input', () => { D.opacity = Number(ui.opacity.value); savePrefs(); });
  ui.scale.addEventListener('change', () => { D.scaleMode = ui.scale.value; savePrefs(); retrack(); });
  ui.select.addEventListener('change', () => { D.current = ui.select.value || null; saveMembers(); retrack(); renderMembers(); });
  ui.add.addEventListener('click', () => {
    const name = prompt('Name of the member to follow:', `Member ${D.members.length + 1}`);
    if (name === null) return;
    addMember(name.trim() || undefined);
    retrack();
  });
  ui.rename.addEventListener('click', () => {
    const m = member();
    if (!m) return;
    const name = prompt('Rename member:', m.name);
    if (name && name.trim()) { m.name = name.trim(); saveMembers(); renderMembers(); updateStatus(); }
  });
  ui.del.addEventListener('click', () => {
    const m = member();
    if (!m || !confirm(`Delete ${m.name}?`)) return;
    D.members = D.members.filter((x) => x !== m);
    D.current = D.members[0]?.id || null;
    saveMembers();
    renderMembers();
    retrack();
  });

  document.addEventListener('keydown', (e) => {
    if (els_hidden() || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target.tagName;
    if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && e.target.type !== 'range')) return;
    const k = e.key.toLowerCase();
    if (k === 'c' && D.prep.practice) { e.preventDefault(); setCloseup(!D.closeup); }
    else if (k === 'o' && D.prep.practice) { e.preventDefault(); setOverlay(!D.overlay); }
    else if (k === 'd' && D.prep.practice) { e.preventDefault(); D.showBoxes = !D.showBoxes; applyToggles(); savePrefs(); }
  });

  hooks.videosLoaded.push(onVideosLoaded);
  hooks.videosUnloaded.push(reset);
  let retrackTimer = 0;
  const soon = () => { clearTimeout(retrackTimer); retrackTimer = setTimeout(retrack, 150); };
  hooks.offsetChanged.push(() => { if (D.prep.practice) soon(); });
  hooks.mirrorChanged.push(() => { if (D.prep.practice) soon(); });
  window.addEventListener('resize', drawStrip);

  // for automated tests
  window.__dancers = D;
}
