export type PollStatusDisplay = {
  message: string;
  tone: 'warning' | 'error';
};

const TRANSIENT_CONNECTIVITY_ERROR =
  /(?:network error:\s*)?fetch failed|econn(?:refused|reset)|etimedout|socket hang up|timed? out/i;

/** Turn the persisted ord poll status into calm, actionable visitor-facing copy. */
export function describeOrdPollStatus(status: string | null): PollStatusDisplay | null {
  if (status == null || status.startsWith('ok')) return null;

  // A missing reveal during initial block download is expected, not a fault.
  if (/^404 from ord :: inscription/.test(status)) {
    return {
      message: 'ord catching up — recent events may be delayed',
      tone: 'warning',
    };
  }

  // Host maintenance and dependency restarts can briefly make the local ord
  // endpoint unreachable. Keep the condition visible without presenting a raw
  // implementation error to visitors; operators can still see it via title.
  if (TRANSIENT_CONNECTIVITY_ERROR.test(status)) {
    return {
      message: 'indexer reconnecting — recent activity may be delayed',
      tone: 'warning',
    };
  }

  return {
    message: `poll error: ${status.slice(0, 80)}`,
    tone: 'error',
  };
}
