export function formatBtc(sats: number | null | undefined): string {
  if (sats == null || !Number.isFinite(sats) || sats <= 0) return '';
  const btc = sats / 1e8;
  if (btc >= 1) return `${btc.toFixed(3)} ₿`;
  if (btc >= 0.001) return `${btc.toFixed(4)} ₿`;
  return `${btc.toFixed(6)} ₿`;
}

export function formatRelTime(
  unixSeconds: number | null | undefined,
  nowMs: number = Date.now()
): string {
  if (!unixSeconds) return '';
  const diff = Math.max(0, Math.floor(nowMs / 1000 - unixSeconds));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86_400 * 30) return `${Math.floor(diff / 86_400)}d ago`;
  if (diff < 86_400 * 365) return `${Math.floor(diff / (86_400 * 30))}mo ago`;
  return `${Math.floor(diff / (86_400 * 365))}y ago`;
}

export function truncateAddr(addr: string | null | undefined, head = 6, tail = 4): string {
  if (!addr) return '—';
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

const MARKETPLACE_LABELS: Record<string, string> = {
  magiceden: 'Magic Eden',
  'magic-eden': 'Magic Eden',
  magic_eden: 'Magic Eden',
  satflow: 'Satflow',
  okx: 'OKX',
  unisat: 'Unisat',
  ordinalswallet: 'Ordinals Wallet',
  'ordinals-wallet': 'Ordinals Wallet',
  ordswap: 'OrdSwap',
  gamma: 'Gamma',
  trio: 'Trio',
  osura: 'Osura',
};

export function marketplaceLabel(key: string | null | undefined): string {
  if (!key) return '';
  const k = key.toLowerCase().trim();
  return MARKETPLACE_LABELS[k] ?? key;
}

export function ordinalsLink(
  inscriptionId: string | null | undefined,
  inscriptionNumber?: number
): string {
  if (inscriptionId && !inscriptionId.startsWith('unknown-')) {
    return `https://ordinals.com/inscription/${inscriptionId}`;
  }
  if (inscriptionNumber != null) {
    return `https://ordinals.com/inscription/${inscriptionNumber}`;
  }
  return 'https://ordinals.com';
}

export function memepoolTxLink(txid: string | null | undefined): string {
  if (!txid || txid === 'unknown') return '';
  return `https://memepool.space/tx/${txid}`;
}

export function addressLink(addr: string | null | undefined): string {
  if (!addr) return '';
  return `https://ord.io/${addr}`;
}

export function ordNetWalletLink(addr: string | null | undefined): string {
  if (!addr) return '';
  return `https://ord.net/u/${addr}`;
}

export function satflowInscriptionLink(inscriptionId: string | null | undefined): string {
  if (!inscriptionId || inscriptionId.startsWith('unknown-')) return '';
  return `https://www.satflow.com/ordinal/${inscriptionId}`;
}
