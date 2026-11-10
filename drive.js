// Google Drive for Referensys.
// Signs in with Google in the person's own browser and saves SOPs to a "Referensys SOPs" folder in their Drive.
// Each SOP is one PDF; the editable version rides inside it (see pdfdata.js).
// Permissions asked for: drive.file (only files Referensys itself created) and drive.appdata (Referensys's own
// hidden folder, which holds the search list). Nothing else in Drive is visible.
// All Drive traffic happens here in the main process; the app window stays blocked from the internet.
const { app, shell, safeStorage } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pdfdata = require('./pdfdata');

// The Google sign-in key isn't kept in the source code. GitHub writes google-client.json from the repository's
// Actions secrets (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) when it builds the installer.
let CFG = {};
try { CFG = require('./google-client.json'); } catch {}
const CLIENT_ID = CFG.id, CLIENT_SECRET = CFG.secret;
const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata';
const hasScopes = sc => /auth\/drive\.file/.test(sc || '') && /auth\/drive\.appdata/.test(sc || '');
const FOLDER = 'Referensys SOPs';
const INDEX = 'library.json';                                  // hidden, in Referensys's app folder
const OLD_INDEX = 'Referensys library (do not delete).json';    // visible list from the 1.2 test build
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
  if (!CLIENT_ID || !CLIENT_SECRET) return Promise.reject(new DriveError('Google sign-in isn’t set up in this copy of Referensys.', 'config'));
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
        if (!hasScopes(tok.scope)) throw new DriveError('Referensys needs both permissions on Google’s screen. Sign in again and leave both boxes ticked.', 'scopes');
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

// ---------- temporary test: can Referensys read a library someone else shared, after picking it in Google's picker? ----------
// Uses only drive.file and reads nothing but what the person picks. Remove once the team feature is built.
let picking = null;
function pickTest() {
  if (!CLIENT_ID || !CLIENT_SECRET) return Promise.reject(new DriveError('Google sign-in isn’t set up in this copy of Referensys.', 'config'));
  if (picking) return picking;
  picking = new Promise((resolve, reject) => {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const stateTok = crypto.randomBytes(16).toString('hex');
    let timer, redirect;
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>Referensys</title><body style="font:16px system-ui;max-width:520px;margin:80px auto;padding:0 16px"><h2>Thanks</h2><p>Go back to Referensys to see the test results.</p></body>');
      clearTimeout(timer); server.close();
      const out = [], line = (ok, text) => out.push({ ok, text });
      try {
        if (u.searchParams.get('state') !== stateTok) throw new DriveError('The reply from Google didn’t match. Try again.', 'state');
        if (u.searchParams.get('error')) throw new DriveError('Google said: ' + u.searchParams.get('error'), 'denied');
        const picked = (u.searchParams.get('picked_file_ids') || '').split(',').filter(Boolean);
        const tok = await tokenRequest({ grant_type: 'authorization_code', code: u.searchParams.get('code'), code_verifier: verifier, redirect_uri: redirect });
        line(true, 'Signed in. Google gave Referensys an access key.');
        line(picked.length > 0, picked.length ? `Picked ${picked.length} item${picked.length > 1 ? 's' : ''}.` : 'Nothing was picked, or Google didn’t say what. Check that Google Picker API is turned on in the Referensys project.');
        const get = async url => { const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok.access_token } }); return r; };
        let folderOk = false, seen = 0, read = false;
        for (const id of picked) {
          const f = await get(`${API}/files/${id}?fields=id,name,mimeType,owners(emailAddress),capabilities(canEdit)`);
          if (!f.ok) { line(false, `Couldn’t open the picked item (HTTP ${f.status}).`); continue; }
          const m = await f.json(), isFolder = m.mimeType === 'application/vnd.google-apps.folder';
          line(true, `${m.name}: ${isFolder ? 'folder' : m.mimeType}, owned by ${((m.owners || [])[0] || {}).emailAddress || 'unknown'}, ${m.capabilities && m.capabilities.canEdit ? 'you can edit it' : 'view only'}.`);
          if (!isFolder) continue;
          folderOk = true;
          const l = await get(`${API}/files?q=${encodeURIComponent(`'${id}' in parents and trashed=false`)}&fields=files(id,name,mimeType)&pageSize=200`);
          if (!l.ok) { line(false, `Couldn’t list what’s inside the folder (HTTP ${l.status}).`); continue; }
          const files = (await l.json()).files || [];
          seen += files.length;
          line(files.length > 0, files.length ? `Referensys can see ${files.length} file${files.length > 1 ? 's' : ''} inside: ${files.slice(0, 6).map(x => x.name).join(', ')}${files.length > 6 ? '…' : ''}`
            : 'The folder looks empty to Referensys. If it has SOPs in Drive, Google only lets Referensys see the folder itself, not what’s in it.');
          const pdf = files.find(x => x.mimeType === 'application/pdf');
          if (pdf) {
            const d = await get(`${API}/files/${pdf.id}?alt=media`);
            if (!d.ok) { line(false, `Couldn’t download ${pdf.name} (HTTP ${d.status}).`); continue; }
            const buf = Buffer.from(await d.arrayBuffer());
            let steps = null; try { const t = await pdfdata.extract(buf); steps = t ? (JSON.parse(t).steps || []).length : null; } catch {}
            read = true; line(true, `Opened ${pdf.name}${steps != null ? ` and read its ${steps} editable steps` : ''}.`);
          }
        }
        const good = folderOk && seen > 0 && read;
        resolve({ lines: out, good });
      } catch (e) { line(false, e.message); resolve({ lines: out, good: false }); }
    });
    server.listen(0, '127.0.0.1', () => {
      redirect = `http://127.0.0.1:${server.address().port}`;
      const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive.file',
        code_challenge: challenge, code_challenge_method: 'S256', state: stateTok, prompt: 'consent', trigger_onepick: 'true', allow_folder_selection: 'true', allow_multiple: 'true' });
      shell.openExternal('https://accounts.google.com/o/oauth2/v2/auth?' + q);
    });
    timer = setTimeout(() => { server.close(); reject(new DriveError('The test timed out. Try again.', 'timeout')); }, 5 * 60 * 1000);
  }).finally(() => { picking = null; });
  return picking;
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
    if (t.scope && !hasScopes(t.scope)) throw new DriveError('Referensys needs one more permission from Google, so it can keep its search list out of sight. Sign in again to allow it.', 'reauth');
    cache[email] = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 };
    return t.access_token;
  } catch (e) {
    if (e.code === 'signed_out' || e.code === 'reauth') { delete load().accounts[email]; if (store.active === email) store.active = null; persist(); }
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
    if (r.status === 403 && /insufficient|scope/i.test(msg)) throw new DriveError('Referensys needs one more permission from Google. Sign in again to allow it.', 'reauth');
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

// Reads one SOP file from Drive and returns its editable version as text (PDF with the copy inside, or an older .referensys file).
async function readSop(email, id) {
  const buf = Buffer.from(await (await api(email, `${API}/files/${id}?alt=media`)).arrayBuffer());
  if (pdfdata.isPdf(buf)) {
    const t = await pdfdata.extract(buf);
    if (!t) throw new DriveError('This PDF doesn’t have a Referensys editable copy inside.', 'notsop');
    return t;
  }
  return buf.toString('utf8');
}

async function readIndex(email) {
  const a = load().accounts[email];
  if (!a.indexId) {
    const f = await json(email, `${API}/files?spaces=appDataFolder&q=${q(`name='${INDEX}' and trashed=false`)}&fields=files(id)`);
    a.indexId = f.files[0] ? f.files[0].id : null; persist();
  }
  if (a.indexId) {
    try { const d = JSON.parse(await (await api(email, `${API}/files/${a.indexId}?alt=media`)).text()); if (Array.isArray(d.sops)) return d.sops; }
    catch (e) { if (e.code !== 'missing' && !(e instanceof SyntaxError)) throw e; a.indexId = null; persist(); }
  }
  const fid = await folder(email);
  // Move the visible list from the 1.2 test build into the hidden folder, then remove it from the SOPs folder.
  const old = await json(email, `${API}/files?q=${q(`'${fid}' in parents and name='${OLD_INDEX}' and trashed=false`)}&fields=files(id)`);
  if (old.files[0]) {
    let list = null;
    try { const d = JSON.parse(await (await api(email, `${API}/files/${old.files[0].id}?alt=media`)).text()); if (Array.isArray(d.sops)) list = d.sops; } catch {}
    if (list) { await writeIndex(email, list); await remove(email, old.files[0].id); return list; }
  }
  return rebuildIndex(email, fid); // no list yet (first use, or it was lost): rebuild it from the SOP files
}
async function rebuildIndex(email, fid) {
  const r = await json(email, `${API}/files?q=${q(`'${fid}' in parents and appProperties has { key='referensys' and value='sop' } and trashed=false`)}&fields=files(id,name,mimeType,modifiedTime,appProperties)&orderBy=modifiedTime desc&pageSize=1000`);
  const list = [];
  for (const f of r.files) {
    let d = {};
    try { d = JSON.parse(await readSop(email, f.id)); } catch {}
    const m = d.meta || {}, pdf = f.mimeType === 'application/pdf';
    list.push({ id: f.id, pdfId: pdf ? f.id : ((f.appProperties || {}).pdf || null), name: f.name.replace(/\.(referensys|pdf)$/i, ''), dept: m.dept || '', purpose: m.purpose || '',
      steps: (d.steps || []).map(s => [s.title, s.text].filter(Boolean).join('. ')), updated: f.modifiedTime, by: email });
  }
  await writeIndex(email, list);
  return list;
}
async function writeIndex(email, list) {
  const a = load().accounts[email];
  const id = await upload(email, { id: a.indexId, name: INDEX, mime: 'application/json', parent: 'appDataFolder', body: Buffer.from(JSON.stringify({ v: 1, sops: list })) });
  a.indexId = id; persist();
}
const remove = (email, id) => api(email, `${API}/files/${id}`, { method: 'DELETE' }).catch(() => {});

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
    const body = await pdfdata.embed(Buffer.from(pdf), project);      // one file: the PDF, with the editable copy inside
    const fileId = await upload(email, { id: prev && prev.pdfId, name: name + '.pdf', mime: 'application/pdf', parent, props: { referensys: 'sop' }, body });
    if (prev && prev.id !== fileId) await remove(email, prev.id);   // older two-file SOP: drop the separate .referensys file
    const entry = { id: fileId, pdfId: fileId, name, dept: summary.dept || '', purpose: summary.purpose || '', steps: summary.steps || [], updated: new Date().toISOString(), by: email };
    await writeIndex(email, [entry, ...list.filter(e => e.id !== fileId && e.id !== id)]);
    return { id: fileId, pdfId: fileId, email, name };
  },
  open: async id => {
    const email = active();
    try { return { email, text: await readSop(email, id) }; }
    catch (e) { if (e.code === 'missing') { const l = await readIndex(email); await writeIndex(email, l.filter(x => x.id !== id)); } throw e; }
  },
  pdf: async pdfId => { if (!pdfId) throw new DriveError('This SOP has no PDF yet. Open it and save again.', 'missing'); await shell.openExternal(`https://drive.google.com/file/d/${pdfId}/view`); return {}; },
  pickTest: () => pickTest(),
  rename: async ({ id, name }) => {
    const email = active(), list = await readIndex(email), e = list.find(x => x.id === id);
    if (!e) throw new DriveError('That SOP isn’t in your library any more.', 'missing');
    const n = fileName(name);
    const patch = (fid, nm) => api(email, `${API}/files/${fid}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm }) });
    if (e.pdfId && e.pdfId !== id) { await patch(id, n + '.referensys'); await patch(e.pdfId, n + '.pdf').catch(() => {}); }
    else await patch(id, n + '.pdf');
    e.name = n; await writeIndex(email, list);
    return { name: n };
  }
};

function register(ipcMain, getWin) {
  ipcMain.handle('pdf:embed', async (_e, { pdf, project }) => { try { return { bytes: new Uint8Array(await pdfdata.embed(Buffer.from(pdf), project)) }; } catch (e) { return { error: e.message }; } });
  ipcMain.handle('pdf:extract', async (_e, bytes) => { try { const t = await pdfdata.extract(Buffer.from(bytes)); return t ? { text: t } : { error: 'This PDF wasn’t made by Referensys, so it has no editable steps inside.' }; } catch (e) { return { error: 'Couldn’t read that PDF.' }; } });
  for (const [k, fn] of Object.entries(actions)) {
    ipcMain.handle('drive:' + k, async (_e, arg) => {
      try {
        const r = await fn(arg);
        if (k === 'signIn' || k === 'pickTest') { const w = getWin(); if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); } }
        return r;
      } catch (e) { console.error('Drive', k, e); return { error: e.message || String(e), code: e.code || 'error' }; }
    });
  }
}
module.exports = { register };
