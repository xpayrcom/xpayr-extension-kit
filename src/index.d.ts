/**
 * @xpayr/extension-kit — type definitions
 */

export interface XPayrUser {
  /** Single source of truth for gating premium features. */
  licensed: boolean;
  plan: 'lifetime' | 'prepaid_year' | 'trial' | null;
  /** Wallet the license is bound to (the wallet that paid). */
  wallet: string | null;
  paidAt: Date | null;
  /** License end date for time-limited plans; null for lifetime. */
  expiresAt: Date | null;
  /** Where this answer came from. */
  source: 'cache' | 'network';
  /** Set while running on an aged token inside the offline grace window. */
  staleSince: Date | null;
}

export interface XPayrPlan {
  object: 'license_product';
  product_code: string;
  name: string;
  plan_type: 'lifetime' | 'prepaid_year';
  price_usd: string;
  allowed_networks: string[] | null;
}

export interface XPayrKitOptions {
  /** Defaults to https://xpayr.com */
  baseUrl?: string;
  debug?: boolean;
}

export interface XPayrLicenseChangedEvent {
  addListener(callback: (user: XPayrUser) => void): void;
  removeListener(callback: (user: XPayrUser) => void): void;
}

export interface XPayrKitInstance {
  /** Call once in the background script / service worker. */
  startBackground(): void;
  /** Offline-first license check. Never throws. */
  getUser(): Promise<XPayrUser>;
  /** Force online revalidation (picks up refunds/revocations). */
  refresh(): Promise<XPayrUser>;
  /** Open the hosted checkout in a new tab. */
  openCheckout(): Promise<string>;
  /** "I already bought this" — unlock via wallet signature. */
  openRestore(): Promise<string>;
  /** Public product/pricing info. */
  getPlans(): Promise<XPayrPlan>;
  onLicenseChanged: XPayrLicenseChangedEvent;
}

declare function XPayrKit(productCode: string, options?: XPayrKitOptions): XPayrKitInstance;

export default XPayrKit;
