import type { Metadata } from 'next';
import Link from 'next/link';
import SubpageShell from '@/components/SubpageShell';
import { INFO_SECTIONS } from '@/lib/infoLinks';

export const metadata: Metadata = {
  title: 'Info',
  description: 'OMB onboarding hub — links and background on OMB, Parasite, and the ecosystem.',
};

export const dynamic = 'force-dynamic';

export default function InfoPage() {
  return (
    <SubpageShell active="info">
      <section className="mx-auto max-w-3xl px-4 pb-16 font-mono uppercase tracking-[0.08em] sm:px-6">
        <h1 className="mb-3 text-2xl text-bone">info</h1>
        <p className="mb-10 text-[11px] leading-relaxed text-bone-dim">
          Everything OMB in one place — the collection, Parasite pool, ZK&apos;s writing, and the
          tools around it.
        </p>

        <div className="border-t border-ink-2 divide-y divide-ink-2">
          {INFO_SECTIONS.map(section => (
            <div key={section.id} className="py-8">
              <h2 className="mb-3 text-lg text-bone">{section.title}</h2>
              <p className="mb-5 text-[11px] leading-relaxed text-bone-dim">{section.blurb}</p>
              <ul className="space-y-1">
                {section.links.map(link => (
                  <li key={link.href + link.label} className="text-[11px]">
                    {link.internal ? (
                      <Link
                        href={link.href}
                        className="inline-block py-0.5 text-bone underline-offset-4 transition hover:underline"
                      >
                        {link.label}{' '}
                        <span aria-hidden="true" className="text-bone-dim">
                          →
                        </span>
                      </Link>
                    ) : (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block py-0.5 text-bone underline-offset-4 transition hover:underline"
                      >
                        {link.label}{' '}
                        <span aria-hidden="true" className="text-bone-dim">
                          ↗
                        </span>
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </SubpageShell>
  );
}
