import Link from 'next/link';
import { fullDate } from '../Charts/chartUtils';

export type DropRow = {
  color: string;
  count: number;
  inscribedFrom: number;
  inscribedTo: number;
  mintedFrom: number | null;
  mintedTo: number | null;
  mintedCount: number;
  /** Sat provenance: the single block this color's sats came from, if uniform. */
  uniformBlock: number | null;
  blockNote: string | null;
};

const DOT_CLASS: Record<string, string> = {
  red: 'bg-accent-red',
  blue: 'bg-accent-blue',
  green: 'bg-accent-green',
  orange: 'bg-accent-orange',
  black: 'bg-accent-black',
};

function window_(from: number | null, to: number | null): string {
  if (from == null || to == null) return '—';
  const a = fullDate(from);
  const b = fullDate(to);
  return a === b ? a : `${a} → ${b}`;
}

export default function DropTable({ rows }: { rows: DropRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] font-mono text-[11px] uppercase tracking-[0.08em]">
        <thead>
          <tr className="text-bone-dim border-b border-ink-2">
            <th className="text-left font-normal py-2 pr-4">drop</th>
            <th className="text-right font-normal py-2 pr-4">pieces</th>
            <th className="text-left font-normal py-2 pr-4">inscribed</th>
            <th className="text-left font-normal py-2 pr-4">distributed</th>
            <th className="text-left font-normal py-2">sits on</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.color} className="border-b border-ink-2/60 align-top">
              <td className="py-2.5 pr-4">
                <Link
                  href={`/?color=${r.color}`}
                  className="flex items-center gap-2 text-bone hover:underline underline-offset-4"
                >
                  <span
                    className={`inline-block h-2.5 w-2.5 shrink-0 ${DOT_CLASS[r.color] ?? 'bg-bone'}`}
                    aria-hidden
                  />
                  {r.color}
                </Link>
              </td>
              <td className="py-2.5 pr-4 text-right text-bone">{r.count.toLocaleString()}</td>
              <td className="py-2.5 pr-4 text-bone-dim">
                {window_(r.inscribedFrom, r.inscribedTo)}
              </td>
              <td className="py-2.5 pr-4 text-bone-dim">
                {window_(r.mintedFrom, r.mintedTo)}
                {r.mintedCount > 0 && r.mintedCount !== r.count && (
                  <span className="block text-[10px] opacity-70">
                    {r.mintedCount.toLocaleString()} of {r.count.toLocaleString()} indexed
                  </span>
                )}
              </td>
              <td className="py-2.5 text-bone-dim">
                {r.uniformBlock != null ? (
                  <>
                    block {r.uniformBlock.toLocaleString()} sats
                    {r.blockNote && (
                      <span className="block text-[10px] opacity-70">{r.blockNote}</span>
                    )}
                  </>
                ) : (
                  <>
                    individually sourced
                    <span className="block text-[10px] opacity-70">one sat per piece</span>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
