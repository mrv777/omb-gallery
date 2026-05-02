import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import SubpageShell from '@/components/SubpageShell';
import SearchResults from '@/components/Search/SearchResults';
import { runSearch } from '@/lib/search';
import { SITE_NAME, buildSocial } from '@/lib/metadata';

export const dynamic = 'force-dynamic';

const PAGE_LIMIT = 10;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}): Promise<Metadata> {
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const title = q ? `Search "${q.slice(0, 60)}"` : 'Search';
  const description = q
    ? `Search results for "${q.slice(0, 80)}" across inscriptions, holders, Matrica users, and transactions.`
    : 'Search OMB inscriptions, holders, Matrica users, and transactions.';
  return {
    title,
    description,
    robots: { index: false, follow: false },
    ...buildSocial({ title: `${title} · ${SITE_NAME}`, description }),
  };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const results = runSearch(q, { limit: PAGE_LIMIT, allowRedirect: true });

  if (results.redirect) redirect(results.redirect);

  return (
    <SubpageShell>
      <SearchResults q={q} results={results} />
    </SubpageShell>
  );
}
