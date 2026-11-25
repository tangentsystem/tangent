// The scene behind every view: the network's real nodes as small cubes joined by thin lines,
// you on one side and the open web on the other. When the private internet is on, your three
// hops light up as one path. Motion is slow on purpose: a gentle sway, nothing that flickers.
(function () {
  'use strict';
  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d');
  const ACC = [61, 92, 255];
  const FG = [243, 242, 238];
  // where the scene sits in each view: a box (fractions of the window) it is fitted into
  const VIEWS = {
    internet: { x0: 0.5, x1: 1.0, cy: 0.4, h: 0.5, dim: 1, labels: 'path', stage: true },
    computers: { x0: 0.6, x1: 1.0, cy: 0.22, h: 0.24, dim: 0.4, labels: 'none', stage: true },
    wallet: { x0: 0.6, x1: 1.0, cy: 0.22, h: 0.24, dim: 0.4, labels: 'none', stage: true },
    network: { x0: 0.02, x1: 0.52, cy: 0.46, h: 0.58, dim: 1, labels: 'all', stage: false },
  };
  const S = {
    nodes: [], byId: new Map(), edges: [], path: null, pathAt: 0, view: 'internet',
    ox: 0, oy: 0, f: 0, dim: 1, labelsAlpha: 1, labelMode: 'path', fitted: false,
    W: 0, H: 0, dpr: 1, t0: performance.now(), last: 0, pathAlpha: 0,
  };
  const YOU = { id: 'you', p: [-2.15, 0.05, 0.3] };
  const WEB = { id: 'web', p: [2.2, -0.05, -0.2] };

  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let s = seed | 0; return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const short = (id) => id.length > 10 ? id.slice(0, 4) + '…' + id.slice(-4) : id;
  const lerp = (a, b, k) => a + (b - a) * k;
  const ease = (x) => x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x);
  const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  function layout(list) {
    const sorted = [...list].sort((a, b) => hash(a.id) - hash(b.id));
    const n = sorted.length;
    const out = sorted.map((d, i) => {
      const r = rng(hash(d.id));
      const a = i * 2.39996 + r() * 0.5;
      const x = n === 1 ? 0 : -1.3 + 2.6 * (i + 0.5) / n + (r() - 0.5) * 0.3;
      const p0 = [x, Math.sin(a) * 0.78 + (r() - 0.5) * 0.2, Math.cos(a) * 0.9];
      return { id: d.id, roles: d.roles || [], p0, p: p0.slice(), spin: r() * Math.PI * 2, size: 0.15 + r() * 0.03, glow: 0 };
    });
    return out.sort((a, b) => a.p[0] - b.p[0]);
  }

  function linkUp(nodes) {
    const edges = []; const keys = new Set();
    const add = (a, b, w = 1) => { const k = a.id < b.id ? a.id + b.id : b.id + a.id; if (a === b || keys.has(k)) return; keys.add(k); edges.push({ a, b, w }); };
    for (const n of nodes) {
      const near = nodes.filter((m) => m !== n).sort((x, y) => dist2(n.p, x.p) - dist2(n.p, y.p));
      near.slice(0, 2).forEach((m) => add(n, m));
    }
    const byX = [...nodes].sort((a, b) => a.p[0] - b.p[0]);
    byX.slice(0, 2).forEach((m) => add(YOU, m, 0.6));
    const exits = nodes.filter((m) => m.roles.includes('exit'));
    (exits.length ? exits : byX.slice(-1)).forEach((m) => add(m, WEB, 0.6));
    return edges;
  }

  function resize() {
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    S.W = window.innerWidth; S.H = window.innerHeight;
    canvas.width = Math.round(S.W * S.dpr); canvas.height = Math.round(S.H * S.dpr);
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  }

  // camera: a slow sway around the middle of the network
  function camera(t, still = false) {
    const yaw = -0.3 + (still ? 0 : Math.sin(t * 0.045) * 0.14);
    const pitch = 0.2 + (still ? 0 : Math.sin(t * 0.031 + 1.3) * 0.04);
    return { cy: Math.cos(yaw), sy: Math.sin(yaw), cp: Math.cos(pitch), sp: Math.sin(pitch), D: 7.2 };
  }
  function toCam(c, p) {
    const x = p[0] * c.cy - p[2] * c.sy;
    const z0 = p[0] * c.sy + p[2] * c.cy;
    const y = p[1] * c.cp - z0 * c.sp;
    const z = p[1] * c.sp + z0 * c.cp;
    return [x, y, z];
  }
  function project(c, q) {
    const d = c.D + q[2];
    return [S.ox + q[0] * S.f / d, S.oy - q[1] * S.f / d, d];
  }

  // fit the whole scene (you, the nodes, the open web and their labels) into the view's box,
  // measured with the camera at rest so the sway never changes the zoom
  function fit(V) {
    const c = camera(0, true);
    const pts = [YOU.p, WEB.p, ...S.nodes.map((n) => n.target || n.p)];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { const q = toCam(c, p); const d = c.D + q[2]; const x = q[0] / d, y = q[1] / d; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const left = S.W * V.x0 + 64, right = S.W * V.x1 - 132; // room for the "You" and "Open web" labels
    const fx = (right - left) / Math.max(0.01, x1 - x0);
    const fy = (S.H * V.h) / Math.max(0.01, y1 - y0);
    const f = Math.min(fx, fy);
    const ox = (left + right) / 2 - ((x0 + x1) / 2) * f;
    const oy = S.H * V.cy + ((y0 + y1) / 2) * f;
    return { f, ox, oy };
  }

  const CUBE_V = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  const CUBE_F = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
  const LIGHT = (() => { const v = [-0.45, 0.7, -0.55]; const l = Math.hypot(...v); return v.map((x) => x / l); })();

  function drawCube(c, n, t, k) {
    const s = n.size * (1 + 0.15 * n.glow) * Math.max(0.75, Math.min(1.3, S.f / 760));
    const ry = n.spin + t * 0.05, rx = 0.55;
    const cry = Math.cos(ry), sry = Math.sin(ry), crx = Math.cos(rx), srx = Math.sin(rx);
    const world = CUBE_V.map(([x, y, z]) => {
      x *= s; y *= s; z *= s;
      const x1 = x * cry + z * sry, z1 = -x * sry + z * cry;
      const y1 = y * crx - z1 * srx, z2 = y * srx + z1 * crx;
      return [n.p[0] + x1, n.p[1] + y1, n.p[2] + z2];
    });
    const cam = world.map((p) => toCam(c, p));
    const scr = cam.map((q) => project(c, q));
    const faces = [];
    for (const f of CUBE_F) {
      const a = cam[f[0]], b = cam[f[1]], d = cam[f[3]];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(...nrm) || 1;
      const nz = nrm[2] / len;
      if (nz > 0) continue; // faces away
      const lum = Math.max(0, -(nrm[0] * LIGHT[0] + nrm[1] * LIGHT[1] + nrm[2] * LIGHT[2]) / len);
      faces.push({ f, lum, z: (cam[f[0]][2] + cam[f[2]][2]) / 2 });
    }
    faces.sort((x, y) => y.z - x.z);
    const g = n.glow;
    for (const { f, lum } of faces) {
      ctx.beginPath();
      f.forEach((i, j) => (j ? ctx.lineTo(scr[i][0], scr[i][1]) : ctx.moveTo(scr[i][0], scr[i][1])));
      ctx.closePath();
      const base = 20 + lum * 46;
      const r = lerp(base, ACC[0] * (0.42 + lum * 0.6), g), gg = lerp(base, ACC[1] * (0.42 + lum * 0.6), g), b = lerp(base, Math.min(255, ACC[2] * (0.42 + lum * 0.6)), g);
      ctx.fillStyle = `rgba(${r | 0},${gg | 0},${b | 0},${(0.92 * k).toFixed(3)})`;
      ctx.fill();
      ctx.strokeStyle = g > 0.05 ? `rgba(${lerp(243, 170, g) | 0},${lerp(242, 186, g) | 0},${lerp(238, 255, g) | 0},${(0.62 + 0.3 * g) * k})` : `rgba(243,242,238,${0.42 * k})`;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    const ctr = project(c, toCam(c, n.p));
    return ctr;
  }

  function drawWeb(c, k, lit) {
    const q = project(c, toCam(c, WEB.p));
    const r = Math.max(9, Math.min(17, S.f * 0.0034 * (7.2 / q[2])));
    const col = lit > 0.01 ? `rgba(${lerp(243, 120, lit) | 0},${lerp(242, 140, lit) | 0},${lerp(238, 255, lit) | 0},${0.85 * k})` : `rgba(243,242,238,${0.6 * k})`;
    ctx.strokeStyle = col; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(q[0], q[1] + r * 0.5, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(q[0] - r * 1.15, q[1] - r * 0.5); ctx.lineTo(q[0] + r * 1.75, q[1] - r * 0.5); ctx.stroke();
    return [q[0], q[1] + r * 0.5, q[2]];
  }

  function drawYou(c, k, t) {
    return drawCube(c, { id: 'you', p: YOU.p, spin: 0.7, size: 0.11, glow: 0 }, t, k);
  }

  // a label below or above a point, joined to it by a short line
  function tag(x, y, text, sub, alpha, up) {
    if (alpha < 0.02) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    const d = up ? -1 : 1;
    const y0 = y + d * 24, y1 = y + d * 36;
    ctx.strokeStyle = 'rgba(243,242,238,.38)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = up ? 'bottom' : 'top';
    const ty = y1 + d * 6;
    ctx.font = '500 12.5px Inter, system-ui, sans-serif'; ctx.fillStyle = 'rgba(243,242,238,.92)';
    if (up && sub) { ctx.fillText(text, x, ty - 16); ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'; ctx.fillStyle = 'rgba(243,242,238,.5)'; ctx.fillText(sub, x, ty); }
    else { ctx.fillText(text, x, ty); if (sub) { ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'; ctx.fillStyle = 'rgba(243,242,238,.5)'; ctx.fillText(sub, x, ty + 17); } }
    ctx.restore();
  }

  function label(x, y, text, sub, alpha, side = 1) {
    if (alpha < 0.02) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '500 12.5px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const lx = x + side * 18;
    ctx.strokeStyle = 'rgba(243,242,238,.4)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + side * 4, y); ctx.lineTo(lx + side * 12, y); ctx.stroke();
    ctx.fillStyle = 'rgba(243,242,238,.92)';
    ctx.textAlign = side > 0 ? 'left' : 'right';
    ctx.fillText(text, lx + side * 18, y - (sub ? 8 : 0));
    if (sub) { ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'; ctx.fillStyle = 'rgba(243,242,238,.5)'; ctx.fillText(sub, lx + side * 18, y + 9); }
    ctx.restore();
  }

  const HOP_NAMES = ['First hop', 'Second hop', 'Last hop'];
  const STAGE = [[-1.15, -0.3, 0.2], [0, 0.42, -0.25], [1.15, -0.2, 0.1]];

  function frame(now) {
    requestAnimationFrame(frame);
    if (now - S.last < 30) return; // about 30 frames a second is plenty for slow motion
    const dt = Math.min(0.1, (now - (S.last || now)) / 1000);
    S.last = now;
    const t = (now - S.t0) / 1000;
    const V = VIEWS[S.view] || VIEWS.internet;
    const k = 1 - Math.exp(-dt * 1.6);
    // your hops step forward into one clean line from you to the open web; the rest step back
    const hopAt = new Map((S.path || []).map((id, i) => [id, i]));
    for (const n of S.nodes) {
      const i = hopAt.get(n.id);
      const staged = V.stage && S.path;
      n.target = !staged ? n.p0 : i === undefined ? [n.p0[0] * 0.9, n.p0[1] * 0.5 + 0.75, n.p0[2] * 0.6 + 1.1]
        : (STAGE[i] || [0, 0, 0]);
      const kk = 1 - Math.exp(-dt * 0.9);
      for (let j = 0; j < 3; j++) n.p[j] = lerp(n.p[j], n.target[j], kk);
    }
    const goal = fit(V);
    if (!S.fitted) { S.f = goal.f; S.ox = goal.ox; S.oy = goal.oy; S.fitted = true; }
    S.f = lerp(S.f, goal.f, k); S.ox = lerp(S.ox, goal.ox, k); S.oy = lerp(S.oy, goal.oy, k); S.dim = lerp(S.dim, V.dim, k);
    S.pathAlpha = lerp(S.pathAlpha, S.path ? 1 : 0, 1 - Math.exp(-dt * 2.2));
    if (S.labelMode !== V.labels) { S.labelsAlpha = Math.max(0, S.labelsAlpha - dt * 3); if (S.labelsAlpha === 0) S.labelMode = V.labels; } else S.labelsAlpha = Math.min(1, S.labelsAlpha + dt * 1.5);

    ctx.clearRect(0, 0, S.W, S.H);
    const c = camera(t);
    const a = S.dim;
    const hopIdx = new Map((S.path || []).map((id, i) => [id, i]));
    for (const n of S.nodes) n.glow = lerp(n.glow, hopIdx.has(n.id) ? S.pathAlpha : 0, 1 - Math.exp(-dt * 2.5));

    // lines of the network
    const P = (p) => project(c, toCam(c, p));
    for (const e of S.edges) {
      const p1 = P(e.a.p), p2 = P(e.b.p);
      ctx.strokeStyle = `rgba(243,242,238,${(0.15 * e.w * a).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
    }

    // your path, drawn in as it comes on
    let pts = null;
    if (S.path && S.path.every((id) => S.byId.has(id))) pts = [YOU.p, ...S.path.map((id) => S.byId.get(id).p), WEB.p].map(P);
    else if (S.lastPts) pts = S.lastPts;
    if (pts && S.pathAlpha > 0.01) {
      S.lastPts = pts;
      const grow = ease((now - S.pathAt) / 1600);
      const segs = pts.length - 1;
      const upto = S.path ? grow * segs : segs;
      ctx.lineCap = 'round';
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? `rgba(61,92,255,${0.16 * S.pathAlpha * a})` : `rgba(110,135,255,${0.95 * S.pathAlpha * a})`;
        ctx.lineWidth = pass === 0 ? 6 : 1.6;
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i <= segs; i++) {
          const f = Math.min(1, Math.max(0, upto - (i - 1)));
          if (f <= 0) break;
          ctx.lineTo(lerp(pts[i - 1][0], pts[i][0], f), lerp(pts[i - 1][1], pts[i][1], f));
        }
        ctx.stroke();
      }
      // one soft light travels the path, slowly
      if (S.path && grow >= 1) {
        const lens = []; let total = 0;
        for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); lens.push(l); total += l; }
        let d = ((t * 70) % (total + 260)) - 60;
        if (d > 0 && d < total) {
          let i = 0; while (i < lens.length - 1 && d > lens[i]) { d -= lens[i]; i++; }
          const f = d / lens[i];
          const x = lerp(pts[i][0], pts[i + 1][0], f), y = lerp(pts[i][1], pts[i + 1][1], f);
          const gr = ctx.createRadialGradient(x, y, 0, x, y, 16);
          gr.addColorStop(0, `rgba(170,186,255,${0.85 * a})`); gr.addColorStop(0.25, `rgba(110,135,255,${0.35 * a})`); gr.addColorStop(1, 'rgba(61,92,255,0)');
          ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // cubes, far ones first
    const items = S.nodes.map((n) => ({ n, z: toCam(c, n.p)[2] })).sort((x, y) => y.z - x.z);
    const centers = new Map();
    for (const { n } of items) centers.set(n.id, drawCube(c, n, t, a));
    const you = drawYou(c, a, t);
    const web = drawWeb(c, a, S.pathAlpha);

    // labels
    const la = S.labelsAlpha * a;
    if (S.labelMode !== 'none') {
      label(you[0] - 6, you[1], 'You', null, la * 0.95, -1);
      label(web[0] + 26, web[1], 'Open web', null, la * 0.95, 1);
    }
    if (S.labelMode === 'path' && S.path) {
      S.path.forEach((id, i) => { const p = centers.get(id); if (p) tag(p[0], p[1], HOP_NAMES[i] || 'Hop', short(id), la * S.pathAlpha, i === 1); });
    } else if (S.labelMode === 'all') {
      const ys = S.nodes.map((n) => centers.get(n.id)).filter(Boolean);
      const mid = ys.reduce((a, p) => a + p[1], 0) / Math.max(1, ys.length);
      for (const n of S.nodes) { const p = centers.get(n.id); if (p) tag(p[0], p[1], short(n.id), n.roleText || null, la, p[1] < mid); }
    }
  }

  window.Scene = {
    setNodes(list) {
      const prevPath = S.path;
      const keep = new Map(S.nodes.map((n) => [n.id, n]));
      S.nodes = layout(list || []).map((n) => { const old = keep.get(n.id); if (old) { n.glow = old.glow; n.p = old.p; } n.roleText = (list.find((d) => d.id === n.id) || {}).roleText || null; return n; });
      S.byId = new Map(S.nodes.map((n) => [n.id, n]));
      S.edges = linkUp(S.nodes);
      S.path = prevPath;
    },
    setPath(ids) {
      const next = Array.isArray(ids) && ids.length ? ids.slice() : null;
      const same = (S.path || []).join() === (next || []).join();
      if (same) return;
      if (next && !S.path) S.pathAt = performance.now();
      S.path = next;
      if (!next) S.lastPts = S.lastPts || null;
    },
    setView(v) { if (VIEWS[v]) S.view = v; },
  };

  window.addEventListener('resize', () => { resize(); S.fitted = false; });
  resize();
  requestAnimationFrame(frame);
})();
