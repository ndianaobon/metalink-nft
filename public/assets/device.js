// Device token for multi-account detection (see device.js on the server).
// A random ID created on first visit and kept in this browser / app install. It reads nothing about
// the phone or computer (no hardware IDs, no fingerprinting) and is reset by clearing site/app data.
// Sent with API calls as X-Device-Id; the server stores only a keyed hash of it.
// ES5 only: this runs on old Android WebViews.
(function () {
  var KEY = 'mlk_device_id';
  var COOKIE = 'mlk_did';

  function valid(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(v); }

  function readCookie() {
    var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function writeCookie(v) {
    try {
      document.cookie = COOKIE + '=' + v + '; max-age=31536000; path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    } catch (e) {}
  }

  function generate() {
    var out = '', i, b;
    var c = window.crypto || window.msCrypto;
    var bytes = null;
    if (c && c.getRandomValues) { bytes = new Uint8Array(16); c.getRandomValues(bytes); }
    for (i = 0; i < 16; i++) {
      b = bytes ? bytes[i] : Math.floor(Math.random() * 256);
      out += (b < 16 ? '0' : '') + b.toString(16);
    }
    return out;
  }

  var id = null;
  try { id = localStorage.getItem(KEY); } catch (e) {}
  // The cookie is a backup for browsers that clear localStorage on their own.
  if (!valid(id)) id = readCookie();
  if (!valid(id)) id = generate();
  try { localStorage.setItem(KEY, id); } catch (e) {}
  writeCookie(id);

  var platform = 'web';
  try {
    if (window.Capacitor && window.Capacitor.getPlatform) platform = window.Capacitor.getPlatform();
  } catch (e) {}
  if (platform === 'web' && navigator.userAgent.indexOf('MetaLinkApp') !== -1) {
    platform = /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'ios' : 'android';
  }
  if (platform !== 'android' && platform !== 'ios') platform = 'web';

  window.MLK_DEVICE = { id: id, platform: platform };

  if (!window.fetch) return;
  var nativeFetch = window.fetch;

  function isApi(url) {
    if (typeof url !== 'string') return false;
    if (url.indexOf('/api/') === 0) return true;
    if (url.indexOf(location.origin + '/api/') === 0) return true;
    return !!window.MLK_SITE_URL && url.indexOf(window.MLK_SITE_URL + '/api/') === 0;
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url);
    if (isApi(url)) {
      var opts = {}, k;
      if (init) for (k in init) if (Object.prototype.hasOwnProperty.call(init, k)) opts[k] = init[k];
      var h = opts.headers;
      if (h && typeof Headers !== 'undefined' && h instanceof Headers) {
        h.set('X-Device-Id', id);
        h.set('X-Device-Platform', platform);
      } else {
        var headers = {};
        if (h) for (k in h) if (Object.prototype.hasOwnProperty.call(h, k)) headers[k] = h[k];
        headers['X-Device-Id'] = id;
        headers['X-Device-Platform'] = platform;
        opts.headers = headers;
      }
      init = opts;
    }
    return nativeFetch.call(window, input, init);
  };
})();
