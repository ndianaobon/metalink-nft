// Builds the bundled frontend for the mobile app: copies public/ into www/ (minus the admin panel)
// and injects a small script that sends API calls to the live server instead of the app's local origin.
const fs = require('fs');
const path = require('path');

const SITE_URL = process.env.MLK_SITE_URL || 'https://metalinknft.com';
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'www');
const EXCLUDE = new Set(['admin.html']);

const bridge = `<script>
  window.MLK_SITE_URL = ${JSON.stringify(SITE_URL)};
  (function () {
    var base = window.MLK_SITE_URL, nativeFetch = window.fetch.bind(window);
    var remote = function (u) { return typeof u === 'string' && (u.indexOf('/api/') === 0 || u.indexOf('/uploads/') === 0); };
    window.fetch = function (input, init) { return nativeFetch(remote(input) ? base + input : input, init); };
    // Avatars are assigned as img.src = '/uploads/...', which would otherwise resolve inside the app bundle.
    var srcProp = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get: srcProp.get,
      set: function (v) { srcProp.set.call(this, remote(v) ? base + v : v); }
    });
  })();
</script>`;

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true, filter: src => !EXCLUDE.has(path.basename(src)) });

for (const file of fs.readdirSync(OUT).filter(f => f.endsWith('.html'))) {
  const p = path.join(OUT, file);
  const html = fs.readFileSync(p, 'utf8').replace(/<head>/i, '<head>\n' + bridge);
  fs.writeFileSync(p, html);
}
console.log('Built www/ for ' + SITE_URL);
