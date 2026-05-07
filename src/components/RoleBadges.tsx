import { getRoleById, sortRoleIds, type Role } from '@/lib/roles';

type Props = {
  roleIds: string[];
  /** Truncate to this many badges + show a "+N" overflow chip. */
  max?: number;
  /** Smaller text/spacing for tight rows (e.g. leaderboard). */
  dense?: boolean;
  /** Optional className on the outer flex wrapper. */
  className?: string;
};

/**
 * Subtle, emoji-only badge cluster. Combos render in a thin pill; single-color
 * tiers render as bare emoji runs. Container is `flex flex-wrap` so the row
 * wraps cleanly under a header on mobile.
 *
 * Display priority follows the order of ROLES in src/lib/roles.ts. Reordering
 * that array changes the rendered order everywhere.
 */
export default function RoleBadges({ roleIds, max, dense, className }: Props) {
  if (!roleIds || roleIds.length === 0) return null;

  const ordered = sortRoleIds(roleIds);
  const visible = max != null ? ordered.slice(0, max) : ordered;
  const overflow = max != null ? ordered.length - visible.length : 0;

  const text = dense ? 'text-[13px]' : 'text-[15px]';
  const gap = dense ? 'gap-0.5' : 'gap-1';
  const pillPad = dense ? 'px-1 py-px' : 'px-1.5 py-0.5';

  return (
    <span
      className={`inline-flex flex-wrap items-center ${gap} ${text} leading-none align-middle ${className ?? ''}`}
    >
      {visible.map((id) => {
        const role = getRoleById(id);
        if (!role) return null;
        return <Badge key={id} role={role} pillPad={pillPad} />;
      })}
      {overflow > 0 && (
        <span
          title={`${overflow} more`}
          className={`inline-flex items-center ${pillPad} rounded-full border border-bone-dim/30 text-[10px] tracking-wider text-bone-dim`}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

function Badge({ role, pillPad }: { role: Role; pillPad: string }) {
  if (role.combo) {
    return (
      <span
        title={role.label}
        className={`inline-flex items-center rounded-full border border-bone-dim/30 ${pillPad}`}
      >
        {role.emoji.join('')}
      </span>
    );
  }
  return (
    <span title={role.label} className="inline-flex items-center">
      {role.emoji.join('')}
    </span>
  );
}

