import 'server-only';

// Minimal bitcoind JSON-RPC client for the loan detector.
//
// We don't need a full client — only `getrawtransaction <txid> 2` (verbose
// mode that returns parsed vin/vout with prevout details when txindex=1).
// In prod, BITCOIN_RPC_URL points at the co-located bitcoind on 127.0.0.1
// (CLAUDE.md / DEPLOYMENT.md). No external network involved.

import { log } from './log';

const REQUEST_TIMEOUT_MS = 30_000;

type RpcParams = readonly (string | number | boolean | null)[];

const { url: RPC_URL, authHeader: RPC_AUTH } = (() => {
  const raw = process.env.BITCOIN_RPC_URL;
  if (!raw) return { url: null, authHeader: null };
  try {
    const u = new URL(raw);
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password);
    u.username = '';
    u.password = '';
    const authHeader =
      user || pass ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null;
    return { url: u.toString(), authHeader };
  } catch {
    return { url: raw, authHeader: null };
  }
})();

export function bitcoindConfigured(): boolean {
  return RPC_URL != null;
}

let rpcId = 0;

export async function rpc<T = unknown>(method: string, params: RpcParams = []): Promise<T> {
  if (!RPC_URL) throw new Error('BITCOIN_RPC_URL not configured');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (RPC_AUTH) headers.authorization = RPC_AUTH;
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`rpc ${method} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const j = (await res.json()) as { error: unknown; result: T };
    if (j.error) throw new Error(`rpc ${method} error: ${JSON.stringify(j.error)}`);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

// Shape we actually use from getrawtransaction verbose=2. Bitcoind returns
// more fields; we only declare what the loan detector reads.
export type RawTx = {
  txid: string;
  blocktime?: number;
  vin: Array<{
    txid?: string;
    vout?: number;
    coinbase?: string;
    txinwitness?: string[];
    scriptSig?: { hex: string };
    prevout?: {
      value: number;
      scriptPubKey?: {
        address?: string;
        addresses?: string[];
        type?: string;
      };
    };
  }>;
  vout: Array<{
    value: number;
    scriptPubKey?: {
      address?: string;
      addresses?: string[];
      type?: string;
    };
  }>;
};

export async function getRawTransaction(txid: string): Promise<RawTx> {
  return rpc<RawTx>('getrawtransaction', [txid, 2]);
}

// Per-call cache: bitcoind's getrawtransaction is fast over localhost (sub-ms)
// but origination tracing + repayment walks repeatedly hit the same prevouts.
// Caller passes a fresh Map per tick so the cache doesn't grow unbounded
// across requests.
export type TxCache = Map<string, RawTx>;

export async function getRawTxCached(txid: string, cache: TxCache): Promise<RawTx> {
  const hit = cache.get(txid);
  if (hit) return hit;
  const tx = await getRawTransaction(txid);
  cache.set(txid, tx);
  return tx;
}

// Health probe used at the start of a tick to confirm bitcoind is reachable.
// Returns the chain tip block height, or throws.
export async function getBlockchainTip(): Promise<number> {
  const info = await rpc<{ blocks: number; chain: string }>('getblockchaininfo', []);
  if (info.chain !== 'main' && info.chain !== 'test') {
    log.warn('bitcoind', 'unexpected chain', { chain: info.chain });
  }
  return info.blocks;
}
