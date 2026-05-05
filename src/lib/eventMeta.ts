type EventWithRawJson = {
  event_type: string;
  raw_json: string | null;
};

export function loanAmountSats(event: EventWithRawJson): number | null {
  if (event.event_type !== 'loan-originated' || !event.raw_json) return null;
  try {
    const rj = JSON.parse(event.raw_json) as { loan_amount_sats?: unknown };
    return typeof rj.loan_amount_sats === 'number' ? rj.loan_amount_sats : null;
  } catch {
    return null;
  }
}
