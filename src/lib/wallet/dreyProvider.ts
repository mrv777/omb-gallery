export const DREY_PROVIDER_ID = 'drey';
export const DREY_INITIALIZED_EVENT = 'drey#initialized';
export const DREY_CHROME_STORE_URL =
  'https://chromewebstore.google.com/detail/drey/kngidlmmbfmnoeimngkajdlbdenlhgof';
export const DREY_PROVIDER_ICON = '/wallets/drey.png';

export function listenForDreyInitialization(listener: () => void): () => void {
  window.addEventListener(DREY_INITIALIZED_EVENT, listener);
  return () => window.removeEventListener(DREY_INITIALIZED_EVENT, listener);
}
