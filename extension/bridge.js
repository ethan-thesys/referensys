/* Referensys extension: connects the shared editor (index.html, built as editor.html) to Chrome.
   Provides the same window.sop interface as the Windows and Android apps, so the editor code is shared. */
(function () {
  'use strict';
  const { words, pdfApi, makeDrive, newer } = window.ReferensysCore;
  const auth = window.ReferensysExtAuth;
  const noop = () => {};
  const manifest = chrome.runtime.getManifest();
  const STORE = !!manifest.update_url; // installed from the Chrome Web Store (updates itself)
  const send = m => chrome.runtime.sendMessage(m).catch(e => ({ error: e.message || String(e) }));

  const drive = makeDrive({ auth, openUrl: url => chrome.tabs.create({ url }) });

  /* ---------- which tab this editor is ---------- */
  let myTab = null;
  const tabReady = new Promise(res => chrome.tabs.getCurrent(t => { myTab = t ? t.id : null; res(myTab); }));

  /* ---------- recorded steps arriving from the background worker ---------- */
  let stepsCb = null, captureCb = noop, navCb = noop;
  const waiting = [];
  async function deliver(key) {
    const list = await kv.get('pending:' + key).catch(() => null);
    if (!list) return;
    kv.del('pending:' + key).catch(noop);
    list.forEach(s => { s.title = words.click.title(s); s.text = words.click.text(s); });
    if (stepsCb) stepsCb(list); else waiting.push(list);
  }
  chrome.runtime.onMessage.addListener(m => {
    if (!m || m.to === undefined) return;
    if (m.to !== 'all' && m.to !== myTab) return;
    if (m.type === 'recorded') deliver(m.key);
    if (m.type === 'captureNow') captureCb();
    if (m.type === 'nav') navCb(new URLSearchParams(m.query));
  });
  const params = new URLSearchParams(location.search);
  if (params.get('rec')) deliver(params.get('rec'));
  if ([...params.keys()].length) history.replaceState(null, '', location.pathname); // a reload shouldn't repeat the action

  async function tabs() {
    await tabReady;
    const all = await chrome.tabs.query({});
    return all.filter(t => /^(https?|file):/.test(t.url || '') && t.id !== myTab)
      .map(t => ({ id: t.id, title: t.title || t.url, url: t.url, icon: t.favIconUrl || '', active: t.active, windowId: t.windowId }));
  }

  /* ---------- updates ---------- */
  const REPO = 'ethan-thesys/referensys';
  let upd = { state: 'idle', version: null, percent: 0, error: null, checkedAt: null, url: null };
  let onStatus = noop, onReady = noop;
  const sendUpd = p => { upd = { ...upd, ...p }; onStatus(upd); if (p.state === 'ready') onReady(upd.version); };
  async function checkUpdates() {
    if (['checking', 'ready'].includes(upd.state)) return upd;
    sendUpd({ state: 'checking', error: null });
    try {
      if (STORE) {
        const r = await chrome.runtime.requestUpdateCheck();
        const st = r.status || r;
        if (st === 'update_available') sendUpd({ state: 'ready', version: r.version || (r.details && r.details.version) || '', checkedAt: Date.now() });
        else sendUpd({ state: st === 'throttled' ? 'error' : 'latest', error: st === 'throttled' ? 'Chrome limits how often this can be checked. Try again in a few minutes.' : null, checkedAt: Date.now() });
        return upd;
      }
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('github ' + r.status);
      const rel = await r.json(), v = String(rel.tag_name || '').replace(/^v/, '');
      const zip = (rel.assets || []).find(a => /extension.*\.zip$/i.test(a.name));
      if (!zip || !newer(v, manifest.version)) sendUpd({ state: 'latest', checkedAt: Date.now() });
      else sendUpd({ state: 'ready', version: v, url: zip.browser_download_url, checkedAt: Date.now() });
    } catch (e) {
      sendUpd({ state: 'error', error: navigator.onLine === false ? 'You’re offline. Check your connection.' : 'The update check didn’t finish. Try again in a minute.', checkedAt: Date.now() });
    }
    return upd;
  }
  if (STORE) chrome.runtime.onUpdateAvailable.addListener(d => sendUpd({ state: 'ready', version: d.version, checkedAt: Date.now() }));
  async function installUpdate() {
    if (STORE) { chrome.runtime.reload(); return; }
    // Copies loaded with "Load unpacked" can't replace their own files, so walk the person through it.
    if (upd.url) chrome.tabs.create({ url: upd.url, active: false });
    if (typeof info === 'function') info('Install version ' + upd.version,
      'The new version is downloading now.<ol style="margin:8px 0 0 18px;padding:0;line-height:1.6">' +
      '<li>Open the downloaded <b>Referensys-Extension-' + upd.version + '.zip</b> and extract it into the same folder as before, replacing the old files.</li>' +
      '<li>Open Chrome’s <b>Extensions</b> page and click the <b>↻ reload</b> arrow on Referensys.</li></ol>' +
      '<p style="margin:8px 0 0">Your SOPs are in Google Drive, so nothing is lost.</p>');
    setTimeout(() => { const b = document.createElement('button'); b.className = 'btn'; b.textContent = 'Open the Extensions page'; b.onclick = () => chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
      const row = document.querySelector('.scrim:last-child .row'); if (row) row.prepend(b); }, 50);
  }
  setTimeout(checkUpdates, 5000);
  setInterval(checkUpdates, 4 * 60 * 60 * 1000);

  window.sop = {
    platform: 'extension',
    store: STORE,
    // Windows and Android recording hooks: not used here.
    onClick: noop, onLabel: noop, onStop: noop, onPause: noop, count: noop, pause: noop, done: noop, onPanelState: noop,
    version: async () => manifest.version,
    tickWorker: chrome.runtime.getURL('tick.js'),
    describeScreen: (prev, cur) => window.ReferensysScreenRead.describe(prev, cur),
    ext: {
      params,
      tabs,
      recordTab: async (tabId, screenText) => { await tabReady; return send({ type: 'startTab', tabId, from: myTab, screenText }); },
      focusTab: async (id, windowId) => { await chrome.tabs.update(id, { active: true }); if (windowId) await chrome.windows.update(windowId, { focused: true }).catch(noop); },
      onSteps: cb => { stepsCb = cb; waiting.splice(0).forEach(cb); },
      onCapture: cb => { captureCb = cb; },
      onNav: cb => { navCb = cb; },
      signInReady: auth.ready
    },
    pdf: pdfApi,
    drive,
    checkUpdates, updateStatus: async () => upd, onUpdateStatus: cb => { onStatus = cb; }, onUpdateReady: cb => { onReady = cb; }, installUpdate,
    setTheme: noop
  };
})();
