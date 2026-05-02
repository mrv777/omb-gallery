import Link from 'next/link';
import SafeImg from '@/components/SafeImg';
import { lookupInscription } from '@/lib/inscriptionLookup';
import {
  formatBtc,
  formatRelTime,
  looksLikeAddress,
  marketplaceLabel,
  truncateAddr,
} from '@/lib/format';
import { lookupWalletLabel } from '@/lib/walletLabels';
import { eventLink, type SearchResults as SearchResultsType } from '@/lib/searchTypes';

type Props = { q: string; results: SearchResultsType };

export default function SearchResults({ q, results }: Props) {
  const total =
    results.inscriptions.length +
    results.holders.length +
    results.users.length +
    results.events.length;

  return (
    <div className="px-4 sm:px-6 max-w-4xl mx-auto pb-16">
      <header className="mb-6">
        <h1 className="font-mono text-xs tracking-[0.12em] uppercase text-bone-dim">
          Search results
        </h1>
        <p className="font-mono text-base text-bone mt-1 break-all">
          {q ? <>&ldquo;{q}&rdquo;</> : <span className="text-bone-dim">— enter a query —</span>}
        </p>
        <p className="font-mono text-[11px] tracking-[0.04em] uppercase text-bone-dim mt-1">
          {q ? `${total} ${total === 1 ? 'result' : 'results'}` : ''}
        </p>
      </header>

      {!q && <EmptyTips />}
      {q && total === 0 && <NoResults q={q} />}

      {results.inscriptions.length > 0 && (
        <Section title="Inscriptions">
          <ul className="divide-y divide-ink-2 border border-ink-2 bg-ink-1">
            {results.inscriptions.map(insc => (
              <InscriptionRow key={`${insc.collection_slug}:${insc.inscription_number}`} item={insc} />
            ))}
          </ul>
        </Section>
      )}

      {results.holders.length > 0 && (
        <Section title="Holders">
          <ul className="divide-y divide-ink-2 border border-ink-2 bg-ink-1">
            {results.holders.map(h => (
              <HolderRow key={h.address} item={h} />
            ))}
          </ul>
        </Section>
      )}

      {results.users.length > 0 && (
        <Section title="Matrica users">
          <ul className="divide-y divide-ink-2 border border-ink-2 bg-ink-1">
            {results.users.map(u => (
              <UserRow key={u.user_id} item={u} />
            ))}
          </ul>
        </Section>
      )}

      {results.events.length > 0 && (
        <Section title="Transactions">
          <ul className="divide-y divide-ink-2 border border-ink-2 bg-ink-1">
            {results.events.map(e => (
              <EventRow key={e.id} item={e} />
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="font-mono text-[11px] tracking-[0.12em] uppercase text-bone-dim mb-2">
        {title}
      </h2>
      {children}
    </section>
  );
}

function InscriptionRow({ item }: { item: SearchResultsType['inscriptions'][number] }) {
  const hit = lookupInscription(item.inscription_number);
  const isOmb = item.collection_slug === 'omb';
  const isExternal = hit?.external ?? false;
  const href = isOmb
    ? `/inscription/${item.inscription_number}`
    : isExternal && hit?.inscriptionId
      ? `https://ordinals.com/inscription/${hit.inscriptionId}`
      : item.inscription_id
        ? `https://ordinals.com/inscription/${item.inscription_id}`
        : `/inscription/${item.inscription_number}`;
  const inner = (
    <div className="grid grid-cols-[2.5rem_1fr_auto] items-center gap-3 px-4 py-2.5 hover:bg-ink-2 transition-colors">
      <span className="block w-10 h-10 bg-ink-2 overflow-hidden">
        {hit &&
          (isExternal ? (
            <SafeImg
              src={hit.thumbnail}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
            />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={hit.thumbnail}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
            />
          ))}
      </span>
      <span className="font-mono text-xs text-bone tabular-nums truncate">
        #{item.inscription_number}
        {item.color && (
          <span className="ml-2 text-[10px] uppercase tracking-[0.08em] text-bone-dim">
            {item.color}
          </span>
        )}
        {item.collection_slug && item.collection_slug !== 'omb' && (
          <span className="ml-2 text-[10px] uppercase tracking-[0.08em] text-accent-orange">
            {item.collection_slug}
          </span>
        )}
      </span>
      <span className="font-mono text-[10px] text-bone-dim tracking-[0.04em] truncate max-w-[14ch]">
        {item.current_owner ? truncateAddr(item.current_owner, 5, 4) : ''}
      </span>
    </div>
  );
  return (
    <li>
      {isOmb ? (
        <Link href={href} prefetch={false} className="block">
          {inner}
        </Link>
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer" className="block">
          {inner}
        </a>
      )}
    </li>
  );
}

function HolderRow({ item }: { item: SearchResultsType['holders'][number] }) {
  const manual = lookupWalletLabel(item.address);
  const display = manual ? manual.name : truncateAddr(item.address, 8, 6);
  return (
    <li>
      <Link
        href={`/holder/${item.address}`}
        prefetch={false}
        className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 hover:bg-ink-2 transition-colors"
      >
        <span className="font-mono text-xs text-bone truncate">
          {manual ? <span className="text-accent-orange">{display}</span> : display}
        </span>
        <span className="font-mono text-[11px] text-bone-dim tabular-nums whitespace-nowrap">
          {item.inscription_count} held
        </span>
      </Link>
    </li>
  );
}

function UserRow({ item }: { item: SearchResultsType['users'][number] }) {
  const showsName = item.username && !looksLikeAddress(item.username);
  const target = item.first_wallet ?? '';
  const inner = (
    <div className="grid grid-cols-[1.5rem_1fr_auto] items-center gap-3 px-4 py-2.5 hover:bg-ink-2 transition-colors">
      <span className="block w-6 h-6 bg-ink-2 overflow-hidden rounded-sm">
        <SafeImg src={item.avatar_url} alt="" loading="lazy" className="w-full h-full object-cover" />
      </span>
      <span className="font-mono text-xs text-bone truncate">
        {showsName ? `@${item.username}` : truncateAddr(target, 8, 6)}
      </span>
      <span className="font-mono text-[11px] text-bone-dim tabular-nums whitespace-nowrap">
        {item.wallet_count} {item.wallet_count === 1 ? 'wallet' : 'wallets'}
      </span>
    </div>
  );
  if (!target) {
    return <li className="opacity-60">{inner}</li>;
  }
  return (
    <li>
      <Link href={`/holder/${target}`} prefetch={false} className="block">
        {inner}
      </Link>
    </li>
  );
}

function EventRow({ item }: { item: SearchResultsType['events'][number] }) {
  const label =
    item.event_type === 'sold'
      ? `Sold ${formatBtc(item.sale_price_sats) || ''}${item.marketplace ? ` · ${marketplaceLabel(item.marketplace)}` : ''}`
      : item.event_type === 'transferred'
        ? 'Transfer'
        : item.event_type === 'inscribed'
          ? 'Inscribed'
          : 'Listed';
  const link = eventLink(item);
  const cls =
    'grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 hover:bg-ink-2 transition-colors';
  const inner = (
    <>
      <span className="font-mono text-xs text-bone truncate">
        #{item.inscription_number}
        <span className="ml-2 text-[10px] uppercase tracking-[0.08em] text-bone-dim">{label}</span>
        {item.collection_slug && item.collection_slug !== 'omb' && (
          <span className="ml-2 text-[10px] uppercase tracking-[0.08em] text-accent-orange">
            {item.collection_slug}
          </span>
        )}
      </span>
      <span className="font-mono text-[10px] text-bone-dim tracking-[0.04em] whitespace-nowrap">
        {formatRelTime(item.block_timestamp)}
      </span>
    </>
  );
  return (
    <li>
      {link.external ? (
        <a href={link.href} target="_blank" rel="noopener noreferrer" className={cls}>
          {inner}
        </a>
      ) : (
        <Link href={link.href} prefetch={false} className={cls}>
          {inner}
        </Link>
      )}
    </li>
  );
}

function NoResults({ q }: { q: string }) {
  return (
    <div className="border border-ink-2 bg-ink-1 px-4 py-6 font-mono text-xs text-bone-dim">
      <div className="mb-2 uppercase tracking-[0.08em]">No matches for &ldquo;{q}&rdquo;.</div>
      <EmptyTips compact />
    </div>
  );
}

function EmptyTips({ compact = false }: { compact?: boolean } = {}) {
  return (
    <div
      className={
        compact
          ? 'font-mono text-[11px] text-bone-dim normal-case tracking-normal'
          : 'border border-ink-2 bg-ink-1 px-4 py-6 font-mono text-xs text-bone-dim'
      }
    >
      <div className={compact ? '' : 'mb-2 uppercase tracking-[0.08em]'}>Try one of:</div>
      <ul className="list-disc list-inside space-y-1">
        <li>
          an inscription number — e.g. <span className="text-bone">1234</span>
        </li>
        <li>
          a wallet address — paste the full <span className="text-bone">bc1…</span>, or just the last
          few characters you remember
        </li>
        <li>
          a Matrica username — e.g. <span className="text-bone">@alice</span>
        </li>
        <li>
          a transaction id — 64-char hex from any explorer
        </li>
      </ul>
    </div>
  );
}
