export type BravocadoStats = {
  total: number;
  distributed: number;
  uniqueHolders: number;
  ombOverlap: number;
  /** Rows with no effective_owner yet (indexer warming up / dev DB). */
  unindexed: number;
};

export default function BravocadosStats({ stats }: { stats: BravocadoStats }) {
  return (
    <div className="mb-2 font-mono">
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 text-[11px] tracking-[0.08em] uppercase text-bone-dim border border-ink-2 px-4 py-3">
        <Stat label="total" value={stats.total.toLocaleString()} />
        <Stat label="distributed" value={stats.distributed.toLocaleString()} />
        <Stat label="unique holders" value={stats.uniqueHolders.toLocaleString()} />
        <Stat label="also hold OMB" value={stats.ombOverlap.toLocaleString()} />
      </dl>
      {stats.unindexed > 0 && (
        <p className="mt-1.5 text-[10px] font-mono tracking-[0.04em] text-bone-dim normal-case">
          {stats.unindexed.toLocaleString()} not yet indexed — counted as undistributed.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-bone-dim">{label}</dt>
      <dd className="text-bone normal-case tracking-normal tabular-nums mt-0.5">{value}</dd>
    </div>
  );
}
