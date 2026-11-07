// Builds www/, the screens the Android app shows: the shared editor (index.html) plus its libraries
// and android/web/bridge.js, which connects the editor to Android. Run before `npx cap sync android`.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const www = path.join(root, 'www');
fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(path.join(www, 'lib'), { recursive: true });

const copy = (from, to) => fs.copyFileSync(path.join(root, from), path.join(www, to));
copy('node_modules/html2canvas/dist/html2canvas.min.js', 'lib/html2canvas.min.js');
copy('node_modules/jspdf/dist/jspdf.umd.min.js', 'lib/jspdf.umd.min.js');
copy('node_modules/pdf-lib/dist/pdf-lib.min.js', 'lib/pdf-lib.min.js');
copy('node_modules/@capacitor/core/dist/capacitor.js', 'capacitor.js');
copy('android/web/bridge.js', 'bridge.js');

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const swap = (a, b) => { if (!html.includes(a)) throw new Error('index.html changed; update build-android-web.js: ' + a); html = html.replace(a, b); };
// The Android app talks to Google Drive and GitHub directly, so it needs a wider connection policy than the Windows window.
swap(/<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(html)[0],
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self' https://localhost capacitor://localhost; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src blob:; connect-src 'self' data: blob: https://www.googleapis.com https://oauth2.googleapis.com https://api.github.com; font-src 'self' data:">`);
swap('<script src="node_modules/html2canvas/dist/html2canvas.min.js"></script>', '<script src="lib/html2canvas.min.js"></script>');
swap('<script src="node_modules/jspdf/dist/jspdf.umd.min.js"></script>',
  '<script src="lib/jspdf.umd.min.js"></script>\n<script src="lib/pdf-lib.min.js"></script>\n<script src="capacitor.js"></script>\n<script src="bridge.js"></script>');
fs.writeFileSync(path.join(www, 'index.html'), html);
console.log('Built www/ for Android');
