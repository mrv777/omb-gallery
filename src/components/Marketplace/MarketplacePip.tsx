import { marketplaceLabel } from '@/lib/format';

const SHORT_LABELS: Record<string, string> = {
  magisat: 'MS',
};

export default function MarketplacePip({ marketplace }: { marketplace: string }) {
  const key = marketplace.toLowerCase();
  if (key === 'satflow') {
    return (
      <span
        className="inline-flex h-5 items-center border border-ink-2 bg-ink-0 px-1.5"
        title={marketplaceLabel(marketplace)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/marketplace/satflow-mark-white.svg"
          alt="Satflow"
          className="h-3.5 w-4"
          loading="lazy"
        />
      </span>
    );
  }
  if (key === 'ord.net' || key === 'ordnet' || key === 'ord-net') {
    return (
      <span
        className="inline-flex h-5 items-center border border-ink-2 bg-ink-0 px-1.5"
        title={marketplaceLabel(marketplace)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/marketplace/ordnet-mark.svg"
          alt="ORD.NET"
          className="h-3.5 w-3.5"
          loading="lazy"
        />
      </span>
    );
  }

  return (
    <span
      className="inline-flex h-5 items-center gap-1 border border-ink-2 bg-ink-0 px-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-bone-dim"
      title={marketplaceLabel(marketplace)}
    >
      <span className="h-1.5 w-1.5 bg-accent-green" aria-hidden="true" />
      {SHORT_LABELS[key] ?? key.slice(0, 2)}
    </span>
  );
}
