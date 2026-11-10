/* One-off test: can Referensys read a library shared by someone else, after the person picks it in Google's picker?
   Uses only the drive.file permission. Read-only. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const API = 'https://www.googleapis.com/drive/v3';
  const row = (cls, html) => { const d = document.createElement('div'); d.className = 'r ' + cls; d.innerHTML = html; $('log').appendChild(d); return d; };
  const get = async (token, url) => { const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } }); return { ok: r.ok, status: r.status, r }; };

  $('go').onclick = async () => {
    $('log').innerHTML = '';
    const p = new URLSearchParams({
      client_id: window.REFERENSYS_GOOGLE_CLIENT_ID, response_type: 'token', redirect_uri: chrome.identity.getRedirectURL(),
      scope: 'https://www.googleapis.com/auth/drive.file', prompt: 'consent', trigger_onepick: 'true', allow_folder_selection: 'true', allow_multiple: 'true'
    });
    let back;
    try { back = await chrome.identity.launchWebAuthFlow({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + p, interactive: true }); }
    catch (e) { row('bad', '<b>Google’s window closed or failed:</b> ' + esc(e.message)); return; }
    const u = new URL(back), q = new URLSearchParams(u.hash.slice(1)), qs = u.searchParams;
    const val = k => q.get(k) || qs.get(k);
    if (val('error')) { row('bad', '<b>Google returned an error:</b> <code>' + esc(val('error')) + '</code> ' + esc(val('error_description') || '')); return; }
    const token = val('access_token') || val('code');
    const picked = (val('picked_file_ids') || '').split(',').filter(Boolean);
    row(token ? 'ok' : 'bad', token ? '<b>Signed in.</b> Google gave Referensys an access key.' : '<b>No access key came back.</b> Address: <code>' + esc(back.replace(/(access_token|code)=[^&]+/, '$1=…')) + '</code>');
    row(picked.length ? 'ok' : 'bad', picked.length ? `<b>Picked ${picked.length} item${picked.length > 1 ? 's' : ''}.</b>` : '<b>Nothing was picked</b> (or Google didn’t say what). Make sure Google Picker API is turned on in the Referensys project.');
    if (!token || !picked.length) return;

    let folderOk = false, filesSeen = 0, pdfRead = false, canEdit = null;
    for (const id of picked) {
      const f = await get(token, `${API}/files/${id}?fields=id,name,mimeType,owners(emailAddress),capabilities(canEdit,canListChildren)`);
      if (!f.ok) { row('bad', `<b>Couldn’t open the picked item</b> (HTTP ${f.status}).`); continue; }
      const m = await f.r.json(); canEdit = m.capabilities && m.capabilities.canEdit;
      row('ok', `<b>${esc(m.name)}</b> · ${m.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : esc(m.mimeType)} · owner ${esc((m.owners || [])[0] && m.owners[0].emailAddress || 'unknown')} · ${canEdit ? 'you can edit' : 'view only'}`);
      if (m.mimeType !== 'application/vnd.google-apps.folder') continue;
      folderOk = true;
      const l = await get(token, `${API}/files?q=${encodeURIComponent(`'${id}' in parents and trashed=false`)}&fields=files(id,name,mimeType,capabilities(canEdit))&pageSize=200`);
      if (!l.ok) { row('bad', `<b>Couldn’t list what’s inside the folder</b> (HTTP ${l.status}).`); continue; }
      const files = (await l.r.json()).files || [];
      filesSeen += files.length;
      row(files.length ? 'ok' : 'bad', files.length ? `<b>Referensys can see ${files.length} file${files.length > 1 ? 's' : ''} inside:</b> ${files.slice(0, 8).map(x => esc(x.name)).join(', ')}${files.length > 8 ? '…' : ''}`
        : '<b>The folder looks empty to Referensys.</b> If it has SOPs in Drive, Google is only letting Referensys see the folder itself, not what’s in it.');
      const pdf = files.find(x => x.mimeType === 'application/pdf');
      if (pdf) {
        const d = await get(token, `${API}/files/${pdf.id}?alt=media`);
        if (!d.ok) { row('bad', `<b>Couldn’t download ${esc(pdf.name)}</b> (HTTP ${d.status}).`); continue; }
        const bytes = new Uint8Array(await d.r.arrayBuffer());
        let steps = null; try { const t = await window.ReferensysCore.pdfdata.extract(bytes); steps = t ? (JSON.parse(t).steps || []).length : null; } catch (e) {}
        pdfRead = true;
        row('ok', `<b>Opened ${esc(pdf.name)}</b>${steps != null ? ` and read its ${steps} editable step${steps === 1 ? '' : 's'}.` : '.'}`);
      }
    }
    const good = folderOk && filesSeen > 0 && pdfRead;
    row(good ? 'ok verdict' : 'bad verdict', good
      ? `<b>It works.</b> Picking a shared library once is enough for Referensys to read the SOPs inside it.${canEdit ? ' This account can also edit it.' : ''} Send Claude a screenshot of this page.`
      : '<b>It doesn’t work this way.</b> Send Claude a screenshot of this page.');
  };
})();
