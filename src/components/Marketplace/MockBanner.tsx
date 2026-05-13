export default function MockBanner() {
  if (process.env.NEXT_PUBLIC_MARKETPLACE_MOCK !== 'true') return null;
  return (
    <div className="border-b border-accent-red bg-accent-red px-3 py-1 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-ink-0">
      MOCK MODE - NO REAL BITCOIN MOVED
    </div>
  );
}
