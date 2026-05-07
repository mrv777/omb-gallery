import Link from 'next/link';
import { ROLES } from '@/lib/roles';

type Props = {
  /** Holder count per role id. Roles missing from the map render as 0. */
  countsByRole: Record<string, number>;
};

/**
 * Card on the /explorer dashboard listing every role + its holder count.
 * Order follows the ROLES array in src/lib/roles.ts — rarest/hardest first.
 * Reorder ROLES to change display order everywhere. Click any row (or the
 * "see all" link) to jump to /explorer/roles for the full holder lists.
 */
export default function RarestRolesCard({ countsByRole }: Props) {
  return (
    <div className="border border-ink-2 bg-ink-1">
      <div className="px-4 py-3 border-b border-ink-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-mono text-xs tracking-[0.12em] uppercase text-bone">Roles</h2>
          <Link
            href="/explorer/roles"
            className="font-mono text-[10px] tracking-[0.12em] uppercase text-bone-dim hover:text-bone transition-colors"
          >
            see all →
          </Link>
        </div>
        <p className="font-mono text-[10px] tracking-[0.04em] text-bone-dim mt-1 normal-case">
          Earned by Matrica-linked holders based on the colors they hold. Rarest first.
        </p>
      </div>
      {/* Two columns on desktop so 11 roles fit without a tall card; one on mobile.
          Top border on every li except the first row (items 1 and 2 on desktop;
          item 1 on mobile) gives a clean horizontal grid with no fancy classes. */}
      <ol className="grid grid-cols-1 sm:grid-cols-2">
        {ROLES.map((role, i) => {
          const count = countsByRole[role.id] ?? 0;
          // First row needs no top border. On desktop the first row is items 0
          // AND 1 (2-col grid), so item 1 also drops its top border at sm+.
          const borderClass =
            i === 0
              ? ''
              : i === 1
                ? 'border-t border-ink-2 sm:border-t-0'
                : 'border-t border-ink-2';
          return (
            <li key={role.id} className={borderClass}>
              <Link
                href="/explorer/roles"
                title={role.label}
                className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2 hover:bg-ink-2 transition-colors"
              >
                <span
                  className={`inline-flex items-center text-[14px] leading-none ${role.combo ? 'border border-bone-dim/30 rounded-full px-1.5 py-0.5 self-start' : ''}`}
                >
                  {role.emoji.join('')}
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
