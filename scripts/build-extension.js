// Builds the Chrome extension into dist-extension/:
//   Referensys/                          the folder to use with "Load unpacked"
//   Referensys-Extension-<version>.zip   the same folder, zipped, for the GitHub release
// The editor is the shared index.html. Chrome extensions can't run scripts written inside the page,
// so its script is moved into editor.js here.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const outRoot = path.join(root, 'dist-extension');
const out = path.join(outRoot, 'Referensys');
fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'lib'), { recursive: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });

const copy = (from, to) => fs.copyFileSync(path.join(root, from), path.join(out, to));
copy('node_modules/html2canvas/dist/html2canvas.min.js', 'lib/html2canvas.min.js');
copy('node_modules/jspdf/dist/jspdf.umd.min.js', 'lib/jspdf.umd.min.js');
copy('node_modules/pdf-lib/dist/pdf-lib.min.js', 'lib/pdf-lib.min.js');
copy('web/core.js', 'core.js');
for (const f of ['sw.js', 'idb.js', 'content.js', 'auth.js', 'bridge.js', 'tick.js', 'popup.html', 'popup.css', 'popup.js']) copy('extension/' + f, f);
for (const n of [16, 32, 48, 128]) copy(`extension/icons/${n}.png`, `icons/${n}.png`);

// The Google sign-in key for the extension isn't secret (it only works from this extension's address).
let clientId = process.env.GOOGLE_EXT_CLIENT_ID || '';
const idFile = path.join(root, 'extension', 'google-client-id.txt');
if (!clientId && fs.existsSync(idFile)) clientId = fs.readFileSync(idFile, 'utf8').trim();
fs.writeFileSync(path.join(out, 'google-client.js'), `window.REFERENSYS_GOOGLE_CLIENT_ID = ${JSON.stringify(clientId)};\n`);

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
manifest.version = pkg.version.replace(/-.*$/, '');
// Keeps the extension's ID the same on every computer, so Google sign-in recognises it.
manifest.key = fs.readFileSync(path.join(root, 'extension', 'public-key.txt'), 'utf8').trim();
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const swap = (a, b) => { if (!html.includes(a)) throw new Error('index.html changed; update build-extension.js: ' + a); html = html.replace(a, b); };
swap(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/.exec(html)[0], '');
const start = html.indexOf('<script>\n'), end = html.indexOf('</script>', start);
if (start < 0 || html.indexOf('<script>', end) >= 0) throw new Error('index.html should have exactly one inline script');
fs.writeFileSync(path.join(out, 'editor.js'), html.slice(start + '<script>\n'.length, end));
html = html.slice(0, start) + '<script src="editor.js"></script>' + html.slice(end + '</script>'.length);
swap('<script src="node_modules/html2canvas/dist/html2canvas.min.js"></script>', '<script src="lib/html2canvas.min.js"></script>');
swap('<script src="node_modules/jspdf/dist/jspdf.umd.min.js"></script>',
  ['lib/jspdf.umd.min.js', 'lib/pdf-lib.min.js', 'core.js', 'google-client.js', 'idb.js', 'auth.js', 'bridge.js'].map(s => `<script src="${s}"></script>`).join('\n'));
if (/\son[a-z]+="/i.test(html)) throw new Error('index.html has inline event handlers, which Chrome extensions block');
fs.writeFileSync(path.join(out, 'editor.html'), html);

const zip = path.join(outRoot, `Referensys-Extension-${manifest.version}.zip`);
execFileSync('zip', ['-qr', zip, 'Referensys'], { cwd: outRoot });
console.log('Built the extension:', out, '\n                    ', zip, clientId ? '' : '\n  (no Google sign-in key yet: saving to Drive is switched off)');
