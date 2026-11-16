export type ApiEvent = {
  id: number;
  inscription_id: string;
  inscription_number: number;
  event_type:
    | 'inscribed'
    | 'transferred'
    | 'sold'
    | 'mint'
    | 'loan-originated'
    | 'loan-defaulted'
    | 'loan-repaid'
    | 'loan-unlocked';
  block_height: number | null;
  block_timestamp: number;
  new_satpoint: string | null;
  old_owner: string | null;
  new_owner: string | null;
  marketplace: string | null;
  sale_price_sats: number | null;
  txid: string;
  /** JSON sidecar for event-type-specific metadata. For loan-originated rows
   * this carries `{loan_amount_sats, lender_addr, borrower_addr, escrow_addr,
   * detector_version, ...}`; for loan-defaulted, `{lender_addr, escrow_addr,
   * csv_value, ...}`. Always a JSON string when set. */
  raw_json: string | null;
  created_at: number;
};

/** Public profile overlay (legacy Matrica API name), restricted to addresses
 * in this event window. `user_id` is namespaced for ORD.NET. `inferred` marks
 * heuristic Matrica links; explicit ORD.NET publication never imports siblings.
 */
export type ApiMatricaMap = Record<
  string,
  {
    user_id: string;
    username: string | null;
    avatar_url: string | null;
    inferred?: boolean;
    provider?: 'matrica' | 'ordnet';
  }
>;

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
  loan_count?: number;
  active_loan_count?: number;
  /** block_timestamp of the most recent un-resolved `loan-originated` event
   * for this inscription. Only populated by the currently-loaned leaderboard
   * queries — null elsewhere. */
  active_loan_started_at?: number | null;
  /** Lender vault address from the most recent loan-originated event.
   * Populated alongside active_loan_started_at. Used for tooltip context. */
  active_loan_lender_vault?: string | null;
  /** Per-vault modal-term-based expiration estimate. Populated by the
   * currently-loaned leaderboard and the inscription detail API when the
   * inscription has an active loan. See lib/loanExpiration.ts. */
  estimated_expiration_ts?: number | null;
  estimated_term_days?: number | null;
  estimated_basis?: 'vault' | 'global' | 'unknown' | null;
  estimated_sample_count?: number | null;
  estimated_term_min_days?: number | null;
  estimated_term_max_days?: number | null;
  /** True if `estimated_expiration_ts` is already past at server time. */
  is_overdue?: boolean | null;
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
