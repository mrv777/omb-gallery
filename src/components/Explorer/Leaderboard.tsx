import Link from 'next/link';
import { LEADERBOARDS, type LeaderboardKey } from './types';
import { lookupInscription } from '@/lib/inscriptionLookup';
import { formatBtc, formatRelTime, formatTimeUntil, truncateAddr } from '@/lib/format';
import type { ApiHolder, ApiInscription } from '@/components/Activity/types';
import type { ColorFilter } from '@/lib/types';
import { appendColorParam } from '@/lib/colorFilter';
import { lookupWalletLabel } from '@/lib/walletLabels';
import SafeImg from '@/components/SafeImg';
import { Tooltip } from '@/components/ui/Tooltip';
import { HoverImagePreview } from '@/components/ui/HoverImagePreview';

type Props = {
  type: LeaderboardKey;
  showSeeAll?: boolean;
  items: ApiInscription[] | ApiHolder[];
  /** Active color filter — preserved on the "see all →" link. */
  color?: ColorFilter;
};

export default function Leaderboard({ type, items, showSeeAll, color = 'all' }: Props) {
  const meta = LEADERBOARDS[type];
  const isHolders = type === 'top-holders';

  return (
    <div className="border border-ink-2 bg-ink-1">
      <div className="px-4 py-3 border-b border-ink-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-mono text-xs tracking-[0.12em] uppercase text-bone">{meta.title}</h2>
          {showSeeAll && (
            <Link
              href={appendColorParam(`/explorer/${type}`, color)}
              className="font-mono text-[10px] tracking-[0.12em] uppercase text-bone-dim hover:text-bone transition-colors"
            >
              see all →
            </Link>
          )}
        </div>
        <p className="font-mono text-[10px] tracking-[0.04em] text-bone-dim mt-1 normal-case">
          {meta.blurb}
        </p>
      </div>
      <ol className="divide-y divide-ink-2">
        {items.length === 0 && (
          <li className="px-4 py-3 font-mono text-[11px] uppercase tracking-[0.08em] text-bone-dim">
            no data yet
          </li>
        )}
        {!isHolders &&
          (items as ApiInscription[]).map((row, i) => (
            <InscriptionRow key={row.inscription_number} row={row} rank={i + 1} type={type} />
          ))}
        {isHolders &&
          (items as ApiHolder[]).map((row, i) => (
            <HolderRow key={row.group_key} row={row} rank={i + 1} />
          ))}
      </ol>
    </div>
  );
}

export function InscriptionRow({
  row,
  rank,
  type,
}: {
  row: ApiInscription;
  rank: number;
  type: LeaderboardKey;
}) {
  const hit = lookupInscription(row.inscription_number);
  const isExternal = hit?.external ?? false;
  // Rows from a collection without a local detail page link out to ordinals.com.
  const link =
    isExternal && hit?.inscriptionId
      ? `https://ordinals.com/inscription/${hit.inscriptionId}`
      : `/inscription/${row.inscription_number}`;
  const pixelated = hit?.kind === 'bravocados' ? ' [image-rendering:pixelated]' : '';
  const metric = renderInscriptionMetric(row, type);
  const metricTooltip = renderInscriptionMetricTooltip(row, type);
  // Currently-loaned: dim the metric when we're past the estimated expiry.
  // Don't paint it accent-red — the metric here is the loan-start time
  // (chain-truth), not the guess. The "past due" cue belongs in the tooltip,
  // not in a color that misrepresents an estimate as fact.
  const metricClass = 'font-mono text-xs text-bone tabular-nums whitespace-nowrap';
  const innerClass =
    'grid grid-cols-[1.5rem_2.5rem_1fr_auto] items-center gap-3 px-4 py-2 hover:bg-ink-2 transition-colors';
  const metricCell = metricTooltip ? (
    <Tooltip content={metricTooltip}>
      <span className={metricClass}>{metric}</span>
    </Tooltip>
  ) : (
    <span className={metricClass}>{metric}</span>
  );
  const inner = (
    <>
      <span className="font-mono text-[11px] text-bone-dim tabular-nums">{rank}</span>
      <span className="block w-10 h-10 bg-ink-2 overflow-hidden">
        {hit &&
          (isExternal ? (
            <SafeImg
              src={hit.thumbnail}
              alt={`Inscription ${row.inscription_number}`}
              loading="lazy"
              className="w-full h-full object-cover"
            />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={hit.thumbnail}
              alt={`Inscription ${row.inscription_number}`}
              loading="lazy"
              className={`w-full h-full object-cover${pixelated}`}
            />
          ))}
      </span>
      <span className="font-mono text-xs text-bone tabular-nums truncate">
        #{row.inscription_number}
      </span>
      {metricCell}
    </>
  );
  return (
    <li>
      <HoverImagePreview
        src={hit?.thumbnail}
        alt={`Inscription ${row.inscription_number}`}
        external={isExternal}
      >
        {isExternal ? (
          <a href={link} target="_blank" rel="noopener noreferrer" className={innerClass}>
            {inner}
          </a>
        ) : (
          <Link href={link} prefetch={false} className={innerClass}>
            {inner}
          </Link>
        )}
      </HoverImagePreview>
    </li>
  );
}

export function HolderRow({ row, rank }: { row: ApiHolder; rank: number }) {
  // Linked Matrica user: deep-link to the first wallet (which then aggregates
  // across all linked wallets server-side). Unlinked wallet: link to itself.
  const primaryWallet = row.wallets[0] ?? row.group_key;
  // Manual label takes precedence over Matrica — these are curated identity
  // overrides for known special wallets (treasury, mint, etc.) and should
  // win over user-set Matrica handles. For ApiHolder rows the label is
  // looked up against any of the rolled-up wallets (typically just one).
  const manual =
    lookupWalletLabel(primaryWallet) ?? row.wallets.map(lookupWalletLabel).find(Boolean) ?? null;
  const showsUsername = !manual && row.is_user && row.username && !looksLikeAddress(row.username);
  const tooltip = manual
    ? `${manual.name}${manual.subtitle ? ` — ${manual.subtitle}` : ''}\n${primaryWallet}`
    : row.is_user
      ? `Matrica: ${row.username ?? row.group_key} (${row.wallets.length} wallet${row.wallets.length === 1 ? '' : 's'})`
      : row.group_key;
  return (
    <li>
      <Link
        href={`/holder/${primaryWallet}`}
        prefetch={false}
        className="grid grid-cols-[1.5rem_1.25rem_1fr_auto] items-center gap-3 px-4 py-2 hover:bg-ink-2 transition-colors"
      >
        <span className="font-mono text-[11px] text-bone-dim tabular-nums">{rank}</span>
        <span className="block w-5 h-5 bg-ink-2 overflow-hidden rounded-sm">
          {!manual && row.is_user && (
            <SafeImg
              src={row.avatar_url}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
            />
          )}
        </span>
        <Tooltip content={tooltip}>
          <span className="font-mono text-xs text-bone truncate">
            {manual ? (
              <>
                <span className="text-accent-orange">{manual.name}</span>
                {manual.subtitle && (
                  <span className="ml-1.5 text-[10px] text-bone-dim normal-case tracking-normal">
                    {manual.subtitle}
                  </span>
                )}
              </>
            ) : showsUsername ? (
              row.username
            ) : (
              truncateAddr(primaryWallet, 8, 6)
            )}
            {!manual && row.is_user && row.wallets.length > 1 && (
              <span className="ml-1.5 text-[10px] text-bone-dim">×{row.wallets.length}</span>
            )}
          </span>
        </Tooltip>
        <span className="font-mono text-xs text-bone tabular-nums whitespace-nowrap">
          {row.inscription_count.toLocaleString()}
        </span>
      </Link>
    </li>
  );
}

/** A few users on Matrica have their wallet address as their username
 * (the default when no display name is set). Treat those as "no username"
 * so we render the truncated address instead of a long unwieldy string. */
function looksLikeAddress(s: string): boolean {
  return /^bc1[a-z0-9]{30,}$/i.test(s) || /^0x[a-f0-9]{40}$/i.test(s) || s.length > 30;
}

function renderInscriptionMetricTooltip(row: ApiInscription, type: LeaderboardKey): string | null {
  if (type !== 'currently-loaned') return null;
  if (row.estimated_expiration_ts == null) return null;
  const expLine = row.is_overdue
    ? 'Past estimated expiry — awaiting lender claim or repayment'
    : `Estimated expiration ${formatTimeUntil(row.estimated_expiration_ts) || 'soon'}`;
  const termLine = `Likely ${row.estimated_term_days}d term`;
  const basisLine =
    row.estimated_basis === 'vault'
      ? `${row.estimated_sample_count} prior loan${row.estimated_sample_count === 1 ? '' : 's'} from this lender`
      : row.estimated_basis === 'global'
        ? 'No prior loans from this lender — using corpus modal term'
        : 'No prior loan data — defaulting to 30d cap';
  const rangeLine =
    row.estimated_term_min_days != null &&
    row.estimated_term_max_days != null &&
    row.estimated_term_min_days !== row.estimated_term_max_days
      ? `Vault range observed: ${row.estimated_term_min_days}–${row.estimated_term_max_days}d`
      : null;
  return [
    expLine,
    termLine,
    basisLine,
    rangeLine,
    'Estimate only — actual term not visible on chain.',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderInscriptionMetric(row: ApiInscription, type: LeaderboardKey): string {
  switch (type) {
    case 'most-transferred':
      return `${(row.transfer_count + row.sale_count).toLocaleString()}`;
    case 'longest-unmoved':
      return row.last_movement_at ? formatRelTime(row.last_movement_at) : 'never';
    case 'top-volume':
      return formatBtc(row.total_volume_sats) || '—';
    case 'highest-sale':
      return formatBtc(row.highest_sale_sats) || '—';
    case 'most-loaned':
      return `${(row.loan_count ?? 0).toLocaleString()}`;
    case 'currently-loaned':
      // Show the chain-truth origination time as the metric, not the
      // estimated expiration. The estimate is a best-effort guess; surfacing
      // it as the headline metric overstates its certainty. The estimate
      // lives in the tooltip + the inscription detail page instead.
      return row.active_loan_started_at ? formatRelTime(row.active_loan_started_at) : '—';
    case 'top-holders':
      return '';
  }
}
