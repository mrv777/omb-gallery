import 'server-only';

import { getDb } from '@/lib/db';
import type { BuyIntentRow, BuyIntentStatus } from './types';

export function createBuyIntent(args: {
  inscription_id: string;
  inscription_number: number;
  buyer_ord_addr: string;
  buyer_pay_addr: string | null;
  marketplace: string;
  listing_id?: string | null;
  price_sats: number;
  preflight_json?: string | null;
  is_mock: boolean;
}): number {
  const now = Math.floor(Date.now() / 1000);
  const res = getDb()
    .prepare(
      `
      INSERT INTO buy_intents (
        inscription_id, inscription_number, buyer_ord_addr, buyer_pay_addr,
        marketplace, listing_id, price_sats, status, preflight_json, is_mock, created_at, updated_at
      ) VALUES (
        @inscription_id, @inscription_number, @buyer_ord_addr, @buyer_pay_addr,
        @marketplace, @listing_id, @price_sats, 'created', @preflight_json, @is_mock, @created_at, @updated_at
      )
    `
    )
    .run({
      ...args,
      listing_id: args.listing_id ?? null,
      preflight_json: args.preflight_json ?? null,
      is_mock: args.is_mock ? 1 : 0,
      created_at: now,
      updated_at: now,
    });
  return Number(res.lastInsertRowid);
}

export function getBuyIntent(id: number): BuyIntentRow | null {
  const row = getDb().prepare(`SELECT * FROM buy_intents WHERE id = ?`).get(id) as
    | BuyIntentRow
    | undefined;
  return row ?? null;
}

export function listBuyerIntents(buyerOrdAddr: string, limit = 50): BuyIntentRow[] {
  return getDb()
    .prepare(
      `
      SELECT * FROM buy_intents
      WHERE buyer_ord_addr = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `
    )
    .all(buyerOrdAddr, Math.max(1, Math.min(limit, 100))) as BuyIntentRow[];
}

export function markIntentSigned(id: number): void {
  setIntentStatus({ id, status: 'signed' });
}

export function updateIntentPreflightJson(id: number, preflightJson: string): void {
  getDb()
    .prepare(
      `
      UPDATE buy_intents
      SET preflight_json = ?,
          updated_at = unixepoch()
      WHERE id = ?
    `
    )
    .run(preflightJson, id);
}

export function markIntentBroadcast(id: number, txid: string): void {
  setIntentStatus({ id, status: 'broadcast', txid });
}

export function markIntentFailed(id: number, reason: string): void {
  setIntentStatus({ id, status: 'failed', fail_reason: reason.slice(0, 500) });
}

export function markIntentConfirmedByTxid(txid: string): void {
  getDb()
    .prepare(
      `
      UPDATE buy_intents
      SET status = 'confirmed', updated_at = unixepoch()
      WHERE txid = ?
        AND is_mock = 0
        AND status IN ('broadcast','signed','created')
    `
    )
    .run(txid);
}

function setIntentStatus(args: {
  id: number;
  status: BuyIntentStatus;
  txid?: string;
  fail_reason?: string;
}): void {
  const allowedCurrent =
    args.status === 'signed'
      ? ['created', 'signed']
      : args.status === 'broadcast'
        ? ['created', 'signed', 'broadcast']
        : args.status === 'failed'
          ? ['created', 'signed', 'failed']
          : ['created', 'signed', 'broadcast'];
  getDb()
    .prepare(
      `
      UPDATE buy_intents
      SET status = @status,
          txid = COALESCE(@txid, txid),
          fail_reason = @fail_reason,
          updated_at = unixepoch()
      WHERE id = @id
        AND status IN (@allowed0, @allowed1, @allowed2)
    `
    )
    .run({
      id: args.id,
      status: args.status,
      txid: args.txid ?? null,
      fail_reason: args.fail_reason ?? null,
      allowed0: allowedCurrent[0],
      allowed1: allowedCurrent[1],
      allowed2: allowedCurrent[2] ?? allowedCurrent[1],
    });
}
