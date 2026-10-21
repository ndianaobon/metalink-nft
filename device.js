// Privacy-conscious device identification for multi-account detection.
//
// The website and the Android/iOS app (which loads the website) create one random token per
// install/browser on first launch (public/assets/device.js) and send it with every API call in the
// X-Device-Id header. Nothing about the hardware is read: no IMEI, advertising ID, MAC address or
// browser fingerprint. Clearing the app's data or the browser's site data produces a new token.
//
// The server never stores the token itself, only HMAC-SHA256(secret, token). The hash can still be
// compared between accounts (that's all detection needs), but a leaked database can't be used to
// recognise or impersonate a device elsewhere.
const crypto = require('crypto');

const DEVICE_HEADER = 'x-device-id';
const PLATFORM_HEADER = 'x-device-platform';
const PLATFORMS = new Set(['web', 'android', 'ios']);
// The client sends 32 hex characters; accept a little more range so a future client can change format.
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function readDeviceToken(req) {
  const raw = String(req.headers[DEVICE_HEADER] || '').trim();
  return TOKEN_RE.test(raw) ? raw : null;
}

// The client says which platform it is; the app also marks its user agent with "MetaLinkApp".
// Only the three known values are stored, so the column can't be used to smuggle arbitrary text.
function readPlatform(req) {
  const claimed = String(req.headers[PLATFORM_HEADER] || '').trim().toLowerCase();
  if (PLATFORMS.has(claimed)) return claimed;
  const ua = String(req.headers['user-agent'] || '');
  if (ua.indexOf('MetaLinkApp') !== -1) return /iPhone|iPad|iPod/.test(ua) ? 'ios' : 'android';
  return 'web';
}

function hashDeviceToken(token, secret) {
  if (!token || !secret) return null;
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

module.exports = { DEVICE_HEADER, PLATFORM_HEADER, PLATFORMS, readDeviceToken, readPlatform, hashDeviceToken };
