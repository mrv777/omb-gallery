export function formatBtc(sats: number | null | undefined): string {
  if (sats == null || !Number.isFinite(sats) || sats <= 0) return '';
  const btc = sats / 1e8;
  if (btc >= 1) return `${btc.toFixed(3)} ₿`;
  if (btc >= 0.001) return `${btc.toFixed(4)} ₿`;
  return `${btc.toFixed(6)} ₿`;
}

export function formatBtcCompact(sats: number | null | undefined): string {
  const formatted = formatBtc(sats);
  if (!formatted) return '';
  return formatted.replace(/\.?0+\s₿$/, '₿').replace(/\s₿$/, '₿');
}

export function formatRelTime(
  unixSeconds: number | null | undefined,
  nowMs: number = Date.now()
): string {
  if (!unixSeconds) return '';
  const diff = Math.max(0, Math.floor(nowMs / 1000 - unixSeconds));
  if (diff < 60) return `${diff}s ago`;
  const minutes = Math.round(diff / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(diff / 3600);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(diff / 86_400);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(diff / (86_400 * 30));
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(diff / (86_400 * 365))}y ago`;
}

/** Future-pointing relative formatter ("in 30d", "in 4h"). Returns an empty
 * string if the timestamp is in the past — the caller should branch to
 * `formatRelTime` or a "past due" string for that case. The "days" rung
 * extends to 45d (vs. 30d in `formatRelTime`) so canonical Liquidium loan
 * terms like 30d display as "in 30d" instead of jumping straight to "1mo". */
export function formatTimeUntil(
  unixSeconds: number | null | undefined,
  nowMs: number = Date.now()
): string {
  if (!unixSeconds) return '';
  const diff = Math.floor(unixSeconds - nowMs / 1000);
  if (diff <= 0) return '';
  if (diff < 60) return `in ${diff}s`;
  const minutes = Math.round(diff / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(diff / 3600);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(diff / 86_400);
  if (days < 45) return `in ${days}d`;
  const months = Math.round(diff / (86_400 * 30));
  if (months < 12) return `in ${months}mo`;
  return `in ${Math.round(diff / (86_400 * 365))}y`;
}

export function truncateAddr(addr: string | null | undefined, head = 6, tail = 4): string {
  if (!addr) return '—';
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** Heuristic: does this string look like a wallet address rather than a
 * username? Used to defend against a Matrica display name that's been set
 * to a raw address — we'd rather show the truncated address than a long
 * unreadable handle. */
export function looksLikeAddress(s: string): boolean {
  return /^bc1[a-z0-9]{30,}$/i.test(s) || /^0x[a-f0-9]{40}$/i.test(s) || s.length > 30;
}

/** Render an owner slot for plain-text contexts (notifications). Returns
 * `@username` when the address has a non-trivial Matrica handle, otherwise
 * the truncated address. Pass `null` for unknown owners (returns '?'). */
export function ownerDisplay(
  addr: string | null,
  profiles: Record<string, { username: string | null } | undefined>
): string {
  if (!addr) return '?';
  const profile = profiles[addr];
  if (profile?.username && !looksLikeAddress(profile.username)) {
    return `@${profile.username}`;
  }
  return truncateAddr(addr);
}

const MARKETPLACE_LABELS: Record<string, string> = {
  magiceden: 'Magic Eden',
  'magic-eden': 'Magic Eden',
  magic_eden: 'Magic Eden',
  satflow: 'Satflow',
  magisat: 'Magisat',
  okx: 'OKX',
  unisat: 'Unisat',
  ordinalswallet: 'Ordinals Wallet',
  'ordinals-wallet': 'Ordinals Wallet',
  ordswap: 'OrdSwap',
  gamma: 'Gamma',
  trio: 'Trio',
  osura: 'Osura',
  'ord.net': 'ORD.NET',
  ordnet: 'ORD.NET',
  'ord-net': 'ORD.NET',
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
