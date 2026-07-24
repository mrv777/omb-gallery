import Link from 'next/link';

export type ChaseTile = {
  id: string;
  /** The number that makes it a chase. */
  headline: string;
  label: string;
  href: string;
};

/**
 * Orientation strip: the handful of facts that give a newcomer something to
 * aim at, each linking to the section that backs it up.
 *
 * Deliberately an INDEX, not a section of its own. Everything here is already
 * argued properly further down the page — restating it in a second "grails"
 * block would mean two places to keep in sync and two places to disagree. And
 * there is no hand-picked list: every tile is derived, so nobody has to
 * adjudicate whose piece got featured.
 */
export default function ChaseBoard({ tiles }: { tiles: ChaseTile[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-ink-2 border border-ink-2 mb-12">
      {tiles.map(t => (
        <Link
          key={t.id}
          href={t.href}
          className="group bg-ink-1 p-3 sm:p-4 hover:bg-ink-0 transition-colors"
        >
          <div className="font-mono text-lg sm:text-xl text-bone tracking-[0.04em] group-hover:text-accent-orange transition-colors">
            {t.headline}
          </div>
          <div className="font-mono mt-1 text-[10px] leading-relaxed uppercase tracking-[0.08em] text-bone-dim">
            {t.label}
          </div>
        </Link>
      ))}
    </div>
  );
}
