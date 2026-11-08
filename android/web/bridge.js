/* Referensys for Android: connects the shared editor (index.html) to Android.
   It provides the same window.sop interface the Windows app's preload.js does, so the editor code is shared.
   Native pieces live in android/app/src/main/java/io/github/referensys/. */
(function () {
  'use strict';
  const Cap = window.Capacitor;
  const Recorder = Cap.registerPlugin('Recorder');
  const GoogleAuth = Cap.registerPlugin('GoogleAuth');
  const Filesystem = Cap.registerPlugin('Filesystem');
  const Share = Cap.registerPlugin('Share');
  const noop = () => {};

  const { DriveError, words, pdfApi, makeDrive, newer } = window.ReferensysCore;
  const titleFor = words.tap.title, instructionsFor = words.tap.text;

  /* ---------- Google Drive (shared code in web/core.js) ---------- */
  const drive = makeDrive({
    auth: {
      signIn: async () => {
        try { const r = await GoogleAuth.signIn(); return { email: r.email, accessToken: r.accessToken }; }
        catch (e) { throw new DriveError(e.message || 'Sign-in didn’t finish.', e.code === 'denied' ? 'denied' : 'auth'); }
      },
      getToken: async email => {
        try { return (await GoogleAuth.getToken({ email })).accessToken; }
        catch (e) { throw new DriveError(e.message || 'Google sign-in failed.', ['reauth', 'scopes', 'signed_out'].includes(e.code) ? 'reauth' : 'auth'); }
      },
      clearToken: token => GoogleAuth.clearToken({ token })
    },
    openUrl: url => Recorder.openUrl({ url })
  });

  /* ---------- updates from GitHub releases ---------- */
  const REPO = 'ethan-thesys/referensys';
  let upd = { state: 'idle', version: null, percent: 0, error: null, checkedAt: null };
  let onStatus = noop, onReady = noop;
  const sendUpd = p => { upd = { ...upd, ...p }; onStatus(upd); if (p.state === 'ready') onReady(upd.version); };
  let installed = '';
  async function checkUpdates() {
    if (['checking', 'downloading', 'ready'].includes(upd.state)) return upd;
    sendUpd({ state: 'checking', error: null });
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('github ' + r.status);
      const rel = await r.json(), v = String(rel.tag_name || '').replace(/^v/, '');
      const apk = (rel.assets || []).find(a => /\.apk$/i.test(a.name));
      if (!installed) installed = (await Recorder.getInfo()).version;
      if (!apk || !newer(v, installed)) { sendUpd({ state: 'latest', checkedAt: Date.now() }); return upd; }
      sendUpd({ state: 'downloading', version: v, percent: 0, checkedAt: Date.now() });
      const h = await Recorder.addListener('updateProgress', p => sendUpd({ percent: p.percent }));
      try { await Recorder.downloadUpdate({ url: apk.browser_download_url }); } finally { h.remove(); }
      sendUpd({ state: 'ready', percent: 100 });
    } catch (e) {
      sendUpd({ state: 'error', error: navigator.onLine === false ? 'You’re offline. Check your connection.' : 'The update check didn’t finish. Try again in a minute.', checkedAt: Date.now() });
    }
    return upd;
  }
  async function installUpdate() {
    const c = await Recorder.canInstall();
    if (!c.allowed) {
      if (typeof info === 'function') info('One more Android setting', 'Android needs your OK before Referensys can install its own updates. On the next screen, switch on <b>Allow from this source</b>, come back, and tap <b>Install update</b> again.');
      setTimeout(() => Recorder.openInstallSettings(), 1800);
      return;
    }
    await Recorder.installUpdate();
  }
  setTimeout(checkUpdates, 5000);
  setInterval(checkUpdates, 4 * 60 * 60 * 1000);

  /* ---------- tap recording ---------- */
  let stepsCb = null, waiting = [];
  Recorder.addListener('recorded', d => {
    let list = [];
    try { list = JSON.parse(d.steps); } catch (e) {}
    list.forEach(s => { s.title = titleFor(s); s.text = instructionsFor(s); });
    if (stepsCb) stepsCb(list); else waiting.push(list);
  });

  /* ---------- saving a file the person can keep or send ---------- */
  async function saveFile(blob, name) {
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
    const w = await Filesystem.writeFile({ path: name.replace(/[\\/:*?"<>|]+/g, ' '), data: b64, directory: 'CACHE' });
    try { await Share.share({ title: name, files: [w.uri], dialogTitle: 'Save or send ' + name }); }
    catch (e) { if (!/cancel/i.test(String(e && e.message))) throw e; return false; }
    return true;
  }

  window.sop = {
    platform: 'android',
    // Windows-only recording hooks: not used on Android.
    onClick: noop, onLabel: noop, onStop: noop, onPause: noop, count: noop, pause: noop, done: noop, onPanelState: noop,
    version: async () => (installed = installed || (await Recorder.getInfo()).version),
    mobile: {
      status: () => Recorder.status(),
      openSettings: () => Recorder.openSettings(),
      start: o => Recorder.start(o || {}),
      onSteps: cb => { stepsCb = cb; const w = waiting; waiting = []; w.forEach(cb); }
    },
    saveFile,
    pdf: pdfApi,
    drive,
    checkUpdates, updateStatus: async () => upd, onUpdateStatus: cb => { onStatus = cb; }, onUpdateReady: cb => { onReady = cb; }, installUpdate,
    setTheme: noop
  };
  window.__referensysAndroid = { titleFor, instructionsFor, pdfdata: window.ReferensysCore.pdfdata, newer };
})();
