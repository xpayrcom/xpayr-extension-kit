'use strict';

/**
 * @xpayr/extension-kit test suite.
 * Runs the real SDK against a fake chrome.* API, a fake fetch, and REAL ES256
 * tokens minted with WebCrypto — so signature verification, cache behaviour,
 * offline grace and revocation are all exercised for real.
 *
 * Run: node test/kit.test.js
 */

const { webcrypto } = require('crypto');
const assert = require('assert');

// Node >=20 exposes a getter-only global.crypto; redefine it so the SDK sees
// the same WebCrypto surface a browser/service worker would.
if (!global.crypto || !global.crypto.subtle) {
  Object.defineProperty(global, 'crypto', { value: webcrypto, configurable: true, writable: true });
}
global.atob = s => Buffer.from(s, 'base64').toString('binary');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  [PASS] ' + name); }
  else { failed++; console.log('  [FAIL] ' + name + (detail ? ' -- ' + detail : '')); }
}

/* ------------------------------------------------------------ key + tokens */

let signingKey, jwk;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mintToken(claims, overrides = {}) {
  const header = { typ: 'JWT', alg: 'ES256', kid: 'test-key' };
  const now = Math.floor(Date.now() / 1000);
  const payload = Object.assign({
    iss: 'https://xpayr.com',
    iat: now,
    exp: now + 604800,
    sub: '0xabc0000000000000000000000000000000000def',
    aud: 'prod_test',
    lic: 'lic_' + '0'.repeat(32),
    plan: 'lifetime',
    lexp: null
  }, claims, overrides);
  const input = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey.privateKey,
    new TextEncoder().encode(input)
  );
  return input + '.' + b64url(new Uint8Array(sig));
}

/* --------------------------------------------------------- fake extension */

function makeChrome() {
  const store = {};
  const alarms = [];
  const externalListeners = [];
  const tabs = [];
  return {
    _store: store, _alarms: alarms, _tabs: tabs,
    _fireExternal: (msg, sender) => externalListeners.forEach(l => l(msg, sender, () => {})),
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      lastError: null,
      onMessageExternal: { addListener: fn => externalListeners.push(fn) }
    },
    storage: {
      local: {
        get: (key, cb) => cb({ [key]: store[key] }),
        set: (obj, cb) => { Object.assign(store, obj); cb(); }
      }
    },
    alarms: {
      create: (name, opts) => alarms.push({ name, opts }),
      onAlarm: { addListener: () => {} }
    },
    tabs: { create: ({ url }) => tabs.push(url) }
  };
}

function makeFetch(routes) {
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url, init });
    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) {
        const res = handler(url, init);
        return Promise.resolve({
          status: res.status,
          json: () => Promise.resolve(res.body)
        });
      }
    }
    return Promise.reject(new Error('no route for ' + url));
  };
  fn.calls = calls;
  return fn;
}

function jwksRoute() {
  return ['/licenses/jwks', () => ({ status: 200, body: { keys: [jwk] } })];
}

function freshKit(fetchImpl) {
  delete require.cache[require.resolve('../src/index.js')];
  global.chrome = makeChrome();
  global.fetch = fetchImpl;
  const XPayrKit = require('../src/index.js');
  return { XPayrKit, chrome: global.chrome };
}

/* ------------------------------------------------------------------ tests */

(async () => {
  signingKey = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  jwk = await webcrypto.subtle.exportKey('jwk', signingKey.publicKey);
  delete jwk.key_ops; delete jwk.ext;

  console.log('Construction:');
  {
    const { XPayrKit } = freshKit(makeFetch([jwksRoute()]));
    check('requires a product code', (() => { try { XPayrKit(); return false; } catch (e) { return true; } })());
    const kit = XPayrKit('prod_test');
    check('works without new', typeof kit.getUser === 'function');
    check('default base url', kit.baseUrl === 'https://xpayr.com');
    check('custom base url', XPayrKit('prod_test', { baseUrl: 'https://staging.xpayr.com/' }).baseUrl === 'https://staging.xpayr.com');
  }

  console.log('Locked by default:');
  {
    const { XPayrKit } = freshKit(makeFetch([jwksRoute()]));
    const user = await XPayrKit('prod_test').getUser();
    check('licensed=false with no token', user.licensed === false);
    check('wallet null', user.wallet === null);
    check('no network call needed', global.fetch.calls.length === 0);
  }

  console.log('Token delivery via externally_connectable:');
  {
    const token = await mintToken({});
    const { XPayrKit, chrome } = freshKit(makeFetch([jwksRoute()]));
    const kit = XPayrKit('prod_test');
    let events = 0;
    kit.onLicenseChanged.addListener(() => events++);
    kit.startBackground();
    check('alarm registered', chrome._alarms.length === 1 && chrome._alarms[0].opts.periodInMinutes === 1440);

    chrome._fireExternal({ type: 'xpayr:license', token }, { url: 'https://xpayr.com/buy/prod_test' });
    await new Promise(r => setTimeout(r, 60));

    const user = await kit.getUser();
    check('licensed after delivery', user.licensed === true);
    check('wallet from sub claim', user.wallet === '0xabc0000000000000000000000000000000000def');
    check('plan surfaced', user.plan === 'lifetime');
    check('onLicenseChanged fired', events === 1);
    check('state persisted', !!chrome._store.xpayr_license_state.token);
  }

  console.log('Message origin enforcement:');
  {
    const token = await mintToken({});
    const { XPayrKit, chrome } = freshKit(makeFetch([jwksRoute()]));
    const kit = XPayrKit('prod_test');
    kit.startBackground();
    chrome._fireExternal({ type: 'xpayr:license', token }, { url: 'https://evil.example.com/x' });
    await new Promise(r => setTimeout(r, 60));
    check('token from foreign origin ignored', (await kit.getUser()).licensed === false);
  }

  console.log('Signature enforcement:');
  {
    const good = await mintToken({});
    const parts = good.split('.');
    const tampered = parts[0] + '.' + b64url(JSON.stringify({
      iss: 'https://xpayr.com', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 604800,
      sub: '0xdead', aud: 'prod_test', lic: 'lic_' + '0'.repeat(32), plan: 'lifetime', lexp: null
    })) + '.' + parts[2];

    const { XPayrKit, chrome } = freshKit(makeFetch([jwksRoute()]));
    const kit = XPayrKit('prod_test');
    kit.startBackground();
    chrome._fireExternal({ type: 'xpayr:license', token: tampered }, { url: 'https://xpayr.com/buy/prod_test' });
    await new Promise(r => setTimeout(r, 60));
    check('tampered token rejected', (await kit.getUser()).licensed === false);
  }

  console.log('Audience binding:');
  {
    const otherProduct = await mintToken({ aud: 'prod_someone_else' });
    const { XPayrKit, chrome } = freshKit(makeFetch([jwksRoute()]));
    const kit = XPayrKit('prod_test');
    kit.startBackground();
    chrome._fireExternal({ type: 'xpayr:license', token: otherProduct }, { url: 'https://xpayr.com/buy/x' });
    await new Promise(r => setTimeout(r, 60));
    check('token for another product rejected', (await kit.getUser()).licensed === false);
  }

  console.log('Offline grace:');
  {
    const now = Math.floor(Date.now() / 1000);
    const expired = await mintToken({ iat: now - 900000, exp: now - 300000 }); // expired ~3.5 days ago
    const { XPayrKit, chrome } = freshKit(makeFetch([
      jwksRoute(),
      ['/licenses/refresh', () => { throw new Error('offline'); }]
    ]));
    const kit = XPayrKit('prod_test');
    chrome._store.xpayr_license_state = {
      productCode: 'prod_test', token: expired, user: null,
      lastVerifiedAt: Date.now() - 300000 * 1000, installId: 'test-install'
    };
    const user = await kit.getUser();
    check('still licensed inside 30-day grace', user.licensed === true);
    check('staleSince flagged', user.staleSince instanceof Date);
  }

  console.log('Grace expiry:');
  {
    const now = Math.floor(Date.now() / 1000);
    const ancient = await mintToken({ iat: now - 9000000, exp: now - 8000000 }); // ~92 days ago
    const { XPayrKit, chrome } = freshKit(makeFetch([
      jwksRoute(),
      ['/licenses/refresh', () => { throw new Error('offline'); }]
    ]));
    const kit = XPayrKit('prod_test');
    chrome._store.xpayr_license_state = {
      productCode: 'prod_test', token: ancient, user: null,
      lastVerifiedAt: Date.now() - 8000000 * 1000, installId: 'test-install'
    };
    check('locked after grace window', (await kit.getUser()).licensed === false);
  }

  console.log('License-level expiry (prepaid plans):');
  {
    const now = Math.floor(Date.now() / 1000);
    const lapsed = await mintToken({ plan: 'prepaid_year', lexp: now - 10 });
    const { XPayrKit, chrome } = freshKit(makeFetch([jwksRoute()]));
    const kit = XPayrKit('prod_test');
    chrome._store.xpayr_license_state = {
      productCode: 'prod_test', token: lapsed, user: null, lastVerifiedAt: Date.now(), installId: 'i'
    };
    check('lapsed prepaid license locks out', (await kit.getUser()).licensed === false);
  }

  console.log('Revocation via refresh:');
  {
    const token = await mintToken({});
    const { XPayrKit, chrome } = freshKit(makeFetch([
      jwksRoute(),
      ['/licenses/refresh', () => ({ status: 403, body: { error: { code: 'license_revoked', message: 'revoked' } } })]
    ]));
    const kit = XPayrKit('prod_test');
    let lastEvent = null;
    kit.onLicenseChanged.addListener(u => { lastEvent = u; });
    chrome._store.xpayr_license_state = {
      productCode: 'prod_test', token, user: null, lastVerifiedAt: Date.now(), installId: 'i'
    };
    check('licensed before revoke', (await kit.getUser()).licensed === true);
    const after = await kit.refresh();
    check('refresh reports locked', after.licensed === false);
    check('token dropped from storage', chrome._store.xpayr_license_state.token === null);
    check('change event emitted', lastEvent && lastEvent.licensed === false);
  }

  console.log('Transient failure keeps license:');
  {
    const token = await mintToken({});
    const { XPayrKit, chrome } = freshKit(makeFetch([
      jwksRoute(),
      ['/licenses/refresh', () => ({ status: 503, body: { error: { code: 'service_unavailable' } } })]
    ]));
    const kit = XPayrKit('prod_test');
    chrome._store.xpayr_license_state = {
      productCode: 'prod_test', token, user: null, lastVerifiedAt: Date.now(), installId: 'i'
    };
    const after = await kit.refresh();
    check('5xx does not lock the user out', after.licensed === true);
    check('token retained', !!chrome._store.xpayr_license_state.token);
  }

  console.log('Checkout + restore:');
  {
    const { XPayrKit, chrome } = freshKit(makeFetch([
      jwksRoute(),
      ['/licenses/claim-ticket/', () => ({ status: 404, body: {} })]
    ]));
    const kit = XPayrKit('prod_test');
    const url = await kit.openCheckout();
    check('checkout tab opened', chrome._tabs.length === 1);
    check('url targets buy page', url.indexOf('https://xpayr.com/buy/prod_test?') === 0);
    check('carries install id', /install=[a-z0-9-]+/i.test(url));
    check('carries extension id', url.indexOf('ext=abcdefghijklmnopabcdefghijklmnop') !== -1);
    const restoreUrl = await kit.openRestore();
    check('restore flag set', restoreUrl.indexOf('restore=1') !== -1);
    if (kit._pollTimer) clearInterval(kit._pollTimer);
  }

  console.log('Ticket fallback delivery:');
  {
    const token = await mintToken({});
    let served = false;
    const { XPayrKit } = freshKit(makeFetch([
      jwksRoute(),
      ['/licenses/claim-ticket/', () => {
        if (served) return { status: 404, body: {} };
        served = true;
        return { status: 200, body: { object: 'license_ticket', token } };
      }]
    ]));
    const kit = XPayrKit('prod_test');
    await kit.openCheckout();
    await new Promise(r => setTimeout(r, 200));
    check('token picked up from ticket', (await kit.getUser()).licensed === true);
    if (kit._pollTimer) clearInterval(kit._pollTimer);
  }

  console.log('getPlans:');
  {
    const { XPayrKit } = freshKit(makeFetch([
      jwksRoute(),
      ['/licenses/products/', () => ({ status: 200, body: { object: 'license_product', product_code: 'prod_test', name: 'Test', plan_type: 'lifetime', price_usd: '14.00', allowed_networks: null } })]
    ]));
    const kit = XPayrKit('prod_test');
    const plan = await kit.getPlans();
    check('plan fetched', plan.price_usd === '14.00');
    const before = global.fetch.calls.length;
    await kit.getPlans();
    check('plan cached (no second call)', global.fetch.calls.length === before);
  }

  console.log('\nResult: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});
