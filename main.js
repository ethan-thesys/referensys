// Referensys — Windows desktop app.
// While recording, every left click anywhere on screen tells the window to grab a screenshot
// at that instant; a helper then names what was clicked (via Windows UI Automation) for the step title.
// The window itself never talks to the internet; Google Drive saving lives in drive.js.
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, shell, session } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const drive = require('./drive');

let uIOhook = null;
try { ({ uIOhook } = require('uiohook-napi')); } catch (e) { console.error('Click listener failed to load:', e); }

// ---------- automatic updates ----------
// Checks github.com/ethan-thesys/referensys for a newer version, downloads it in the background,
// and installs it the next time Referensys closes. The updater uses its own connection; the app
// window itself stays blocked from the internet, and nothing from your recordings is ever sent.
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { console.error('Updater failed to load:', e); }
let updateReady = null;
function setupUpdates() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', info => {
    updateReady = info.version;
    if (win) win.webContents.send('update:ready', updateReady);
  });
  autoUpdater.on('error', err => console.error('Update check failed:', err && err.message));
  const check = () => { if (!recording) autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 5000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

let win = null, panel = null;
let recording = false, paused = false, seq = 0, hookStarted = false, screenText = true, count = 0;
const isWin = process.platform === 'win32';

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 380, minHeight: 500,
    title: 'Referensys', backgroundColor: '#eef2f3', show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.removeMenu();
  win.loadFile('index.html');
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.webContents.on('did-finish-load', () => { if (updateReady) win.webContents.send('update:ready', updateReady); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('closed', () => { win = null; if (panel) panel.destroy(); });
}

function createPanel() {
  panel = new BrowserWindow({
    width: 316, height: 64, frame: false, resizable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, fullscreenable: false,
    backgroundColor: '#10181c',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  panel.setAlwaysOnTop(true, 'screen-saver');
  panel.setContentProtection(true); // keeps the panel out of the screenshots
  panel.loadFile('panel.html');
  panel.on('closed', () => { panel = null; });
}
function placePanel() {
  const wa = screen.getPrimaryDisplay().workArea;
  panel.setPosition(Math.round(wa.x + wa.width - 336), Math.round(wa.y + 16));
}
const inside = (b, p) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;

// ---------- step titles from Windows UI Automation ----------
let ps = null, psWaiting = new Map();
function helperPath() {
  return path.join(__dirname, 'describe.ps1').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
}
function startHelper() {
  if (ps || !isWin) return;
  ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath()], { windowsHide: true });
  readline.createInterface({ input: ps.stdout }).on('line', line => {
    let info; try { info = JSON.parse(line); } catch (e) { return; }
    const w = psWaiting.get(String(info.id));
    if (w) { psWaiting.delete(String(info.id)); clearTimeout(w.t); w.resolve(info); }
  });
  ps.on('exit', () => { ps = null; for (const w of psWaiting.values()) { clearTimeout(w.t); w.resolve({}); } psWaiting.clear(); });
  ps.on('error', () => { ps = null; });
}
function lookup(id, phys, useText) {
  return new Promise(resolve => {
    if (!isWin) return resolve({});
    startHelper();
    if (!ps) return resolve({});
    const t = setTimeout(() => { psWaiting.delete(String(id)); resolve({}); }, 4000);
    psWaiting.set(String(id), { resolve, t });
    ps.stdin.write(`${id} ${Math.round(phys.x)} ${Math.round(phys.y)} ${useText ? 1 : 0}\n`);
  });
}
const quote = s => `“${String(s).replace(/\s+/g, ' ').trim().slice(0, 60)}”`;
// Labels that look like personal details (names as "Last, First", dates, long numbers, emails) are
// left out of titles and instructions, since those are plain text and can't be redacted like a screenshot.
const looksPersonal = s => /\d{3,}|\d{1,2}\/\d{1,2}\/\d{2,4}|@|^[A-Z][A-Za-z'’-]+,\s*[A-Z]/.test(s);
function parts(info) {
  const role = (info.role || '').replace('ControlType.', ''), label = (info.label || '').trim();
  return { role, safe: label && !looksPersonal(label) ? label : '', hidden: !!label && looksPersonal(label) };
}
function titleFor(info) {
  const { role, safe: label, hidden } = parts(info);
  if (label) {
    if (/^(Edit|ComboBox|Spinner)$/.test(role)) return `Click the ${quote(label)} field`;
    if (role === 'CheckBox') return `Check ${quote(label)}`;
    if (/^(RadioButton|TabItem|ListItem|TreeItem|DataItem)$/.test(role)) return `Select ${quote(label)}`;
    if (/^(MenuItem|MenuBar)$/.test(role)) return `Choose ${quote(label)}`;
    if (role === 'SplitButton') return `Open the ${quote(label)} menu`;
    if (role === 'Hyperlink') return `Click the ${quote(label)} link`;
    return `Click ${quote(label)}`;
  }
  if (hidden && /^(ListItem|TreeItem|DataItem)$/.test(role)) return 'Select the item in the list';
  if (hidden) return 'Click the highlighted item';
  if (role === 'Edit') return info.app ? `Click the text field in ${info.app}` : 'Click the text field';
  return info.app ? `Click in ${info.app}` : 'Click here';
}
// One or two sentences for the Instructions box, written from the same details as the title.
function instructionsFor(info) {
  const { role, safe, hidden } = parts(info), L = safe ? quote(safe) : '';
  let t;
  if (/^(Edit|ComboBox|Spinner)$/.test(role)) t = L ? `click in the ${L} field.` : 'click in the text field.';
  else if (role === 'CheckBox') t = L ? `tick the ${L} box.` : 'tick the highlighted box.';
  else if (role === 'RadioButton') t = L ? `select the ${L} option.` : 'select the highlighted option.';
  else if (role === 'TabItem') t = L ? `open the ${L} tab.` : 'open the highlighted tab.';
  else if (/^(ListItem|TreeItem|DataItem)$/.test(role)) t = L ? `select ${L} in the list.` : 'select the highlighted item in the list.';
  else if (/^(MenuItem|MenuBar)$/.test(role)) t = L ? `choose ${L} from the menu.` : 'choose the highlighted menu option.';
  else if (role === 'SplitButton') t = L ? `open the ${L} menu.` : 'open the highlighted menu.';
  else if (role === 'Hyperlink') t = L ? `click the ${L} link.` : 'click the highlighted link.';
  else if (role === 'Button') t = L ? `click the ${L} button.` : 'click the highlighted button.';
  else t = L ? `click ${L}.` : 'click the spot circled on the screenshot.';
  t = (info.app ? `In ${info.app}, ` : '') + t;
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

// ---------- the click listener ----------
function onMouseDown(e) {
  if (!recording || paused || e.button !== 1 || !win) return;
  const phys = { x: e.x, y: e.y };
  const p = isWin ? screen.screenToDipPoint(phys) : phys; // physical pixels -> layout units
  if (panel && panel.isVisible() && inside(panel.getBounds(), p)) return;
  if (win.isVisible() && !win.isMinimized() && inside(win.getBounds(), p)) return;
  const d = screen.getDisplayNearestPoint(p);
  const clickId = ++seq;
  win.webContents.send('rec:click', { clickId, displayId: String(d.id), x: p.x, y: p.y });
  lookup(clickId, phys, screenText).then(info => {
    if (!screenText) info.label = '';
    if (win) win.webContents.send('rec:label', { clickId, title: titleFor(info), text: instructionsFor(info), app: info.app || '' });
  });
}
function startHook() {
  if (hookStarted || !uIOhook) return;
  uIOhook.on('mousedown', onMouseDown);
  uIOhook.start();
  hookStarted = true;
}
function endRecording() {
  recording = false; paused = false;
  if (panel) panel.hide();
  if (win) { win.show(); win.focus(); }
}

// ---------- messages from the windows ----------
drive.register(ipcMain, () => win);
ipcMain.handle('perm', () => ({ screen: true, accessibility: true, hook: !!uIOhook, mac: false }));
ipcMain.handle('perm:ask', () => {});
ipcMain.handle('relaunch', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('version', () => app.getVersion());
ipcMain.handle('update:install', () => { if (autoUpdater && updateReady && !recording) autoUpdater.quitAndInstall(true, true); });
ipcMain.handle('displays', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  return screen.getAllDisplays().map((d, i) => {
    const src = sources.find(s => String(s.display_id) === String(d.id)) || sources[i] || sources[0];
    return { id: String(d.id), sourceId: src && src.id, bounds: d.bounds, scaleFactor: d.scaleFactor };
  }).filter(d => d.sourceId);
});
ipcMain.handle('rec:start', (_e, opts = {}) => {
  if (!uIOhook) throw new Error('The click listener could not load.');
  screenText = opts.screenText !== false;
  startHelper();
  startHook();
  recording = true; paused = false; count = 0;
  if (!panel) createPanel();
  placePanel();
  panel.webContents.send('panel:state', { count, paused });
  panel.showInactive();
  win.hide();
  return true;
});
ipcMain.handle('rec:stop', () => endRecording());
ipcMain.on('rec:count', (_e, n) => { count = n; if (panel) panel.webContents.send('panel:state', { count, paused }); });
ipcMain.on('panel:pause', () => {
  paused = !paused;
  if (panel) panel.webContents.send('panel:state', { count, paused });
  if (win) win.webContents.send('rec:pause', paused);
});
ipcMain.on('panel:done', () => { if (win) win.webContents.send('rec:stop'); else endRecording(); });

app.whenReady().then(() => {
  // No network access: block every request that isn't a local file or in-memory data.
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    cb({ cancel: !/^(file|data|blob|devtools):/.test(details.url) });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  createWindow();
  startHelper(); // warm up so the first step gets its title quickly
  setupUpdates();
});
app.on('window-all-closed', () => { if (panel) panel.destroy(); app.quit(); });
app.on('will-quit', () => {
  try { if (hookStarted) uIOhook.stop(); } catch (e) {}
  try { if (ps) ps.kill(); } catch (e) {}
});
