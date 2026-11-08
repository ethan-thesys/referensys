/* Referensys: runs in the tab being recorded. Notices clicks, works out what was clicked
   (for the step title), and shows a small floating bar with Pause and Done.
   Nothing here runs unless you started recording this tab. */
(() => {
  if (window.__referensysRec) { window.__referensysRec.sync(); return; }

  // ---------- floating bar ----------
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:50%;bottom:18px;transform:translateX(-50%)';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .bar{display:flex;align-items:center;gap:8px;padding:7px 8px 7px 14px;border-radius:999px;background:#10181c;color:#e8f0f4;
      font:500 13px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.08);user-select:none}
    .dot{width:10px;height:10px;border-radius:50%;background:#f2711c;box-shadow:0 0 0 4px rgba(242,113,28,.25);animation:p 1.4s infinite}
    .paused .dot{background:#6b7a86;box-shadow:none;animation:none}
    @keyframes p{50%{box-shadow:0 0 0 7px rgba(242,113,28,0)}}
    b{font-weight:700}.n{color:#9fb3be;min-width:58px}
    button{all:unset;cursor:pointer;padding:7px 13px;border-radius:999px;background:#24323a;color:#e8f0f4;font:600 13px system-ui,-apple-system,"Segoe UI",sans-serif}
    button:hover{background:#2e3f49}button:focus-visible{outline:2px solid #34b3a7;outline-offset:2px}
    .done{background:#34b3a7;color:#031d1b}.done:hover{background:#45c4b8}
    .mv{padding:7px 9px;color:#9fb3be;background:transparent}.mv:hover{background:#24323a}
  </style><div class="bar" role="toolbar" aria-label="Referensys recording">
    <span class="dot" aria-hidden="true"></span><b id="l">Recording</b><span class="n" id="n">0 steps</span>
    <button id="p">Pause</button><button id="d" class="done">Done</button><button id="m" class="mv" title="Move this bar" aria-label="Move this bar">⇅</button></div>`;
  const $ = s => root.getElementById(s);
  let paused = false, n = 0, top = false;
  function show() {
    root.querySelector('.bar').classList.toggle('paused', paused);
    $('l').textContent = paused ? 'Paused' : 'Recording';
    $('n').textContent = n + (n === 1 ? ' step' : ' steps');
    $('p').textContent = paused ? 'Resume' : 'Pause';
  }
  const send = m => new Promise(res => { try { chrome.runtime.sendMessage(m, r => { void chrome.runtime.lastError; res(r || {}); }); } catch (e) { res({}); } });
  $('p').onclick = async () => { const r = await send({ type: 'pause' }); if ('paused' in r) { paused = r.paused; n = r.n; show(); } };
  $('d').onclick = () => { $('d').textContent = 'Finishing…'; send({ type: 'done' }); };
  $('m').onclick = () => { top = !top; host.style.top = top ? '14px' : ''; host.style.bottom = top ? '' : '18px'; };
  document.documentElement.appendChild(host);
  show();

  // ---------- what was clicked ----------
  const INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],' +
    '[role=option],[role=checkbox],[role=radio],[role=switch],[role=treeitem],[role=row],[role=gridcell],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],li,[onclick],[tabindex]';
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const short = s => { s = clean(s); return s.length > 60 ? s.slice(0, 60).trim() : s; };
  function firstLine(el) {
    const t = (el.innerText || el.textContent || '').split('\n').map(clean).filter(Boolean);
    return t[0] || '';
  }
  function labelOf(el) {
    const a = el.getAttribute('aria-label'); if (clean(a)) return short(a);
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(x => x.innerText || x.textContent).join(' '); if (clean(t)) return short(t); }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      if (el.labels && el.labels[0]) { const c = el.labels[0].cloneNode(true); c.querySelectorAll('select,input,textarea,option,button').forEach(x => x.remove()); if (clean(c.textContent)) return short(c.textContent); }
      if (/^(submit|button|reset)$/i.test(el.type) && clean(el.value)) return short(el.value);
      if (clean(el.placeholder)) return short(el.placeholder);
      if (clean(el.title)) return short(el.title);
      return '';
    }
    const t = firstLine(el); if (t) return short(t);
    const img = el.querySelector && el.querySelector('img[alt],svg[aria-label]');
    if (img) return short(img.getAttribute('alt') || img.getAttribute('aria-label'));
    return short(el.title || '');
  }
  function roleOf(el) {
    const r = (el.getAttribute('role') || '').toLowerCase(), tag = el.tagName, type = (el.type || '').toLowerCase();
    if (type === 'checkbox' || /^(checkbox|switch|menuitemcheckbox)$/.test(r)) return 'CheckBox';
    if (type === 'radio' || /^(radio|menuitemradio)$/.test(r)) return 'RadioButton';
    if (tag === 'SELECT' || r === 'combobox' || r === 'listbox') return 'ComboBox';
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(submit|button|reset|image|file|color|range)$/.test(type)) || el.isContentEditable || /^(textbox|searchbox)$/.test(r)) return 'Edit';
    if (r === 'tab') return 'TabItem';
    if (r === 'menuitem') return 'MenuItem';
    if (/^(option|row|gridcell|treeitem)$/.test(r) || tag === 'LI' || tag === 'TR' || tag === 'TD') return 'ListItem';
    if ((tag === 'A' && el.hasAttribute('href')) || r === 'link') return 'Hyperlink';
    if (tag === 'BUTTON' || tag === 'SUMMARY' || r === 'button' || (tag === 'INPUT' && /^(submit|button|reset|image)$/.test(type))) return 'Button';
    return '';
  }
  function siteName() {
    const og = document.querySelector('meta[property="og:site_name"]');
    if (og && clean(og.content) && clean(og.content).length <= 30) return clean(og.content);
    const parts = clean(document.title).split(/\s[-|–—·]\s/).map(clean).filter(Boolean);
    const last = parts.length > 1 ? parts[parts.length - 1] : '';
    if (last && last.length <= 25 && !/@|\d{3,}/.test(last)) return last;
    return location.hostname.replace(/^www\./, '');
  }

  function onDown(e) {
    if (!e.isTrusted || e.button !== 0 || paused) return;
    const path = e.composedPath();
    if (path.includes(host)) return;
    const start = path.find(x => x instanceof Element) || e.target;
    if (!(start instanceof Element)) return;
    const el = start.closest(INTERACTIVE) || start;
    const info = { type: 'click', x: e.clientX, y: e.clientY, vw: window.innerWidth, label: labelOf(el), role: roleOf(el), app: siteName() };
    host.style.visibility = 'hidden'; // keep the bar out of the screenshot
    send(info).then(r => {
      host.style.visibility = '';
      if (typeof r.n === 'number') { n = r.n; show(); }
    });
  }
  addEventListener('pointerdown', onDown, true);

  function stop() { removeEventListener('pointerdown', onDown, true); host.remove(); delete window.__referensysRec; }
  async function sync() {
    const r = await send({ type: 'state' });
    if (!r.rec || !r.rec.mine) { stop(); return; }
    n = r.rec.n; paused = r.rec.paused; show();
  }
  chrome.runtime.onMessage.addListener(m => {
    if (m && m.type === 'stop') stop();
    if (m && m.type === 'count') { n = m.n; show(); }
  });
  window.__referensysRec = { sync };
  sync();
})();
