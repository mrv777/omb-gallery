export type ApiEvent = {
  id: number;
  inscription_id: string;
  inscription_number: number;
  event_type: 'inscribed' | 'transferred' | 'sold';
  block_height: number | null;
  block_timestamp: number;
  new_satpoint: string | null;
  old_owner: string | null;
  new_owner: string | null;
  marketplace: string | null;
  sale_price_sats: number | null;
  txid: string;
  created_at: number;
};

/** Matrica profile overlay: wallet_addr → display data. Only populated for
 * wallets that have a non-default Matrica profile. The map is restricted to
 * addresses appearing in the events on this page so payload stays small. */
export type ApiMatricaMap = Record<string, { username: string | null; avatar_url: string | null }>;

export type ApiActivityResponse = {
  events: ApiEvent[];
  next_cursor: string | null;
  totals: { events: number; holders: number } | null;
  poll: {
    last_run_at: number | null;
    last_status: string | null;
    last_event_count: number | null;
    is_backfilling: boolean;
  } | null;
  matrica: ApiMatricaMap;
};

export type ApiInscription = {
  inscription_number: number;
  inscription_id: string | null;
  color: string | null;
  current_owner: string | null;
  inscribe_at: number | null;
  first_event_at: number | null;
  last_event_at: number | null;
  last_movement_at: number | null;
  transfer_count: number;
  sale_count: number;
  total_volume_sats: number;
  highest_sale_sats: number;
};

/** One identity in the top-holders leaderboard. When `is_user`, multiple
 * wallets are rolled up under a Matrica profile and `wallets[]` lists them
 * all (typically 1 — only one of the user's wallets actually holds OMBs).
 * When NOT `is_user`, `wallets` is a single-element array containing
 * `group_key` (the raw wallet address). */
export type ApiHolder = {
  group_key: string;
  is_user: boolean;
  username: string | null;
  avatar_url: string | null;
  wallets: string[];
  inscription_count: number;
  updated_at: number;
};
