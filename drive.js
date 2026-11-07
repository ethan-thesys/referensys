// Google Drive for Referensys.
// Signs in with Google in the person's own browser and saves SOPs to a "Referensys SOPs" folder in their Drive.
// Permission asked for: drive.file, which only reaches files Referensys itself created. Nothing else in Drive is visible.
// All Drive traffic happens here in the main process; the app window stays blocked from the internet.
const { app, shell, safeStorage } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The Google sign-in key isn't kept in the source code. GitHub writes google-client.json from the repository's
// Actions secrets (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) when it builds the installer.
let CFG = {};
try { CFG = require('./google-client.json'); } catch {}
const CLIENT_ID = CFG.id, CLIENT_SECRET = CFG.secret;
const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
const FOLDER = 'Referensys SOPs';
const INDEX = 'Referensys library (do not delete).json';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

// ---------- saved accounts (refresh tokens are encrypted with Windows' own protection) ----------
const storeFile = () => path.join(app.getPath('userData'), 'google-accounts.json');
let store = null;
function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch { store = { active: null, accounts: {} }; }
  return store;
}
function persist() { try { fs.writeFileSync(storeFile(), JSON.stringify(store)); } catch (e) { console.error('Could not save accounts', e); } }
const seal = s => safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : 'raw:' + s;
const unseal = s => s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : s.slice(4);

class DriveError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

// ---------- sign in (system browser + loopback, with PKCE) ----------
let signingIn = null;
function signIn() {
  if (!CLIENT_ID || !CLIENT_SECRET) return Promise.reject(new DriveError('Google sign-in isn\u2019t set up in this copy of Referensys.', 'config'));
  if (signingIn) return signingIn;
  signingIn = new Promise((resolve, reject) => {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const stateTok = crypto.randomBytes(16).toString('hex');
    let timer;
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }
      const done = (ok, msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Referensys</title><body style="font:16px system-ui;max-width:520px;margin:80px auto;padding:0 16px;color:#14212b"><h2>${ok ? 'You’re signed in' : 'Sign-in didn’t finish'}</h2><p>${msg}</p></body>`);
        clearTimeout(timer); server.close();
      };
      try {
        if (u.searchParams.get('state') !== stateTok) throw new DriveError('The sign-in reply didn’t match. Try again.', 'state');
        if (u.searchParams.get('error')) throw new DriveError(u.searchParams.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : 'Google said: ' + u.searchParams.get('error'), 'denied');
        const tok = await tokenRequest({ grant_type: 'authorization_code', code: u.searchParams.get('code'), code_verifier: verifier, redirect_uri: redirect });
        if (!tok.refresh_token) throw new DriveError('Google didn’t return a sign-in key. Try again.', 'norefresh');
        const email = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString()).email;
        const s = load();
        s.accounts[email] = { ...(s.accounts[email] || {}), refresh: seal(tok.refresh_token) };
        s.active = email; persist();
        cache[email] = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
        done(true, 'You can close this tab and go back to Referensys.');
        resolve(email);
      } catch (e) { done(false, e.message + ' You can close this tab.'); reject(e); }
    });
    let redirect;
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${server.address().port}`;
      const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: SCOPES,
        code_challenge: challenge, code_challenge_method: 'S256', state: stateTok, access_type: 'offline', prompt: 'select_account consent' });
      shell.openExternal('https://accounts.google.com/o/oauth2/v2/auth?' + q);
    });
    timer = setTimeout(() => { server.close(); reject(new DriveError('Sign-in timed out. Try again.', 'timeout')); }, 5 * 60 * 1000);
  }).finally(() => { signingIn = null; });
  return signingIn;
}

async function tokenRequest(params) {
  let r;
  try {
    r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }) });
  } catch { throw new DriveError('Can’t reach Google. Check your internet connection.', 'offline'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new DriveError(j.error === 'invalid_grant' ? 'Your Google sign-in has expired. Sign in again.' : 'Google sign-in failed: ' + (j.error_description || j.error || r.status), j.error === 'invalid_grant' ? 'signed_out' : 'token');
  return j;
}

const cache = {};
async function token(email) {
  const c = cache[email];
  if (c && c.exp > Date.now()) return c.token;
  const a = load().accounts[email];
  if (!a) throw new DriveError('Sign in with Google first.', 'signed_out');
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: unseal(a.refresh) });
    cache[email] = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
    return t.access_token;
  } catch (e) {
    if (e.code === 'signed_out') { delete load().accounts[email]; if (store.active === email) store.active = null; persist(); }
    throw e;
  }
}

async function api(email, url, opts = {}, retry = true) {
  let r;
  try { r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + await token(email) } }); }
  catch (e) { if (e instanceof DriveError) throw e; throw new DriveError('Can’t reach Google Drive. Check your internet connection.', 'offline'); }
  if (r.status === 401 && retry) { delete cache[email]; return api(email, url, opts, false); }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const msg = j.error && j.error.message || ('HTTP ' + r.status);
    throw new DriveError(r.status === 404 ? 'That file isn’t in Google Drive any more.' : r.status === 403 && /quota|storage/i.test(msg) ? 'Your Google Drive is full.' : 'Google Drive: ' + msg, r.status === 404 ? 'missing' : 'drive');
  }
  return r;
}
const json = async (...a) => (await api(...a)).json();
const q = s => encodeURIComponent(s);

// ---------- folder and library index ----------
async function folder(email) {
  const a = load().accounts[email];
  if (a.folderId) {
    try { const f = await json(email, `${API}/files/${a.folderId}?fields=id,trashed`); if (!f.trashed) return a.folderId; } catch (e) { if (e.code !== 'missing') throw e; }
  }
  const found = await json(email, `${API}/files?q=${q(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)&spaces=drive`);
  let id = found.files[0] && found.files[0].id;
  if (!id) id = (await json(email, `${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) })).id;
  a.folderId = id; a.indexId = null; persist();
  return id;
}

async function readIndex(email) {
  const a = load().accounts[email], fid = await folder(email);
  if (!a.indexId) {
    const f = await json(email, `${API}/files?q=${q(`'${fid}' in parents and name='${INDEX}' and trashed=false`)}&fields=files(id)`);
    a.indexId = f.files[0] ? f.files[0].id : null; persist();
  }
  if (a.indexId) {
    try { const d = JSON.parse(await (await api(email, `${API}/files/${a.indexId}?alt=media`)).text()); if (Array.isArray(d.sops)) return d.sops; }
    catch (e) { if (e.code !== 'missing' && !(e instanceof SyntaxError)) throw e; a.indexId = null; persist(); }
  }
  return rebuildIndex(email, fid); // index missing (deleted by hand, or first use): rebuild it from the SOP files
}
async function rebuildIndex(email, fid) {
  const r = await json(email, `${API}/files?q=${q(`'${fid}' in parents and appProperties has { key='referensys' and value='sop' } and trashed=false`)}&fields=files(id,name,modifiedTime,appProperties)&orderBy=modifiedTime desc&pageSize=1000`);
  const list = [];
  for (const f of r.files) {
    let d = {};
    try { d = JSON.parse(await (await api(email, `${API}/files/${f.id}?alt=media`)).text()); } catch {}
    const m = d.meta || {};
    list.push({ id: f.id, pdfId: (f.appProperties || {}).pdf || null, name: f.name.replace(/\.referensys$/, ''), dept: m.dept || '', purpose: m.purpose || '',
      steps: (d.steps || []).map(s => [s.title, s.text].filter(Boolean).join('. ')), updated: f.modifiedTime, by: email });
  }
  await writeIndex(email, list);
  return list;
}
async function writeIndex(email, list) {
  const a = load().accounts[email];
  const id = await upload(email, { id: a.indexId, name: INDEX, mime: 'application/json', parent: await folder(email), body: Buffer.from(JSON.stringify({ v: 1, sops: list })) });
  a.indexId = id; persist();
}

// Resumable upload works for any size. With an id it replaces the file's contents (and name).
async function upload(email, { id, name, mime, parent, props, body }) {
  const meta = { name, ...(props ? { appProperties: props } : {}) };
  let r;
  try {
    r = await api(email, id ? `${UPLOAD}/files/${id}?uploadType=resumable&fields=id` : `${UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(body.length) },
      body: JSON.stringify(id ? meta : { ...meta, parents: [parent] }) });
  } catch (e) { if (id && e.code === 'missing') return upload(email, { name, mime, parent, props, body }); throw e; }
  const put = await fetch(r.headers.get('location'), { method: 'PUT', headers: { 'Content-Type': mime }, body })
    .catch(() => { throw new DriveError('The upload was interrupted. Check your connection and try again.', 'offline'); });
  if (!put.ok) throw new DriveError('Google Drive rejected the upload (HTTP ' + put.status + ').', 'drive');
  return (await put.json()).id;
}

const fileName = t => String(t || 'Untitled SOP').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Untitled SOP';
const active = () => { const s = load(); if (!s.active || !s.accounts[s.active]) throw new DriveError('Sign in with Google first.', 'signed_out'); return s.active; };

// ---------- what the window can ask for ----------
const actions = {
  accounts: () => { const s = load(); return { active: s.accounts[s.active] ? s.active : null, list: Object.keys(s.accounts) }; },
  signIn: async () => ({ email: await signIn() }),
  switchTo: email => { const s = load(); if (!s.accounts[email]) throw new DriveError('That account isn’t signed in.', 'signed_out'); s.active = email; persist(); return { email }; },
  signOut: async email => {
    const s = load(), a = s.accounts[email];
    if (a) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(unseal(a.refresh)), { method: 'POST' }); } catch {} }
    delete s.accounts[email]; delete cache[email];
    if (s.active === email) s.active = Object.keys(s.accounts)[0] || null;
    persist(); return { active: s.active };
  },
  list: async () => { const email = active(); const sops = await readIndex(email); return { email, sops: sops.sort((a, b) => String(b.updated).localeCompare(String(a.updated))) }; },
  save: async ({ id, title, project, pdf, summary }) => {
    const email = active(), parent = await folder(email), list = await readIndex(email);
    const name = fileName(title), prev = id && list.find(e => e.id === id);
    const pdfId = await upload(email, { id: prev && prev.pdfId, name: name + '.pdf', mime: 'application/pdf', parent, props: { referensys: 'pdf' }, body: Buffer.from(pdf) });
    const sopId = await upload(email, { id: prev && prev.id, name: name + '.referensys', mime: 'application/json', parent, props: { referensys: 'sop', pdf: pdfId }, body: Buffer.from(project) });
    const entry = { id: sopId, pdfId, name, dept: summary.dept || '', purpose: summary.purpose || '', steps: summary.steps || [], updated: new Date().toISOString(), by: email };
    await writeIndex(email, [entry, ...list.filter(e => e.id !== sopId && e.id !== id)]);
    return { id: sopId, pdfId, email, name };
  },
  open: async id => {
    const email = active();
    try { return { email, text: await (await api(email, `${API}/files/${id}?alt=media`)).text() }; }
    catch (e) { if (e.code === 'missing') { const l = await readIndex(email); await writeIndex(email, l.filter(x => x.id !== id)); } throw e; }
  },
  pdf: async pdfId => { if (!pdfId) throw new DriveError('This SOP has no PDF yet. Open it and save again.', 'missing'); await shell.openExternal(`https://drive.google.com/file/d/${pdfId}/view`); return {}; },
  rename: async ({ id, name }) => {
    const email = active(), list = await readIndex(email), e = list.find(x => x.id === id);
    if (!e) throw new DriveError('That SOP isn’t in your library any more.', 'missing');
    const n = fileName(name);
    const patch = (fid, nm) => api(email, `${API}/files/${fid}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm }) });
    await patch(id, n + '.referensys');
    if (e.pdfId) await patch(e.pdfId, n + '.pdf').catch(() => {});
    e.name = n; await writeIndex(email, list);
    return { name: n };
  }
};

function register(ipcMain, getWin) {
  for (const [k, fn] of Object.entries(actions)) {
    ipcMain.handle('drive:' + k, async (_e, arg) => {
      try {
        const r = await fn(arg);
        if (k === 'signIn') { const w = getWin(); if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); } }
        return r;
      } catch (e) { console.error('Drive', k, e); return { error: e.message || String(e), code: e.code || 'error' }; }
    });
  }
}
module.exports = { register };
