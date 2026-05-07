import { getRoleById, sortRoleIds, type Role } from '@/lib/roles';

type Props = {
  roleIds: string[];
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
export default function RoleBadges({ roleIds, className }: Props) {
  if (!roleIds || roleIds.length === 0) return null;

  const ordered = sortRoleIds(roleIds);

  return (
    <span
      className={`inline-flex flex-wrap items-center gap-1 text-[15px] leading-none align-middle ${className ?? ''}`}
    >
      {ordered.map((id) => {
        const role = getRoleById(id);
        if (!role) return null;
        return <Badge key={id} role={role} />;
      })}
    </span>
  );
}

function Badge({ role }: { role: Role }) {
  if (role.combo) {
    return (
      <span
        title={role.label}
        className="inline-flex items-center rounded-full border border-bone-dim/30 px-1.5 py-0.5"
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
