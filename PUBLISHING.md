# Publishing `@xpayr/extension-kit`

Everything below has been verified except the two steps that need your credentials
(npm login and the actual publish).

## Verified already

- `npm pack` produces **6 files, 9.0 kB** — `LICENSE`, `README.md`, `TRADEMARKS.md`, `package.json`, `src/index.js`, `src/index.d.ts`. No tests, no junk.
- Installing the packed tarball into a clean project works: `require('@xpayr/extension-kit')` returns the factory, `.default` is present for ESM interop, all six methods and `onLicenseChanged` are exposed, and the empty-product-code guard fires.
- Test suite: `node test/kit.test.js` → **34 passed, 0 failed** (runs against real ES256 tokens and a fake `chrome.*`).
- The token format is proven interoperable: PHP signs with OpenSSL, the SDK verifies with WebCrypto (see `scripts/test_license_token_interop.php` in the main repo, 5 rounds clean).

## Before the first publish

1. **Claim the scope.** `@xpayr` must exist on npm and your account must own it:
   ```bash
   npm login
   npm org ls xpayr          # or create the org / scope in the npm UI
   ```
   A scoped package is private by default, so the first publish **must** pass `--access public`.

2. **Decide the version.** `0.1.0` signals "usable, API may still move". Go to `1.0.0`
   only when you are ready to treat the surface as stable — the SDK is embedded in
   other people's extensions, so breaking changes are expensive for them.

3. **Point the repository field at the real repo** once the public GitHub repo exists.
   It currently says `github.com/xpayr/extension-kit`.

## Publish

```bash
cd sdk/extension-kit
npm test                      # 34/34 expected
npm pack --dry-run            # confirm the 6 files
npm publish --access public --provenance
```

`--provenance` links the published tarball to the GitHub Actions run that built it,
which is worth having for a package that gates other people's revenue. It requires
publishing from CI with `id-token: write`; drop the flag for a local publish.

## After publish

- `npm view @xpayr/extension-kit` — confirm the version, files and license.
- Install it fresh in a scratch project and load an unpacked extension against it once.
- Tag the repo: `git tag sdk-v0.1.0 && git push --tags`.

## Public GitHub repo

Ship these at the root:

- `README.md`, `LICENSE` (MIT), `TRADEMARKS.md` — already written.
- `src/`, `test/` — already written.
- A CI workflow running `node test/kit.test.js` on push.
- `SECURITY.md` pointing at legal@xpayr.com and enabling private vulnerability reporting.

**Keep the server side closed.** Only the client SDK is open source. The fork
protection is not the licence — it is the running service, the network effect
(one wallet unlocks every XPayr-licensed product), the thin fee, and the trademark.
A fork may use the code; it may not call itself XPayr.

## Version policy

| Change | Bump |
|---|---|
| New optional method or field | minor |
| Behaviour change in `getUser()` gating | major |
| Token format or verification change | major, and keep verifying the old format for at least 30 days (the offline grace window) |
| Docs, comments, internal refactor | patch |

The last row matters: a buyer offline for three weeks is still running an old token.
Never ship a verification change that invalidates tokens issued before the release.
