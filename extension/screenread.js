/* Suggests a title for steps recorded from the whole screen.
   Chrome only gives screen recording pictures, not clicks, so Referensys compares each step with the one before,
   finds the part of the screen that changed, and reads the text there on this computer (nothing is sent anywhere).
   The biggest clear line of text, usually a heading, window or button name, becomes the title. */
(function () {
  'use strict';
  const GW = 160, GH = 90;
  const quote = s => '“' + s + '”';
  const looksPersonal = s => /\d{3,}|\d{1,2}\/\d{1,2}\/\d{2,4}|@|^[A-Z][A-Za-z'’-]+,\s*[A-Z]/.test(s);

  function grid(c) {
    const g = document.createElement('canvas'); g.width = GW; g.height = GH;
    const x = g.getContext('2d', { willReadFrequently: true });
    x.drawImage(c, 0, 0, GW, GH);
    const d = x.getImageData(0, 0, GW, GH).data, out = new Uint8Array(GW * GH);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10;
    return out;
  }
  // Every sizeable patch of change, joined into one area. Tiny ones (a ticking clock, a blinking cursor) don't count.
  function changed(prev, cur) {
    const a = grid(prev), b = grid(cur), on = new Uint8Array(GW * GH);
    for (let i = 0; i < on.length; i++) if (Math.abs(a[i] - b[i]) > 24) on[i] = 1;
    const fat = new Uint8Array(on.length); // join nearby bits of change into one area
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (on[y * GW + x])
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < GW && Y < GH) fat[Y * GW + X] = 1; }
    const seen = new Uint8Array(on.length);
    const parts = [];
    for (let i = 0; i < fat.length; i++) {
      if (!fat[i] || seen[i]) continue;
      let n = 0, x0 = GW, y0 = GH, x1 = 0, y1 = 0;
      const st = [i]; seen[i] = 1;
      while (st.length) {
        const k = st.pop(), x = k % GW, y = (k / GW) | 0;
        if (on[k]) { n++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
        for (const m of [k - 1, k + 1, k - GW, k + GW]) {
          if (m < 0 || m >= fat.length || seen[m] || !fat[m]) continue;
          if ((m === k - 1 && x === 0) || (m === k + 1 && x === GW - 1)) continue;
          seen[m] = 1; st.push(m);
        }
      }
      if (n) parts.push({ n, x0, y0, x1, y1 });
    }
    // Sizeable changes win; if there are none, the biggest small one (a ticked box, a switched option).
    const big = parts.filter(p => p.n >= GW * GH * 0.002);
    if (!big.length) { const small = parts.sort((a, b) => b.n - a.n)[0]; if (!small || small.n < 2) return null; parts.length = 0; parts.push(small); }
    else { parts.length = 0; parts.push(...big); }
    const best = parts.reduce((u, p) => ({ x0: Math.min(u.x0, p.x0), y0: Math.min(u.y0, p.y0), x1: Math.max(u.x1, p.x1), y1: Math.max(u.y1, p.y1) }));
    const sx = cur.width / GW, sy = cur.height / GH;
    return { x: Math.floor(best.x0 * sx), y: Math.floor(best.y0 * sy), w: Math.ceil((best.x1 - best.x0 + 1) * sx), h: Math.ceil((best.y1 - best.y0 + 1) * sy) };
  }

  let workerP = null, queue = Promise.resolve();
  function worker() {
    if (!workerP) {
      const base = chrome.runtime.getURL('lib/ocr/');
      workerP = Tesseract.createWorker('eng', 1, {
        workerPath: base + 'worker.min.js', corePath: base, langPath: base, workerBlobURL: false, gzip: true, cacheMethod: 'none'
      }).catch(e => { workerP = null; throw e; });
    }
    return workerP;
  }
  async function read(canvas) {
    const w = await worker();
    const r = await w.recognize(canvas, {}, { blocks: true, text: false });
    const lines = [];
    for (const b of r.data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) lines.push(l);
    return lines;
  }
  function clean(t) {
    return String(t || '').replace(/\s+/g, ' ').replace(/^[^A-Za-z0-9(]+|[^A-Za-z0-9)?!.]+$/g, '').replace(/[.:]+$/, '').trim();
  }
  const norm = t => clean(t).toLowerCase().replace(/[^a-z0-9]+/g, '');
  function pick(lines, scale, before) {
    let best = null;
    // Prefer text that wasn't there before: that's what the click opened.
    const fresh = lines.filter(l => !before.has(norm(l.text)));
    for (const l of (fresh.length ? fresh : lines)) {
      const t = clean(l.text), letters = (t.match(/[A-Za-z]/g) || []).length;
      if (l.confidence < 60 || t.length < 3 || t.length > 48 || letters < 3 || letters / t.length < 0.55 || looksPersonal(t)) continue;
      if (t.split(' ').length > 7) continue; // a sentence of body text, not a name
      const h = (l.bbox.y1 - l.bbox.y0) / scale, top = l.bbox.y0 / scale;
      const score = h * (l.confidence / 100) - top * 0.01;
      if (!best || score > best.score) best = { t, score };
    }
    return best && best.t;
  }

  async function describe(prev, cur) {
    const W = cur.width, H = cur.height;
    let box = prev && prev.width === W && prev.height === H ? changed(prev, cur) : null;
    if (box && box.w * box.h > W * H * 0.9) box = null; // the whole screen changed: no one area to point at
    // Read the changed area, or the top of the screen for the first step (window and page titles live there).
    const small = box && box.w * box.h < W * H * 0.01;
    // For a small change, also read beside it, where a box's or button's label usually is.
    const padX = small ? Math.round(W * 0.15) : 8, padY = small ? Math.round(H * 0.02) : 8;
    const area = box ? { x: Math.max(0, box.x - padX), y: Math.max(0, box.y - padY), w: Math.min(W, box.w + 2 * padX), h: Math.min(H, box.h + 2 * padY) }
      : { x: 0, y: 0, w: W, h: Math.round(H * 0.4) };
    area.w = Math.min(area.w, W - area.x); area.h = Math.min(area.h, H - area.y);
    const scale = area.w < 900 ? 2 : area.w > 2000 ? 2000 / area.w : 1;
    const crop = src => {
      const c = document.createElement('canvas');
      c.width = Math.round(area.w * scale); c.height = Math.round(area.h * scale);
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
      x.drawImage(src, area.x, area.y, area.w, area.h, 0, 0, c.width, c.height);
      return c;
    };
    const job = (queue = queue.catch(() => {}).then(async () => {
      const now = await read(crop(cur));
      const before = box ? new Set((await read(crop(prev))).map(l => norm(l.text))) : new Set();
      return pick(now, scale, before);
    }));
    const limit = new Promise((_, no) => setTimeout(() => no(new Error('timed out')), 60000));
    let name = null;
    try { name = await Promise.race([job, limit]); } catch (e) { console.warn('Couldn’t read the screen', e); }
    const hl = box ? { x: Math.max(0, box.x - 6), y: Math.max(0, box.y - 6), w: Math.min(W, box.w + 12), h: Math.min(H, box.h + 12) } : null;
    if (!prev) return name ? { title: `Start on ${quote(name)}`, text: `Start on the ${quote(name)} screen.` } : null;
    if (small) return name ? { title: `Click ${quote(name)}`, text: `Click ${quote(name)}, highlighted on the screen.`, box: hl }
      : { title: 'Click the highlighted item', text: 'Click the item highlighted on the screen.', box: hl };
    if (name) return { title: `Open ${quote(name)}`, text: hl ? `Open ${quote(name)}. The highlighted area shows what changes on the screen.` : `Open ${quote(name)}.`, box: hl };
    return hl ? { title: 'Go to the next screen', text: 'The highlighted area shows what changes on the screen.', box: hl } : null;
  }

  window.ReferensysScreenRead = { describe };
})();
