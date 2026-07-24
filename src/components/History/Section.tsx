import type { ReactNode } from 'react';

/**
 * Shared section chrome for /history. Kept here rather than repeated per
 * section so the page reads as a list of facts rather than a list of divs.
 */
export default function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mb-12 scroll-mt-16">
      <h2 className="font-mono text-lg text-bone uppercase tracking-[0.08em] mb-2">{title}</h2>
      {lede && (
        <p className="font-mono mb-5 max-w-2xl text-[11px] leading-relaxed text-bone-dim uppercase tracking-[0.08em]">
          {lede}
        </p>
      )}
      {children}
    </section>
  );
}
