/* The menu that opens from Referensys's icon in Chrome's toolbar. */
(async function () {
  'use strict';
  const $ = s => document.getElementById(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const send = m => chrome.runtime.sendMessage(m).catch(e => ({ error: e.message || String(e) }));
  const open = (query, reuse) => send({ type: 'openEditor', query, reuse }).then(() => window.close());

  /* ---------- recording in progress ---------- */
  async function showState() {
    const r = await send({ type: 'state' });
    const live = r && r.rec;
    $('recNow').hidden = !live; $('start').hidden = !!live;
    if (!live) return;
    $('liveL').textContent = live.paused ? 'Paused' : 'Recording a tab';
    $('liveN').textContent = live.n + (live.n === 1 ? ' step so far' : ' steps so far');
    $('livePause').textContent = live.paused ? 'Resume' : 'Pause';
    document.querySelector('.live').classList.toggle('paused', live.paused);
    $('liveGo').onclick = async () => { const t = await chrome.tabs.get(live.tabId); await chrome.tabs.update(t.id, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); window.close(); };
  }
  $('livePause').onclick = async () => { await send({ type: 'pause' }); showState(); };
  $('liveDone').onclick = async () => { $('liveDone').textContent = 'Finishing…'; await send({ type: 'done' }); window.close(); };
  showState();

  /* ---------- start recording ---------- */
  $('pTab').onclick = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let screenText = true; try { screenText = localStorage.getItem('sop.screenText') !== '0'; } catch (e) {}
    const r = tab ? await send({ type: 'startTab', tabId: tab.id, from: null, screenText }) : { error: 'No tab is open.' };
    if (r && r.error) { $('tabNote').textContent = r.error; $('tabNote').hidden = false; return; }
    window.close();
  };
  $('pScreen').onclick = () => open('screen=1', false);
  $('pLib').onclick = () => open('lib=1', true);

  /* ---------- find an SOP ---------- */
  const auth = window.ReferensysExtAuth;
  const drive = window.ReferensysCore.makeDrive({ auth, openUrl: url => chrome.tabs.create({ url }) });
  const acct = await drive.accounts();
  if (acct.active) { $('acct').textContent = acct.active; $('acct').classList.add('on'); $('acct').title = 'Saving to the Google Drive of ' + acct.active; }
  else { $('acct').textContent = 'Not signed in'; }

  const stem = t => { t = t.toLowerCase(); return t.length > 4 ? t.replace(/(ing|ed|al|es|e|s)$/, '') : t; };
  const toks = q => q.toLowerCase().split(/\s+/).filter(Boolean).map(stem);
  function search(list, q) {
    const ts = toks(q);
    if (!ts.length) return list.map(s => ({ s, hit: null }));
    return list.map(s => {
      const hay = [s.name, s.dept, s.purpose].join(' ').toLowerCase();
      const steps = (s.steps || []).map(x => String(x).toLowerCase());
      const all = hay + ' ' + steps.join(' ');
      if (!ts.every(t => all.includes(t))) return null;
      let hit = null;
      if (!ts.every(t => hay.includes(t))) { const i = steps.findIndex(x => ts.some(t => x.includes(t))); if (i >= 0) hit = { n: i + 1, text: s.steps[i] }; }
      return { s, hit, score: ts.filter(t => (s.name || '').toLowerCase().includes(t)).length };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
  }
  function mark(text, q) {
    let h = esc(text);
    toks(q).forEach(t => { h = h.replace(new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>'); });
    return h;
  }
  const when = d => { const t = new Date(d); if (isNaN(t)) return ''; const days = Math.floor((Date.now() - t) / 864e5); return days < 1 ? 'Today' : days < 2 ? 'Yesterday' : days < 7 ? days + ' days ago' : t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };

  let list = null;
  function render() {
    const q = $('pQ').value.trim();
    if (!acct.active) {
      $('pRes').innerHTML = auth.ready ? '<div class="msg">Sign in with Google to see the SOPs saved in your Drive.</div><button class="btn primary" id="pSign">Sign in with Google</button>'
        : '<div class="msg">Saving to Google Drive isn’t set up in this copy yet.</div>';
      if ($('pSign')) $('pSign').onclick = () => open('signin=1', true);
      $('pQ').disabled = true; $('pLib').hidden = true;
      return;
    }
    if (!list) { $('pRes').innerHTML = '<div class="msg">Loading your SOPs…</div>'; return; }
    if (list.error) { $('pRes').innerHTML = `<div class="msg">${esc(list.error)}</div>`; return; }
    const r = search(list, q).slice(0, 4);
    $('pRes').innerHTML = r.length ? r.map(({ s, hit }) => `<button class="row" data-id="${esc(s.id)}" data-name="${esc(s.name)}"><b>${mark(s.name, q)}</b><span class="d">${esc(when(s.updated))}</span>${hit ? `<small>Step ${hit.n}: ${mark(hit.text, q)}</small>` : s.dept ? `<small>${esc(s.dept)}</small>` : ''}</button>`).join('')
      : `<div class="msg">${list.length ? 'No SOPs match.' : 'No SOPs yet. Record one above.'}</div>`;
    $('pRes').querySelectorAll('[data-id]').forEach(b => b.onclick = () => open('open=' + encodeURIComponent(b.dataset.id) + '&name=' + encodeURIComponent(b.dataset.name), true));
    $('pLib').textContent = `Open the library (${list.length} SOP${list.length === 1 ? '' : 's'})`;
  }
  $('pQ').oninput = render;
  render();
  if (acct.active) {
    const r = await drive.list();
    list = r.error ? { error: r.code === 'reauth' ? 'Sign in again from the library to see your SOPs.' : r.error } : r.sops;
    render();
  }
})();
