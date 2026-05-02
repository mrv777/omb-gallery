/* eslint-disable */
// Shared bitcoin-cli + ord helpers for ops scripts. Extracted from
// scripts/backfill-transfers.js so other tools (e.g.
// repair-ordnet-misattributed-sales.js) can reuse the same primitives without
// copy-paste.
//
// Required env at module load (caller decides whether to fail-fast):
//   BITCOIN_RPC_URL    e.g. http://user:pass@127.0.0.1:8332
//   ORD_BASE_URL       e.g. http://127.0.0.1:4000

const REQUEST_TIMEOUT_MS = 30_000;
const ORD_TIMEOUT_MS = 15_000;

// Node's fetch (undici) refuses URLs containing inline credentials, so split
// the user:pass off into a Basic Authorization header.
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
const ORD_BASE = (process.env.ORD_BASE_URL ?? '').replace(/\/+$/, '');

// ---------------- bitcoind RPC ----------------

let rpcId = 0;
async function rpc(method, params = []) {
  if (!RPC_URL) throw new Error('BITCOIN_RPC_URL is not set');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (RPC_AUTH) headers['authorization'] = RPC_AUTH;
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`rpc ${method} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const j = await res.json();
    if (j.error) throw new Error(`rpc ${method} error: ${JSON.stringify(j.error)}`);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

async function safeText(r) {
  try {
    return await r.text();
  } catch {
    return '';
  }
}

const headerCache = new Map(); // blockhash -> {height, time}
async function getHeader(blockhash) {
  let v = headerCache.get(blockhash);
  if (v) return v;
  const h = await rpc('getblockheader', [blockhash, true]);
  v = { height: h.height, time: h.time };
  headerCache.set(blockhash, v);
  return v;
}

// ---------------- ord HTTP ----------------

async function fetchOrdInscription(numOrId) {
  if (!ORD_BASE) throw new Error('ORD_BASE_URL is not set');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ORD_TIMEOUT_MS);
  try {
    const res = await fetch(`${ORD_BASE}/inscription/${numOrId}`, {
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// GET /output/<outpoint> — returns { inscriptions: [<id>...], indexed, value, address, ... }
// Returns null on network error or non-2xx so callers can fall back to a
// chain walk. `indexed: false` is a separate signal: ord knows the output but
// hasn't indexed inscriptions on it (rare in practice for confirmed UTXOs).
async function fetchOrdOutput(outpoint) {
  if (!ORD_BASE) throw new Error('ORD_BASE_URL is not set');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ORD_TIMEOUT_MS);
  try {
    const res = await fetch(`${ORD_BASE}/output/${outpoint}`, {
      headers: { Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---------------- formatters / parsers ----------------

// satpoint format: <txid>:<vout>:<offset>
function parseSatpoint(s) {
  if (!s || typeof s !== 'string') return null;
  const parts = s.split(':');
  if (parts.length < 3) return null;
  const txid = parts[0];
  const vout = parseInt(parts[1], 10);
  const offset = BigInt(parts[2]);
  if (!/^[0-9a-f]{64}$/i.test(txid)) return null;
  if (!Number.isFinite(vout) || vout < 0) return null;
  return { txid: txid.toLowerCase(), vout, offset };
}

// inscription_id format: <txid>i<index>
function genesisTxidFromId(inscriptionId) {
  if (typeof inscriptionId !== 'string') return null;
  const idx = inscriptionId.indexOf('i');
  if (idx !== 64) return null;
  const tx = inscriptionId.slice(0, 64);
  return /^[0-9a-f]{64}$/i.test(tx) ? tx.toLowerCase() : null;
}

// ord serves values in BTC (json) — we want sats. 1 BTC = 1e8 sat.
// Rounding via Math.round(value * 1e8) loses precision for very large values;
// stay in BigInt and parse the decimal string directly.
function btcToSats(v) {
  if (typeof v === 'number') return BigInt(Math.round(v * 1e8));
  if (typeof v === 'string') {
    const [whole, frac = ''] = v.split('.');
    const padded = (frac + '00000000').slice(0, 8);
    return BigInt(whole || '0') * 100_000_000n + BigInt(padded || '0');
  }
  return 0n;
}

function addressFromScriptPubKey(spk) {
  if (!spk || typeof spk !== 'object') return null;
  if (typeof spk.address === 'string' && spk.address.length > 0) return spk.address;
  if (Array.isArray(spk.addresses) && typeof spk.addresses[0] === 'string') return spk.addresses[0];
  return null;
}

// ---------------- chain walk (sat-tracking) ----------------
//
// Walk an inscription's transfer chain backwards from a known satpoint via
// bitcoin-cli verbosity=2 calls, applying ord's first-input-first-sat rule.
// Returns the list of hops (newest → oldest) up to maxHops or until we hit
// the inscription's genesis tx / coinbase / unwalkable state.
//
// `satpoint` is the starting position (typically the inscription's current
// satpoint per ord). `inscription_id` is used only to detect when we've
// reached the genesis tx — we stop there.
//
// Each hop: { txid, vout, offset, prevTxid, prevVout, prevAddr, newAddr,
//             blockhash, blocktime }.
async function walkInscription({ inscription_id, satpoint, maxHops = 250 }) {
  const events = [];
  const genesis = genesisTxidFromId(inscription_id);
  if (!genesis) return { events, reason: 'no-genesis' };

  let cur = parseSatpoint(satpoint);
  if (!cur) return { events, reason: 'bad-satpoint' };

  let hopsLeft = maxHops;
  while (hopsLeft-- > 0) {
    if (cur.txid === genesis) return { events, reason: 'reached-genesis' };

    let tx;
    try {
      tx = await rpc('getrawtransaction', [cur.txid, 2]);
    } catch (e) {
      return { events, reason: `rpc: ${e.message}` };
    }
    if (!tx || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) {
      return { events, reason: 'bad-tx' };
    }
    if (tx.vin.some(i => i && i.coinbase)) {
      return { events, reason: 'coinbase' };
    }

    // absolute_offset within the inputs combined sat stream:
    //   sum(vout[0..cur.vout-1].value) + cur.offset
    let absOffset = cur.offset;
    for (let i = 0; i < cur.vout; i++) {
      absOffset += btcToSats(tx.vout[i].value);
    }
    let acc = 0n;
    let carryIdx = -1;
    let newOffset = 0n;
    for (let i = 0; i < tx.vin.length; i++) {
      const vin = tx.vin[i];
      const prev = vin.prevout;
      if (!prev) return { events, reason: 'no-prevout' };
      const v = btcToSats(prev.value);
      if (absOffset < acc + v) {
        carryIdx = i;
        newOffset = absOffset - acc;
        break;
      }
      acc += v;
    }
    if (carryIdx === -1) return { events, reason: 'sat-not-in-inputs' };

    const carryVin = tx.vin[carryIdx];
    const newAddr = addressFromScriptPubKey(tx.vout[cur.vout]?.scriptPubKey);
    const prevAddr = addressFromScriptPubKey(carryVin.prevout?.scriptPubKey);

    events.push({
      txid: cur.txid,
      vout: cur.vout,
      offset: cur.offset,
      prevTxid: carryVin.txid?.toLowerCase() ?? null,
      prevVout: carryVin.vout,
      prevAddr,
      newAddr,
      blockhash: tx.blockhash ?? null,
      blocktime: tx.blocktime ?? tx.time ?? null,
    });

    cur = {
      txid: carryVin.txid.toLowerCase(),
      vout: carryVin.vout,
      offset: newOffset,
    };
  }
  return { events, reason: 'max-hops' };
}

module.exports = {
  // env-derived
  RPC_URL,
  RPC_AUTH,
  ORD_BASE,
  // bitcoind
  rpc,
  getHeader,
  // ord
  fetchOrdInscription,
  fetchOrdOutput,
  // parsers
  parseSatpoint,
  genesisTxidFromId,
  btcToSats,
  addressFromScriptPubKey,
  // chain walk
  walkInscription,
};
