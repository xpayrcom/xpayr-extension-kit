<div align="center">
  <a href="https://xpayr.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://xpayr.com/public/images/xpayr-logo-white.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://xpayr.com/public/images/xpayr-logo-black.png" />
      <img src="https://xpayr.com/public/images/xpayr-logo-white.png" alt="XPayr Official Logo" width="220" />
    </picture>
  </a>
  <p>
    <a href="https://xpayr.com"><img src="https://xpayr.com/partner-badge.php?type=powered_by&theme=dark" alt="Powered by XPayr" height="28" /></a>
    <a href="https://mcp.xpayr.com"><img src="https://img.shields.io/badge/MCP_Portal-mcp.xpayr.com-029bfd?style=for-the-badge" alt="XPayr MCP Portal" height="28" /></a>
    <a href="https://docs.xpayr.com"><img src="https://img.shields.io/badge/Docs-docs.xpayr.com-10b981?style=for-the-badge" alt="XPayr Docs" height="28" /></a>
    <a href="https://www.npmjs.com/package/@xpayr/mcp-server"><img src="https://img.shields.io/npm/v/@xpayr/mcp-server?style=for-the-badge&color=cb3837&label=MCP%20NPM" alt="NPM @xpayr/mcp-server" height="28" /></a>
  </p>
  <p>
    <a href="https://xpayr.com"><b>Official Website</b></a> •
    <a href="https://mcp.xpayr.com"><b>AI &amp; MCP Portal (21 Tools)</b></a> •
    <a href="https://docs.xpayr.com"><b>Developer Docs</b></a> •
    <a href="https://xpayr.com/developers"><b>Developer Hub</b></a> •
    <a href="https://xpayr.com/tools/crypto-payment-fee-calculator"><b>0.5% Fee Calculator</b></a>
  </p>
</div>

---

# @xpayr/extension-kit

Crypto-native licensing for browser extensions. **The license is the paying wallet** — no email, no license keys, no accounts, no chargebacks.

```js
const xpayr = XPayrKit('prod_my_extension');

const user = await xpayr.getUser();
if (user.licensed) {
  unlockProFeatures();
} else {
  xpayr.openCheckout();
}
```

## Why this exists

Chrome Web Store payments shut down in February 2021. Every extension developer now needs an external payment layer, and the leading option requires a Stripe account — which excludes developers in Turkey, Pakistan, Nigeria, Bangladesh, Indonesia, Egypt and many other countries entirely.

Crypto payment gateways stop at "payment received". They give you a webhook, not a license: no entitlement store, no SDK, no cross-device verification. You end up building the hard half yourself.

This kit is the missing half.

|  | ExtensionPay | Paddle / Lemon Squeezy | Crypto gateways | **XPayr Kit** |
|---|---|---|---|---|
| Fee | 5% + Stripe's 2.9%+30¢ | 5% + 50¢ | 0.5–1% | **2.9% flat** |
| Works without Stripe | ❌ | ⚠️ | ✅ | ✅ |
| Entitlement/licensing layer | ✅ | ⚠️ partial | ❌ | ✅ |
| Chargebacks | yes | yes | none | none |
| Merchant of record (tax) | ❌ | ✅ | ❌ | ❌ |

First **$300** of sales are free.

## Install

```bash
npm install @xpayr/extension-kit
```

Or copy `src/index.js` into your extension — it has zero dependencies and no build step.

## Manifest (MV3)

```json
{
  "permissions": ["storage", "alarms"],
  "externally_connectable": { "matches": ["https://xpayr.com/*"] }
}
```

No `host_permissions`, so installing your extension shows **no scary permission warning**. `externally_connectable` makes unlock instant; without it the SDK falls back to a short polling window, so it still works.

## Background script

```js
import XPayrKit from '@xpayr/extension-kit';

const xpayr = XPayrKit('prod_my_extension');
xpayr.startBackground();   // required — wires token delivery + daily refresh

xpayr.onLicenseChanged.addListener(user => {
  console.log(user.licensed ? 'unlocked' : 'locked');
});
```

## API

| Method | Description |
|---|---|
| `getUser()` | Offline-first license check. Verifies the cached ES256 token locally, so it returns in ~0 ms and works with no network. |
| `openCheckout()` | Opens the hosted checkout in a new tab. Buyer picks any supported network/token. |
| `openRestore()` | "I already bought this" — unlocks another device by signing with the paying wallet. |
| `refresh()` | Forces online revalidation (picks up refunds/revocations). |
| `getPlans()` | Public product info: price, plan type, allowed networks. |
| `onLicenseChanged` | Fires whenever the license state changes. |

### `user` object

```ts
{
  licensed: boolean,      // gate your features on this
  plan: 'lifetime' | 'prepaid_year' | 'trial' | null,
  wallet: string | null,  // the wallet the license is bound to
  paidAt: Date | null,
  expiresAt: Date | null, // null for lifetime
  source: 'cache' | 'network',
  staleSince: Date | null // set while running on offline grace
}
```

## How verification works

1. The buyer pays from their wallet on the hosted checkout.
2. XPayr records the entitlement against **the wallet address that paid**.
3. The buyer signs a free, single-use message (no funds move) proving they control that wallet.
4. XPayr returns an **ES256-signed JWT**, scoped to your product (`aud`) and valid 7 days.
5. The SDK verifies that token **locally with WebCrypto** on every `getUser()` and silently renews it once a day.

Offline for a while? The SDK keeps the license working for **30 days** past the token's expiry, then soft-locks with a prompt to reconnect — no one gets locked out mid-flight.

Refunded a customer? Revoke in the dashboard: refresh fails immediately and the token dies within 7 days.

## Migrating from ExtensionPay

| ExtPay | XPayr Kit |
|---|---|
| `ExtPay('extension-id')` | `XPayrKit('prod_code')` |
| `extpay.startBackground()` | `xpayr.startBackground()` |
| `user.paid` | `user.licensed` |
| `user.email` | `user.wallet` |
| `openPaymentPage()` | `openCheckout()` |
| `openLoginPage()` (email magic link) | `openRestore()` (wallet signature — instant) |
| `onPaid.addListener` (needs a content script) | `onLicenseChanged.addListener` (no content script) |
| `getPlans()` | `getPlans()` |

## Honest limitations

- **Client-side licensing is a deterrent, not DRM.** Anyone determined can patch a local check — true of every library in this category. What this model adds is that "sharing a license" means sharing a wallet signature, and nobody lends out their wallet.
- **Not a merchant of record.** You are responsible for your own tax reporting. Paddle/Lemon Squeezy handle that; that is what their higher fee buys.
- **The buyer needs a wallet.** For crypto-native audiences that is a non-issue; for general consumers, run a fiat rail alongside this one.
- **No pull-based subscriptions.** Crypto has no card-on-file. v1 supports lifetime and prepaid annual licenses.

## Links

- Product & docs: https://xpayr.com
- Pricing: 2.9% flat, first $300 free
- Non-custodial by design: XPayr never holds your funds or keys

## License

MIT — see [LICENSE](LICENSE). The XPayr name and logo are trademarks; see [TRADEMARKS.md](TRADEMARKS.md).
