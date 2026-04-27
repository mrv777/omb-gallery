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

export type ApiActivityResponse = {
  events: ApiEvent[];
  next_cursor: number | null;
  totals: { events: number; holders: number } | null;
  poll: {
    last_run_at: number | null;
    last_status: string | null;
    last_event_count: number | null;
    is_backfilling: boolean;
  } | null;
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

export type ApiHolder = {
  wallet_addr: string;
  inscription_count: number;
  updated_at: number;
};
