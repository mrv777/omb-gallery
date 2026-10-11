import type { ApiActivityResponse, ApiEvent } from './types';

const compareEvents = (left: ApiEvent, right: ApiEvent) =>
  right.block_timestamp - left.block_timestamp || right.id - left.id;

export function mergeRefreshedEvents(current: ApiEvent[], incoming: ApiEvent[]): ApiEvent[] {
  const byId = new Map(current.map(event => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort(compareEvents);
}

/** Catch up arrivals through the previous newest ordering key, staging every
 * page before publication. Older loaded history is reconciled separately by
 * bounded exact-ID requests, so ordinary refreshes fetch just one head page.
 */
export async function refreshActivityWindow(
  current: ApiEvent[],
  fetchPage: (cursor: string | null) => Promise<ApiActivityResponse>,
  currentCursor: string | null = null
): Promise<ApiActivityResponse> {
  const anchor = current[0];
  const first = await fetchPage(null);
  const byId = new Map(first.events.map(event => [event.id, event]));
  const matrica = { ...first.matrica };
  let page = first;
  const cursors = new Set<string>();

  // Use the tuple, rather than an ID overlap: enrichment may delete, move, or
  // reclassify the old newest event, and timestamps can contain many ties.
  while (anchor && page.next_cursor) {
    const last = page.events.at(-1);
    if (last && compareEvents(last, anchor) >= 0) break;
    if (cursors.has(page.next_cursor)) throw new Error('Activity cursor did not advance');
    cursors.add(page.next_cursor);
    page = await fetchPage(page.next_cursor);
    for (const event of page.events) byId.set(event.id, event);
    Object.assign(matrica, page.matrica);
  }

  const incoming = [...byId.values()].sort(compareEvents);
  const oldBottom = current.at(-1);
  const fetchedBottom = page.events.at(-1);
  // Keep the historical continuation unless the head catch-up fetched past
  // that boundary. This avoids both duplicate continuation pages and gaps.
  const fetchedPastBottom =
    !oldBottom || (fetchedBottom != null && compareEvents(fetchedBottom, oldBottom) >= 0);
  const exhausted = page.next_cursor == null;
  return {
    ...first,
    events: exhausted ? incoming : mergeRefreshedEvents(current, incoming),
    next_cursor: exhausted || fetchedPastBottom ? page.next_cursor : currentCursor,
    matrica,
  };
}
