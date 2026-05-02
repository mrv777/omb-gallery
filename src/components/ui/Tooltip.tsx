'use client';

import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { ReactNode } from 'react';

type Side = 'top' | 'right' | 'bottom' | 'left';
type Align = 'start' | 'center' | 'end';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  delayDuration?: number;
  contentClassName?: string;
  disabled?: boolean;
}

function isEmpty(content: ReactNode): boolean {
  if (content == null || content === false) return true;
  if (typeof content === 'string') return content.trim() === '';
  return false;
}

export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  sideOffset = 6,
  delayDuration,
  contentClassName,
  disabled,
}: TooltipProps) {
  if (disabled || isEmpty(content)) return <>{children}</>;

  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      {/* The span is a server-rendered primitive so Radix's `Slot` (used by
       * `Trigger asChild`) always has a valid React element to clone props
       * onto during SSR. Without it, when React's RSC streamer defers a
       * Client-Component child (e.g. a `<Link>`) to a separate chunk, Slot's
       * `isValidElement(children)` check fails on the placeholder and the
       * trigger renders to nothing — silently dropping the tile from SSR
       * HTML. `display:contents` keeps the wrapper invisible to layout while
       * still propagating hover/focus events from descendants. */}
      <TooltipPrimitive.Trigger asChild>
        <span style={{ display: 'contents' }}>{children}</span>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          avoidCollisions
          className={
            'omb-tooltip z-[2000] max-w-[min(90vw,360px)] select-none break-words whitespace-pre-wrap ' +
            'rounded-sm border border-bone-dim/30 bg-ink-1 px-2 py-1 ' +
            'font-mono text-[11px] leading-snug tracking-[0.04em] text-bone shadow-lg ' +
            (contentClassName ?? '')
          }
          style={{ transformOrigin: 'var(--radix-tooltip-content-transform-origin)' }}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-ink-1 stroke-bone-dim/30" width={8} height={4} />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;
