export type SpendableBalance = {
  confirmed: string;
  unconfirmed: string;
  total: string;
};

export function requiredCommunityFundingSats(maxLandedCostSats: string, units: number): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(maxLandedCostSats)) {
    throw new Error('The group buy maximum is invalid.');
  }
  if (!Number.isInteger(units) || units < 1 || units > 100) {
    throw new Error('The assigned unit count is invalid.');
  }
  return (BigInt(maxLandedCostSats) * BigInt(units) + 99n) / 100n;
}

export function assertConfirmedCommunityFunding(
  balance: SpendableBalance,
  requiredSats: bigint
): void {
  if (requiredSats <= 0n) throw new Error('The required contribution is invalid.');
  const confirmed = BigInt(balance.confirmed);
  if (confirmed < requiredSats) {
    throw new Error(
      `Drey found ${formatSats(confirmed)} confirmed spendable sats. This needs ${formatSats(requiredSats)}. Add funds and try again.`
    );
  }
}

function formatSats(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}
