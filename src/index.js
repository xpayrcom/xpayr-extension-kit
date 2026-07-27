/**
 * @xpayr/extension-kit — crypto-native licensing for browser extensions.
 *
 * The license is the paying wallet: no email, no license key, no account.
 * Tokens are ES256 (ECDSA P-256) JWTs verified offline with WebCrypto, so
 * getUser() answers instantly and keeps working without a network.
 *
 * MV3 manifest requirements:
 *   "permissions": ["storage", "alarms"]
 *   "externally_connectable": { "matches": ["https://xpayr.com/*"] }   // optional but instant
 *
 * No host_permissions needed — no scary install warning.
 */

var DEFAULT_BASE_URL = 'https://xpayr.com';
var STORAGE_KEY = 'xpayr_license_state';
var ALARM_NAME = 'xpayr_license_refresh';
var REFRESH_INTERVAL_MINUTES = 1440;        // 24h
var REFRESH_BEFORE_EXPIRY_SECONDS = 172800; // start renewing 48h before exp
var OFFLINE_GRACE_SECONDS = 2592000;        // 30 days
var CLOCK_SKEW_SECONDS = 300;
var TICKET_POLL_INTERVAL_MS = 3000;
var TICKET_POLL_TIMEOUT_MS = 900000;        // 15 min

/* ------------------------------------------------------------------ utils */

function runtime() {
  if (typeof chrome !== 'undefined' && chrome.runtime) return chrome;
  if (typeof browser !== 'undefined' && browser.runtime) return browser;
  return null;
}

function storageGet(key) {
  var api = runtime();
  return new Promise(function (resolve) {
    if (!api || !api.storage || !api.storage.local) return resolve(null);
    try {
      var result = api.storage.local.get(key, function (items) {
        void (api.runtime.lastError);
        resolve(items ? items[key] : null);
      });
      if (result && typeof result.then === 'function') {
        result.then(function (items) { resolve(items ? items[key] : null); }, function () { resolve(null); });
      }
    } catch (e) { resolve(null); }
  });
}

function storageSet(key, value) {
  var api = runtime();
  return new Promise(function (resolve) {
    if (!api || !api.storage || !api.storage.local) return resolve(false);
    var payload = {};
    payload[key] = value;
    try {
      var result = api.storage.local.set(payload, function () {
        void (api.runtime.lastError);
        resolve(true);
      });
      if (result && typeof result.then === 'function') result.then(function () { resolve(true); }, function () { resolve(false); });
    } catch (e) { resolve(false); }
  });
}

function b64urlToBytes(value) {
  var padded = value.replace(/-/g, '+').replace(/_/g, '/');
  var binary = atob(padded + '==='.slice((padded.length + 3) % 4));
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment) {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));
  } catch (e) {
    return null;
  }
}

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  var bytes = new Uint8Array(16);
  (typeof crypto !== 'undefined' ? crypto : { getRandomValues: function (b) { for (var i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); } }).getRandomValues(bytes);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/* ------------------------------------------------------------------- core */

function XPayrKit(productCode, options) {
  if (!(this instanceof XPayrKit)) return new XPayrKit(productCode, options);
  if (!productCode || typeof productCode !== 'string') {
    throw new Error('XPayrKit requires a product code, e.g. XPayrKit("prod_my_extension")');
  }
  options = options || {};
  this.productCode = productCode;
  this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  this.apiUrl = this.baseUrl + '/api/v1/index.php';
  this.debug = !!options.debug;
  this._keyPromise = null;
  this._listeners = [];
  this._plansCache = null;

  var self = this;
  this.onLicenseChanged = {
    addListener: function (fn) { if (typeof fn === 'function') self._listeners.push(fn); },
    removeListener: function (fn) { self._listeners = self._listeners.filter(function (l) { return l !== fn; }); }
  };
}

XPayrKit.prototype._log = function () {
  if (this.debug && typeof console !== 'undefined') {
    console.log.apply(console, ['[xpayr]'].concat(Array.prototype.slice.call(arguments)));
  }
};

XPayrKit.prototype._emit = function (user) {
  this._listeners.forEach(function (fn) {
    try { fn(user); } catch (e) { /* listener errors are not ours to swallow loudly */ }
  });
};

XPayrKit.prototype._state = function () {
  var self = this;
  return storageGet(STORAGE_KEY).then(function (state) {
    if (state && state.productCode === self.productCode) return state;
    return { productCode: self.productCode, token: null, user: null, lastVerifiedAt: null, installId: uuid() };
  });
};

XPayrKit.prototype._saveState = function (state) {
  return storageSet(STORAGE_KEY, state).then(function () { return state; });
};

/** Public signing key, fetched once per session from JWKS. */
XPayrKit.prototype._publicKey = function () {
  var self = this;
  if (this._keyPromise) return this._keyPromise;
  this._keyPromise = fetch(this.apiUrl + '/licenses/jwks')
    .then(function (r) { return r.json(); })
    .then(function (jwks) {
      var jwk = jwks && jwks.keys && jwks.keys[0];
      if (!jwk) throw new Error('no signing key');
      return crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );
    })
    .catch(function (error) {
      self._keyPromise = null; // allow retry on next call
      throw error;
    });
  return this._keyPromise;
};

/** Verify a token offline. Returns claims or null. */
XPayrKit.prototype._verify = function (token) {
  var self = this;
  if (!token || typeof token !== 'string') return Promise.resolve(null);
  var parts = token.split('.');
  if (parts.length !== 3) return Promise.resolve(null);

  var header = decodeJson(parts[0]);
  if (!header || header.alg !== 'ES256') return Promise.resolve(null);

  return this._publicKey().then(function (key) {
    var data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlToBytes(parts[2]), data);
  }).then(function (valid) {
    if (!valid) return null;
    var claims = decodeJson(parts[1]);
    if (!claims) return null;
    if (claims.aud !== self.productCode) return null;
    var now = Math.floor(Date.now() / 1000);
    if (claims.iat && claims.iat > now + CLOCK_SKEW_SECONDS) return null;
    return claims;
  }).catch(function () { return null; });
};

function userFromClaims(claims, source, staleSince) {
  return {
    licensed: true,
    plan: claims.plan || null,
    wallet: claims.sub || null,
    paidAt: null,
    expiresAt: claims.lexp ? new Date(claims.lexp * 1000) : null,
    source: source,
    staleSince: staleSince || null
  };
}

function lockedUser(source) {
  return { licensed: false, plan: null, wallet: null, paidAt: null, expiresAt: null, source: source, staleSince: null };
}

/**
 * Current licence state. Answers from the local token immediately;
 * refreshes in the background when the token is near expiry.
 */
XPayrKit.prototype.getUser = function () {
  var self = this;
  return this._state().then(function (state) {
    if (!state.token) return lockedUser('cache');

    return self._verify(state.token).then(function (claims) {
      var now = Math.floor(Date.now() / 1000);

      if (claims) {
        // License-level expiry (prepaid plans) is authoritative over token expiry.
        if (claims.lexp && claims.lexp < now) return lockedUser('cache');

        if (claims.exp && claims.exp - now < REFRESH_BEFORE_EXPIRY_SECONDS) {
          self.refresh().catch(function () { /* stay on cache */ });
        }
        if (claims.exp && claims.exp > now) {
          return userFromClaims(claims, 'cache');
        }
        // Signature is good but the token aged out: allow offline grace.
        var anchor = state.lastVerifiedAt || (claims.iat * 1000);
        if (Date.now() - anchor < OFFLINE_GRACE_SECONDS * 1000) {
          self.refresh().catch(function () {});
          return userFromClaims(claims, 'cache', new Date(claims.exp * 1000));
        }
        return lockedUser('cache');
      }

      // Could not verify (e.g. offline before the key was ever fetched):
      // fall back to the cached user object inside the grace window.
      if (state.user && state.lastVerifiedAt && Date.now() - state.lastVerifiedAt < OFFLINE_GRACE_SECONDS * 1000) {
        var cached = Object.assign({}, state.user, { source: 'cache', staleSince: new Date(state.lastVerifiedAt) });
        return cached;
      }
      return lockedUser('cache');
    });
  });
};

/** Force an online revalidation. Drops the license if it was revoked. */
XPayrKit.prototype.refresh = function () {
  var self = this;
  return this._state().then(function (state) {
    if (!state.token) return lockedUser('network');

    return fetch(self.apiUrl + '/licenses/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: state.token })
    }).then(function (response) {
      return response.json().then(function (body) { return { status: response.status, body: body }; });
    }).then(function (res) {
      if (res.status === 200 && res.body && res.body.token) {
        return self._applyToken(res.body.token, res.body.user, 'network');
      }
      var code = res.body && res.body.error && res.body.error.code;
      if (code === 'license_revoked' || code === 'license_expired' || code === 'invalid_token') {
        self._log('license no longer valid:', code);
        state.token = null;
        state.user = null;
        state.lastVerifiedAt = null;
        return self._saveState(state).then(function () {
          var locked = lockedUser('network');
          self._emit(locked);
          return locked;
        });
      }
      // Transient failure (5xx, rate limit): keep the cached license.
      return self.getUser();
    }).catch(function () {
      return self.getUser();
    });
  });
};

XPayrKit.prototype._applyToken = function (token, apiUser, source) {
  var self = this;
  return this._verify(token).then(function (claims) {
    if (!claims) return lockedUser(source);
    return self._state().then(function (state) {
      state.token = token;
      state.lastVerifiedAt = Date.now();
      state.user = userFromClaims(claims, source);
      if (apiUser && apiUser.paid_at) state.user.paidAt = new Date(apiUser.paid_at);
      return self._saveState(state).then(function () {
        self._emit(state.user);
        return state.user;
      });
    });
  });
};

/** Public product info (price, plan, allowed networks). */
XPayrKit.prototype.getPlans = function () {
  var self = this;
  if (this._plansCache) return Promise.resolve(this._plansCache);
  return fetch(this.apiUrl + '/licenses/products/' + encodeURIComponent(this.productCode))
    .then(function (r) { return r.json(); })
    .then(function (body) {
      if (!body || body.error) throw new Error('product unavailable');
      self._plansCache = body;
      return body;
    });
};

XPayrKit.prototype._openTab = function (url) {
  var api = runtime();
  if (api && api.tabs && api.tabs.create) {
    api.tabs.create({ url: url });
  } else if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener');
  }
};

XPayrKit.prototype._buyUrl = function (extra) {
  var self = this;
  return this._state().then(function (state) {
    var api = runtime();
    var extensionId = api && api.runtime && api.runtime.id ? api.runtime.id : '';
    var url = self.baseUrl + '/buy/' + encodeURIComponent(self.productCode)
      + '?install=' + encodeURIComponent(state.installId)
      + (extensionId ? '&ext=' + encodeURIComponent(extensionId) : '')
      + (extra || '');
    return { url: url, installId: state.installId };
  });
};

/** Open the hosted checkout in a new tab. */
XPayrKit.prototype.openCheckout = function () {
  var self = this;
  return this._buyUrl('').then(function (info) {
    self._openTab(info.url);
    self._pollTicket(info.installId);
    return info.url;
  });
};

/** "I already bought this" — unlock on another device with a signature. */
XPayrKit.prototype.openRestore = function () {
  var self = this;
  return this._buyUrl('&restore=1').then(function (info) {
    self._openTab(info.url);
    self._pollTicket(info.installId);
    return info.url;
  });
};

/**
 * Fallback delivery: poll the single-use ticket the claim endpoint stored.
 * Used when the extension has no externally_connectable entry (or messaging fails).
 */
XPayrKit.prototype._pollTicket = function (installId) {
  var self = this;
  if (this._pollTimer) return;
  var startedAt = Date.now();

  function tick() {
    if (Date.now() - startedAt > TICKET_POLL_TIMEOUT_MS) {
      clearInterval(self._pollTimer);
      self._pollTimer = null;
      return;
    }
    fetch(self.apiUrl + '/licenses/claim-ticket/' + encodeURIComponent(installId))
      .then(function (r) { return r.status === 200 ? r.json() : null; })
      .then(function (body) {
        if (body && body.token) {
          clearInterval(self._pollTimer);
          self._pollTimer = null;
          return self._applyToken(body.token, null, 'network');
        }
      })
      .catch(function () { /* keep polling */ });
  }

  this._pollTimer = setInterval(tick, TICKET_POLL_INTERVAL_MS);
  tick();
};

/**
 * Call once in the background script / service worker.
 * Wires the daily refresh alarm and the checkout page's direct token delivery.
 */
XPayrKit.prototype.startBackground = function () {
  var self = this;
  var api = runtime();
  if (!api) return;

  if (api.runtime.onMessageExternal) {
    api.runtime.onMessageExternal.addListener(function (message, sender, sendResponse) {
      var origin = sender && sender.url ? sender.url : '';
      if (origin.indexOf(self.baseUrl) !== 0) return;
      if (!message || message.type !== 'xpayr:license' || !message.token) return;
      self._applyToken(message.token, message.user, 'network').then(function (user) {
        if (typeof sendResponse === 'function') sendResponse({ ok: !!user.licensed });
      });
      return true;
    });
  }

  if (api.alarms) {
    api.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_INTERVAL_MINUTES });
    api.alarms.onAlarm.addListener(function (alarm) {
      if (alarm && alarm.name === ALARM_NAME) self.refresh().catch(function () {});
    });
  }

  // Ensure an install id exists from the very first run.
  this._state().then(function (state) { return self._saveState(state); });
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = XPayrKit;
  module.exports.default = XPayrKit;
}
if (typeof window !== 'undefined') {
  window.XPayrKit = XPayrKit;
}
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.XPayrKit = XPayrKit;
}
