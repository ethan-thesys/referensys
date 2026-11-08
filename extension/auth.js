/* Google sign-in for the Referensys extension. Uses Chrome's sign-in window, so any Google account works,
   not just the one signed in to Chrome. Access tokens last about an hour; a new one is fetched quietly. */
(function () {
  'use strict';
  const { DriveError } = window.ReferensysCore;
  const CLIENT_ID = window.REFERENSYS_GOOGLE_CLIENT_ID || '';
  const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata';
  const NEED = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.appdata'];

  function url(hint, prompt) {
    const p = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'token', redirect_uri: chrome.identity.getRedirectURL(), scope: SCOPES, include_granted_scopes: 'true' });
    if (prompt) p.set('prompt', prompt);
    if (hint) p.set('login_hint', hint);
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
  }
  async function flow(hint, interactive) {
    if (!CLIENT_ID) throw new DriveError('Google sign-in isn’t set up in this copy of the extension yet.', 'setup');
    let back;
    try {
      back = await chrome.identity.launchWebAuthFlow({ url: url(hint, interactive ? 'select_account' : 'none'), interactive,
        abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 10000 });
    } catch (e) {
      const m = String(e && e.message || e);
      if (interactive) throw new DriveError(/did not approve|cancel|closed/i.test(m) ? 'Sign-in was cancelled.' : 'Google sign-in didn’t finish: ' + m, /did not approve|cancel|closed/i.test(m) ? 'denied' : 'auth');
      throw new DriveError('Sign in again to keep saving to Google Drive.', 'reauth');
    }
    const p = new URLSearchParams(new URL(back).hash.slice(1));
    if (p.get('error')) {
      if (p.get('error') === 'access_denied') throw new DriveError('Sign-in was cancelled.', 'denied');
      throw new DriveError('Sign in again to keep saving to Google Drive.', 'reauth');
    }
    const granted = (p.get('scope') || '').split(' ');
    if (!NEED.every(s => granted.includes(s))) throw new DriveError('Referensys needs both permissions on Google’s screen. Sign in again and leave both boxes ticked.', 'scopes');
    return { token: p.get('access_token'), exp: Date.now() + Math.max(60, (+p.get('expires_in') || 3600) - 300) * 1000 };
  }
  // Tokens are shared between the popup and editor tabs for the session.
  const cacheGet = async email => { try { const c = (await chrome.storage.session.get('tok:' + email))['tok:' + email]; return c && c.exp > Date.now() ? c.token : null; } catch (e) { return null; } };
  const cacheSet = (email, t) => chrome.storage.session.set({ ['tok:' + email]: t }).catch(() => {});

  window.ReferensysExtAuth = {
    ready: !!CLIENT_ID,
    async signIn() {
      const t = await flow(null, true);
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + t.token } });
      const u = r.ok ? await r.json() : {};
      if (!u.email) throw new DriveError('Couldn’t read which Google account you chose. Try again.', 'auth');
      await cacheSet(u.email, t);
      return { email: u.email, accessToken: t.token };
    },
    async getToken(email) {
      const c = await cacheGet(email);
      if (c) return c;
      const t = await flow(email, false);
      await cacheSet(email, t);
      return t.token;
    },
    async clearToken(token) {
      const all = await chrome.storage.session.get(null).catch(() => ({}));
      const gone = Object.keys(all).filter(k => k.startsWith('tok:') && all[k] && all[k].token === token);
      if (gone.length) await chrome.storage.session.remove(gone).catch(() => {});
    }
  };
})();
