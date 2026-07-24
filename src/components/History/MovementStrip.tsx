import Link from 'next/link';
import { fullDate } from '../Charts/chartUtils';
import { EVENT_DISPLAY, type EventType } from '@/lib/eventDisplay';

export type EventSpan = {
  type: string;
  count: number;
  firstAt: number | null;
  lastAt: number | null;
};

export default function MovementStrip({
  spans,
  neverMoved,
  total,
}: {
  spans: EventSpan[];
  neverMoved: number;
  total: number;
}) {
  return (
    <div className="space-y-6">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] font-mono text-[11px] uppercase tracking-[0.08em]">
          <thead>
            <tr className="text-bone-dim border-b border-ink-2">
              <th className="text-left font-normal py-2 pr-4">event</th>
              <th className="text-right font-normal py-2 pr-4">count</th>
              <th className="text-left font-normal py-2 pr-4">first</th>
              <th className="text-left font-normal py-2">most recent</th>
            </tr>
          </thead>
          <tbody>
            {spans.map(s => (
              <tr key={s.type} className="border-b border-ink-2/60">
                <td className="py-2 pr-4 text-bone">
                  {EVENT_DISPLAY[s.type as EventType]?.label ?? s.type}
                </td>
                <td className="py-2 pr-4 text-right text-bone">{s.count.toLocaleString()}</td>
                <td className="py-2 pr-4 text-bone-dim">
                  {s.firstAt != null ? fullDate(s.firstAt) : '—'}
                </td>
                <td className="py-2 text-bone-dim">
                  {s.lastAt != null ? fullDate(s.lastAt) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border border-ink-2 bg-ink-1 p-4">
        <div className="font-mono text-xl text-bone tracking-[0.04em]">
          {neverMoved.toLocaleString()}{' '}
          <span className="text-bone-dim text-sm">of {total.toLocaleString()}</span>
        </div>
        <p className="font-mono mt-1.5 text-[11px] uppercase tracking-[0.08em] text-bone-dim">
          have never moved since they were inscribed.{' '}
          <Link
            href="/explorer/longest-unmoved"
            className="hover:text-bone underline underline-offset-4"
          >
            longest unmoved →
          </Link>
        </p>
      </div>
    </div>
  );
}
