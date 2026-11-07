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

  class DriveError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
  const wrap = fn => async arg => { try { return await fn(arg); } catch (e) { console.error(e); return { error: e.message || String(e), code: e.code || 'error' }; } };

  /* ---------- step titles and instructions (same wording rules as the Windows app, with "tap") ---------- */
  const quote = s => '“' + s + '”';
  const looksPersonal = s => /\d{3,}|\d{1,2}\/\d{1,2}\/\d{2,4}|@|^[A-Z][A-Za-z'’-]+,\s*[A-Z]/.test(s);
  function parts(info) { const label = (info.label || '').trim(); return { role: info.role || '', safe: label && !looksPersonal(label) ? label : '', hidden: !!label && looksPersonal(label) }; }
  function titleFor(info) {
    const { role, safe: L, hidden } = parts(info);
    if (L) {
      if (/^(Edit|ComboBox)$/.test(role)) return `Tap the ${quote(L)} field`;
      if (role === 'CheckBox') return `Switch ${quote(L)}`;
      if (/^(RadioButton|TabItem|ListItem)$/.test(role)) return `Select ${quote(L)}`;
      return `Tap ${quote(L)}`;
    }
    if (hidden && role === 'ListItem') return 'Select the item in the list';
    if (hidden) return 'Tap the highlighted item';
    if (role === 'Edit') return info.app ? `Tap the text field in ${info.app}` : 'Tap the text field';
    return info.app ? `Tap in ${info.app}` : 'Tap here';
  }
  function instructionsFor(info) {
    const { role, safe, hidden } = parts(info), L = safe ? quote(safe) : '';
    let t;
    if (/^(Edit|ComboBox)$/.test(role)) t = L ? `tap the ${L} field.` : 'tap the text field.';
    else if (role === 'CheckBox') t = L ? `switch ${L} on or off.` : 'tap the highlighted switch.';
    else if (role === 'RadioButton') t = L ? `select the ${L} option.` : 'select the highlighted option.';
    else if (role === 'TabItem') t = L ? `open the ${L} tab.` : 'open the highlighted tab.';
    else if (role === 'ListItem') t = L ? `select ${L} in the list.` : 'select the highlighted item in the list.';
    else if (role === 'Button') t = L ? `tap the ${L} button.` : 'tap the highlighted button.';
    else t = L ? `tap ${L}.` : (hidden ? 'tap the highlighted item.' : 'tap the spot circled on the screenshot.');
    t = (info.app ? `In ${info.app}, ` : '') + t;
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  /* ---------- PDFs that carry their own editable copy (same format as the Windows app) ---------- */
  const ATTACH = 'referensys-sop.json';
  const pdfdata = {
    isPdf: u => u.length > 4 && u[0] === 0x25 && u[1] === 0x50 && u[2] === 0x44 && u[3] === 0x46,
    async embed(pdfBytes, text) {
      const doc = await PDFLib.PDFDocument.load(pdfBytes, { updateMetadata: false });
      await doc.attach(new TextEncoder().encode(text), ATTACH, { mimeType: 'application/json', description: 'Referensys editable SOP', modificationDate: new Date() });
      doc.setProducer('Referensys');
      return await doc.save();
    },
    async extract(bytes) {
      const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;
      const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
      const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
      const files = names && names.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
      if (!files) return null;
      const walk = node => {
        const arr = node.lookupMaybe(PDFName.of('Names'), PDFArray);
        if (arr) for (let i = 0; i + 1 < arr.size(); i += 2) {
          const key = arr.lookup(i); if (!key || !key.decodeText || key.decodeText() !== ATTACH) continue;
          const ef = arr.lookup(i + 1, PDFDict).lookupMaybe(PDFName.of('EF'), PDFDict);
          const st = ef && ef.lookup(PDFName.of('F'));
          if (st instanceof PDFRawStream) return new TextDecoder().decode(decodePDFRawStream(st).decode());
          if (st && st.getContents) return new TextDecoder().decode(st.getContents());
        }
        const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
        if (kids) for (let i = 0; i < kids.size(); i++) { const r = walk(kids.lookup(i, PDFDict)); if (r) return r; }
        return null;
      };
      return walk(files);
    }
  };

  /* ---------- Google Drive (same folder, files and search list as the Windows app) ---------- */
  const API = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const FOLDER = 'Referensys SOPs', INDEX = 'library.json', STORE = 'referensys-google';
  let store; try { store = JSON.parse(localStorage.getItem(STORE)) || null; } catch (e) { store = null; }
  if (!store) store = { active: null, accounts: {} };
  const persist = () => { try { localStorage.setItem(STORE, JSON.stringify(store)); } catch (e) {} };
  const tokens = {};

  async function token(email) {
    const t = tokens[email];
    if (t && t.exp > Date.now()) return t.v;
    if (!store.accounts[email]) throw new DriveError('Sign in with Google first.', 'signed_out');
    try {
      const r = await GoogleAuth.getToken({ email });
      tokens[email] = { v: r.accessToken, exp: Date.now() + 45 * 60 * 1000 };
      return r.accessToken;
    } catch (e) {
      if (['reauth', 'scopes', 'signed_out'].includes(e.code)) throw new DriveError(e.message || 'Sign in again.', 'reauth');
      throw new DriveError(e.message || 'Google sign-in failed.', 'auth');
    }
  }
  async function api(email, url, opts = {}, retry = true) {
    let r;
    try { r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + await token(email) } }); }
    catch (e) { if (e instanceof DriveError) throw e; throw new DriveError('Can’t reach Google Drive. Check your internet connection.', 'offline'); }
    if (r.status === 401 && retry) {
      const t = tokens[email]; delete tokens[email];
      if (t) await GoogleAuth.clearToken({ token: t.v }).catch(noop);
      return api(email, url, opts, false);
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const msg = (j.error && j.error.message) || ('HTTP ' + r.status);
      if (r.status === 403 && /insufficient|scope/i.test(msg)) throw new DriveError('Referensys needs one more permission from Google. Sign in again to allow it.', 'reauth');
      throw new DriveError(r.status === 404 ? 'That file isn’t in Google Drive any more.' : r.status === 403 && /quota|storage/i.test(msg) ? 'Your Google Drive is full.' : 'Google Drive: ' + msg, r.status === 404 ? 'missing' : 'drive');
    }
    return r;
  }
  const json = async (...a) => (await api(...a)).json();
  const q = s => encodeURIComponent(s);
  const active = () => { if (!store.active || !store.accounts[store.active]) throw new DriveError('Sign in with Google first.', 'signed_out'); return store.active; };
  const fileName = t => String(t || 'Untitled SOP').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Untitled SOP';
  const remove = (email, id) => api(email, `${API}/files/${id}`, { method: 'DELETE' }).catch(noop);

  async function folder(email) {
    const a = store.accounts[email];
    if (a.folderId) {
      try { const f = await json(email, `${API}/files/${a.folderId}?fields=id,trashed`); if (!f.trashed) return a.folderId; } catch (e) { if (e.code !== 'missing') throw e; }
    }
    const found = await json(email, `${API}/files?q=${q(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)&spaces=drive`);
    let id = found.files[0] && found.files[0].id;
    if (!id) id = (await json(email, `${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) })).id;
    a.folderId = id; persist();
    return id;
  }
  async function readSop(email, id) {
    const buf = new Uint8Array(await (await api(email, `${API}/files/${id}?alt=media`)).arrayBuffer());
    if (pdfdata.isPdf(buf)) {
      const t = await pdfdata.extract(buf);
      if (!t) throw new DriveError('This PDF doesn’t have a Referensys editable copy inside.', 'notsop');
      return t;
    }
    return new TextDecoder().decode(buf);
  }
  async function readIndex(email) {
    const a = store.accounts[email];
    if (!a.indexId) {
      const f = await json(email, `${API}/files?spaces=appDataFolder&q=${q(`name='${INDEX}' and trashed=false`)}&fields=files(id)`);
      a.indexId = f.files[0] ? f.files[0].id : null; persist();
    }
    if (a.indexId) {
      try { const d = JSON.parse(await (await api(email, `${API}/files/${a.indexId}?alt=media`)).text()); if (Array.isArray(d.sops)) return d.sops; }
      catch (e) { if (e.code !== 'missing' && !(e instanceof SyntaxError)) throw e; a.indexId = null; persist(); }
    }
    return rebuildIndex(email, await folder(email));
  }
  async function rebuildIndex(email, fid) {
    const r = await json(email, `${API}/files?q=${q(`'${fid}' in parents and appProperties has { key='referensys' and value='sop' } and trashed=false`)}&fields=files(id,name,mimeType,modifiedTime,appProperties)&orderBy=modifiedTime desc&pageSize=1000`);
    const list = [];
    for (const f of r.files) {
      let d = {};
      try { d = JSON.parse(await readSop(email, f.id)); } catch (e) {}
      const m = d.meta || {}, pdf = f.mimeType === 'application/pdf';
      list.push({ id: f.id, pdfId: pdf ? f.id : ((f.appProperties || {}).pdf || null), name: f.name.replace(/\.(referensys|pdf)$/i, ''), dept: m.dept || '', purpose: m.purpose || '',
        steps: (d.steps || []).map(s => [s.title, s.text].filter(Boolean).join('. ')), updated: f.modifiedTime, by: email });
    }
    await writeIndex(email, list);
    return list;
  }
  async function writeIndex(email, list) {
    const a = store.accounts[email];
    a.indexId = await upload(email, { id: a.indexId, name: INDEX, mime: 'application/json', parent: 'appDataFolder', body: new Blob([JSON.stringify({ v: 1, sops: list })], { type: 'application/json' }) });
    persist();
  }
  // Resumable upload; falls back to a single multipart request if the upload address isn't readable.
  async function upload(email, { id, name, mime, parent, props, body }) {
    const meta = { name, ...(props ? { appProperties: props } : {}) };
    const full = id ? meta : { ...meta, parents: [parent] };
    let r;
    try {
      r = await api(email, id ? `${UPLOAD}/files/${id}?uploadType=resumable&fields=id` : `${UPLOAD}/files?uploadType=resumable&fields=id`, {
        method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime }, body: JSON.stringify(full) });
    } catch (e) { if (id && e.code === 'missing') return upload(email, { name, mime, parent, props, body }); throw e; }
    const loc = r.headers.get('location');
    if (loc) {
      let put;
      try { put = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': mime }, body }); }
      catch (e) { throw new DriveError('The upload was interrupted. Check your connection and try again.', 'offline'); }
      if (!put.ok) throw new DriveError('Google Drive rejected the upload (HTTP ' + put.status + ').', 'drive');
      return (await put.json()).id;
    }
    const b = 'referensys' + Math.random().toString(36).slice(2);
    const multi = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(full)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`, body, `\r\n--${b}--`]);
    const m = await api(email, id ? `${UPLOAD}/files/${id}?uploadType=multipart&fields=id` : `${UPLOAD}/files?uploadType=multipart&fields=id`,
      { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: multi });
    return (await m.json()).id;
  }

  const drive = {
    accounts: wrap(async () => ({ active: store.accounts[store.active] ? store.active : null, list: Object.keys(store.accounts) })),
    signIn: wrap(async () => {
      let r;
      try { r = await GoogleAuth.signIn(); }
      catch (e) { throw new DriveError(e.message || 'Sign-in didn’t finish.', e.code === 'denied' ? 'denied' : 'auth'); }
      const email = r.email;
      store.accounts[email] = store.accounts[email] || {};
      store.active = email; persist();
      tokens[email] = { v: r.accessToken, exp: Date.now() + 45 * 60 * 1000 };
      return { email };
    }),
    switchTo: wrap(async email => { if (!store.accounts[email]) throw new DriveError('That account isn’t signed in.', 'signed_out'); store.active = email; persist(); return { email }; }),
    signOut: wrap(async email => {
      const t = tokens[email];
      if (t) { fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.v), { method: 'POST' }).catch(noop); GoogleAuth.clearToken({ token: t.v }).catch(noop); }
      delete tokens[email]; delete store.accounts[email];
      if (store.active === email) store.active = Object.keys(store.accounts)[0] || null;
      persist(); return { active: store.active };
    }),
    list: wrap(async () => { const email = active(); const sops = await readIndex(email); return { email, sops: sops.sort((a, b) => String(b.updated).localeCompare(String(a.updated))) }; }),
    save: wrap(async ({ id, title, project, pdf, summary }) => {
      const email = active(), parent = await folder(email), list = await readIndex(email);
      const name = fileName(title), prev = id && list.find(e => e.id === id);
      const body = new Blob([await pdfdata.embed(pdf, project)], { type: 'application/pdf' });
      const fileId = await upload(email, { id: prev && prev.pdfId, name: name + '.pdf', mime: 'application/pdf', parent, props: { referensys: 'sop' }, body });
      if (prev && prev.id !== fileId) await remove(email, prev.id);
      const entry = { id: fileId, pdfId: fileId, name, dept: summary.dept || '', purpose: summary.purpose || '', steps: summary.steps || [], updated: new Date().toISOString(), by: email };
      await writeIndex(email, [entry, ...list.filter(e => e.id !== fileId && e.id !== id)]);
      return { id: fileId, pdfId: fileId, email, name };
    }),
    open: wrap(async id => {
      const email = active();
      try { return { email, text: await readSop(email, id) }; }
      catch (e) { if (e.code === 'missing') { const l = await readIndex(email); await writeIndex(email, l.filter(x => x.id !== id)); } throw e; }
    }),
    pdf: wrap(async pdfId => { if (!pdfId) throw new DriveError('This SOP has no PDF yet. Open it and save again.', 'missing'); await Recorder.openUrl({ url: `https://drive.google.com/file/d/${pdfId}/view` }); return {}; }),
    rename: wrap(async ({ id, name }) => {
      const email = active(), list = await readIndex(email), e = list.find(x => x.id === id);
      if (!e) throw new DriveError('That SOP isn’t in your library any more.', 'missing');
      const n = fileName(name);
      const patch = (fid, nm) => api(email, `${API}/files/${fid}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm }) });
      if (e.pdfId && e.pdfId !== id) { await patch(id, n + '.referensys'); await patch(e.pdfId, n + '.pdf').catch(noop); }
      else await patch(id, n + '.pdf');
      e.name = n; await writeIndex(email, list);
      return { name: n };
    })
  };

  /* ---------- updates from GitHub releases ---------- */
  const REPO = 'ethan-thesys/referensys';
  let upd = { state: 'idle', version: null, percent: 0, error: null, checkedAt: null };
  let onStatus = noop, onReady = noop;
  const sendUpd = p => { upd = { ...upd, ...p }; onStatus(upd); if (p.state === 'ready') onReady(upd.version); };
  const nums = v => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
  const newer = (a, b) => { const x = nums(a), y = nums(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
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
    pdf: {
      embed: async ({ pdf, project }) => { try { return { bytes: await pdfdata.embed(pdf, project) }; } catch (e) { return { error: e.message }; } },
      extract: async bytes => { try { const t = await pdfdata.extract(bytes); return t ? { text: t } : { error: 'This PDF wasn’t made by Referensys, so it has no editable steps inside.' }; } catch (e) { return { error: 'Couldn’t read that PDF.' }; } }
    },
    drive,
    checkUpdates, updateStatus: async () => upd, onUpdateStatus: cb => { onStatus = cb; }, onUpdateReady: cb => { onReady = cb; }, installUpdate,
    setTheme: noop
  };
  window.__referensysAndroid = { titleFor, instructionsFor, pdfdata, newer };
})();
