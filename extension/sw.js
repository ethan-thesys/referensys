/* Referensys extension background worker.
   Records clicks in one browser tab: the page tells us where the click was and what was clicked,
   we take a screenshot of the tab, and the steps wait in IndexedDB until the editor opens them.
   Also passes the Ctrl+Shift+1 shortcut on, which works even when another app is in front. */
importScripts('idb.js');

const EDITOR = chrome.runtime.getURL('editor.html');
let rec = null, loaded = false, lastShot = 0, chain = Promise.resolve();

async function load() {
  if (loaded) return;
  rec = (await chrome.storage.session.get('rec')).rec || null;
  loaded = true;
}
const save = () => chrome.storage.session.set({ rec });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function badge() {
  chrome.action.setBadgeBackgroundColor({ color: rec && rec.paused ? '#6b7a86' : '#f2711c' });
  chrome.action.setBadgeText({ text: rec ? (rec.paused ? 'II' : String(rec.n)) : '' });
  chrome.action.setTitle({ title: rec ? `Referensys: recording (${rec.n} step${rec.n === 1 ? '' : 's'})` : 'Referensys: record an SOP' });
}

const recordable = url => /^(https?|file):/.test(url || '') && !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/.test(url);

async function inject(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); } catch (e) { /* page not ready or not allowed */ }
}

async function startTab(tabId, from, screenText) {
  if (rec) {
    try { await chrome.tabs.get(rec.tabId); return { error: 'Referensys is already recording another tab. Click Done on that tab first.' }; }
    catch (e) { rec = null; }
  }
  const tab = await chrome.tabs.get(tabId);
  if (!recordable(tab.url)) return { error: 'Chrome doesn’t let extensions record this page. Open the website you want to record first, then try again.', code: 'page' };
  rec = { tabId, windowId: tab.windowId, from: from || null, key: 'rec-' + Date.now(), n: 0, paused: false, text: screenText !== false };
  await save();
  badge();
  await inject(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return { ok: true };
}

async function shoot(windowId) {
  const wait = 520 - (Date.now() - lastShot); // Chrome allows two screenshots a second
  if (wait > 0) await sleep(wait);
  lastShot = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 88 });
}

async function addStep(m) {
  const r = rec;
  if (!r) return { n: 0 };
  const i = r.n++;
  await save();
  badge();
  let image;
  try { image = await shoot(r.windowId); } catch (e) { r.n--; await save(); badge(); return { n: r.n, error: 'screenshot' }; }
  await kv.set(r.key + ':' + i, {
    image, vw: m.vw || null, x: m.x == null ? null : m.x, y: m.y == null ? null : m.y,
    label: r.text ? (m.label || '') : '', role: m.role || '', app: m.app || ''
  });
  return { n: r.n };
}
const queue = m => (chain = chain.then(() => addStep(m)).catch(() => ({ n: rec ? rec.n : 0 })));

async function done() {
  if (!rec) return { ok: true };
  const r = rec;
  rec = null;
  await save();
  badge();
  chrome.tabs.sendMessage(r.tabId, { type: 'stop' }).catch(() => {});
  await chain;
  const steps = [];
  for (let i = 0; i < r.n; i++) {
    const s = await kv.get(r.key + ':' + i).catch(() => null);
    if (s) steps.push(s);
    kv.del(r.key + ':' + i).catch(() => {});
  }
  await kv.set('pending:' + r.key, steps);
  let to = null;
  if (r.from) { try { const t = await chrome.tabs.get(r.from); if (t.url && t.url.startsWith(EDITOR)) to = t; } catch (e) {} }
  if (to) {
    await chrome.tabs.update(to.id, { active: true });
    await chrome.windows.update(to.windowId, { focused: true }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'recorded', key: r.key, to: to.id }).catch(() => {});
  } else {
    await chrome.tabs.create({ url: EDITOR + '?rec=' + encodeURIComponent(r.key), windowId: r.windowId }).catch(() => chrome.tabs.create({ url: EDITOR + '?rec=' + encodeURIComponent(r.key) }));
  }
  return { ok: true, n: steps.length };
}

async function openEditor(query, reuse) {
  if (reuse) {
    const tabs = await chrome.tabs.query({ url: EDITOR + '*' });
    if (tabs.length) {
      const t = tabs[0];
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      chrome.runtime.sendMessage({ type: 'nav', query: query || '', to: t.id }).catch(() => {});
      return { ok: true };
    }
  }
  await chrome.tabs.create({ url: EDITOR + (query ? '?' + query : '') });
  return { ok: true };
}

async function handle(m, sender) {
  await load();
  const fromTab = sender.tab && sender.tab.id;
  switch (m.type) {
    case 'startTab': return startTab(m.tabId, m.from, m.screenText);
    case 'click':
      if (!rec || rec.paused || fromTab !== rec.tabId) return { ignored: true };
      return queue(m);
    case 'pause':
      if (!rec) return {};
      rec.paused = !rec.paused; await save(); badge();
      return { paused: rec.paused, n: rec.n };
    case 'done': return done();
    case 'state':
      return { rec: rec ? { n: rec.n, paused: rec.paused, mine: fromTab === rec.tabId, tabId: rec.tabId } : null };
    case 'openEditor': return openEditor(m.query, m.reuse);
  }
  return {};
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || !m.type || m.to !== undefined) return false; // messages meant for editor pages
  handle(m, sender).then(reply, e => reply({ error: e.message || String(e) }));
  return true;
});

// Keep recording after the page loads something new in the same tab.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  await load();
  if (rec && tabId === rec.tabId) inject(tabId);
});
chrome.tabs.onRemoved.addListener(async tabId => { await load(); if (rec && tabId === rec.tabId) done(); });

// Ctrl+Shift+1: take a step now. Works while another app is in front.
chrome.commands.onCommand.addListener(async cmd => {
  if (cmd !== 'capture-step') return;
  await load();
  if (rec && !rec.paused) {
    const r = await queue({});
    if (rec) chrome.tabs.sendMessage(rec.tabId, { type: 'count', n: r.n }).catch(() => {});
    return;
  }
  chrome.runtime.sendMessage({ type: 'captureNow', to: 'all' }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(d => { if (d.reason === 'install') chrome.tabs.create({ url: EDITOR + '?welcome=1' }); });
chrome.runtime.onStartup.addListener(async () => { await load(); badge(); });
