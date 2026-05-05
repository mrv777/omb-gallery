'use client';

import * as HoverCardPrimitive from '@radix-ui/react-hover-card';
import { ReactNode } from 'react';
import SafeImg from '@/components/SafeImg';

interface Props {
  src: string | null | undefined;
  alt: string;
  /** SafeImg path needed for remote (bravocados) sources where load can fail. */
  external?: boolean;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}

const SIZE_PX = 192;

export function HoverImagePreview({
  src,
  alt,
  external = false,
  children,
  side = 'right',
  align = 'center',
}: Props) {
  if (!src) return <>{children}</>;

  return (
    <HoverCardPrimitive.Root openDelay={150} closeDelay={50}>
      <HoverCardPrimitive.Trigger asChild>{children}</HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          avoidCollisions
          className="z-[2000] border border-bone-dim/30 bg-ink-1 p-1 shadow-2xl"
          style={{ width: SIZE_PX, height: SIZE_PX }}
        >
          {external ? (
            <SafeImg src={src} alt={alt} className="w-full h-full object-cover" />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={src} alt={alt} className="w-full h-full object-cover" />
          )}
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  );
}
