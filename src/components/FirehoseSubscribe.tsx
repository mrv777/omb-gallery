'use client';

import NotificationButton, { BellIcon } from './NotificationButton/NotificationButton';

// "Get all OMB activity in your Discord/Telegram" entry-point. Lives in the
// SubpageShell footer because community server admins are likeliest to be
// browsing /activity or /explorer when they want to wire up a #sales channel.
export default function FirehoseSubscribe() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="normal-case tracking-normal text-bone-dim">
        Get all OMB sales in your channel:
      </span>
      <NotificationButton
        kind="collection"
        targetKey="omb"
        label={
          <span className="inline-flex items-center gap-1.5">
            <BellIcon />
            <span>Subscribe</span>
          </span>
        }
        className="inline-flex items-center gap-1 px-3 h-8 text-[11px] uppercase tracking-[0.08em] text-bone border border-ink-2 hover:border-bone transition-colors"
      />
    </div>
  );
}
