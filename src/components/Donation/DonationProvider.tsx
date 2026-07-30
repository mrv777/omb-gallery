'use client';

import dynamic from 'next/dynamic';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

const DonationDialog = dynamic(() => import('./DonationDialog'), { ssr: false });

type DonationContextValue = {
  openDonation: (returnFocusTo?: HTMLElement | null) => void;
  closeDonation: () => void;
};

const DonationContext = createContext<DonationContextValue | null>(null);

export default function DonationProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const openDonation = useCallback((returnFocusTo?: HTMLElement | null) => {
    returnFocusRef.current = returnFocusTo ?? (document.activeElement as HTMLElement | null);
    setOpen(true);
  }, []);

  const closeDonation = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => {
      const target = returnFocusRef.current;
      if (target?.isConnected) target.focus();
      returnFocusRef.current = null;
    });
  }, []);

  const value = useMemo(() => ({ openDonation, closeDonation }), [openDonation, closeDonation]);

  return (
    <DonationContext.Provider value={value}>
      {children}
      {open ? <DonationDialog onClose={closeDonation} /> : null}
    </DonationContext.Provider>
  );
}

export function useDonation(): DonationContextValue {
  const context = useContext(DonationContext);
  if (!context) throw new Error('useDonation must be used inside DonationProvider');
  return context;
}
