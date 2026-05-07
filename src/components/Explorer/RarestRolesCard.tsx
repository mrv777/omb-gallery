import Link from 'next/link';
import { ROLES, getRoleById } from '@/lib/roles';

type Props = {
  /** Holder count per role id. Roles missing from the map render as 0. */
  countsByRole: Record<string, number>;
  /** How many of the top (= rarest, since ROLES is rarest-first) to show. */
  topN?: number;
};

/**
 * Card on the /explorer dashboard surfacing the top-N rarest roles + their
 * holder counts. "Rarest" follows the ROLES array order in src/lib/roles.ts —
 * editable to change priority everywhere. Click-through to /explorer/roles.
 */
export default function RarestRolesCard({ countsByRole, topN = 3 }: Props) {
  const rows = ROLES.slice(0, topN);

  return (
    <div className="border border-ink-2 bg-ink-1">
      <div className="px-4 py-3 border-b border-ink-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-mono text-xs tracking-[0.12em] uppercase text-bone">Rarest Roles</h2>
          <Link
            href="/explorer/roles"
            className="font-mono text-[10px] tracking-[0.12em] uppercase text-bone-dim hover:text-bone transition-colors"
          >
            see all →
          </Link>
        </div>
        <p className="font-mono text-[10px] tracking-[0.04em] text-bone-dim mt-1 normal-case">
          Earned by Matrica-linked holders based on the colors they hold.
        </p>
      </div>
      <ol className="divide-y divide-ink-2">
        {rows.map((role) => {
          const r = getRoleById(role.id)!;
          const count = countsByRole[role.id] ?? 0;
          return (
            <li key={role.id}>
              <Link
                href="/explorer/roles"
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2 hover:bg-ink-2 transition-colors"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className={`inline-flex items-center text-[14px] leading-none ${r.combo ? 'border border-bone-dim/30 rounded-full px-1.5 py-0.5' : ''}`}
                  >
                    {r.emoji.join('')}
                  </span>
                  <span className="font-mono text-[11px] tracking-[0.04em] text-bone truncate normal-case">
                    {r.label}
                  </span>
                </span>
                <span className="font-mono text-xs text-bone tabular-nums whitespace-nowrap">
                  {count.toLocaleString()}{' '}
                  <span className="text-bone-dim normal-case tracking-normal">
                    holder{count === 1 ? '' : 's'}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
