// Single source of truth for how each event_type renders across the app.
// Anywhere we surface events to the user (activity feed cards/rows, holder
// profile timeline, inscription detail timeline) imports from here so a new
// event type only needs registering once instead of being added to four
// fall-through ternaries (which is exactly how loan-* events ended up
// silently rendering as 'INSCRIBED').

export type EventType =
  | 'inscribed'
  | 'transferred'
  | 'sold'
  | 'listed'
  | 'loan-originated'
  | 'loan-defaulted'
  | 'loan-repaid'
  | 'loan-unlocked';

export type EventDisplay = {
  /** Short uppercase pill label. */
  label: string;
  /** Tailwind text-color class. Direction-aware surfaces (HolderEventRow's
   *  red/green sent/received) override this for sold + transferred only. */
  color: string;
  /** Tailwind background+border combo for the pill. Same direction-override
   *  applies for sold + transferred. */
  bg: string;
  /** Optional human caption shown beneath the pill (cards / detail rows). */
  subtitle?: string;
};

export const EVENT_DISPLAY: Record<EventType, EventDisplay> = {
  sold: {
    label: 'SOLD',
    color: 'text-accent-green',
    bg: 'bg-accent-green/10 border-accent-green/40',
  },
  transferred: {
    label: 'TRANSFERRED',
    color: 'text-bone',
    bg: 'border-bone-dim/40',
  },
  inscribed: {
    label: 'INSCRIBED',
    color: 'text-accent-orange',
    bg: 'bg-accent-orange/10 border-accent-orange/40',
  },
  listed: {
    label: 'LISTED',
    color: 'text-bone-dim',
    bg: 'border-bone-dim/40',
  },
  'loan-originated': {
    label: 'LOAN ORIGINATED',
    color: 'text-accent-blue',
    bg: 'bg-accent-blue/10 border-accent-blue/40',
    subtitle: 'collateral locked in escrow',
  },
  'loan-defaulted': {
    label: 'LOAN DEFAULTED',
    color: 'text-accent-red',
    bg: 'bg-accent-red/10 border-accent-red/40',
    subtitle: 'lender claimed collateral',
  },
  'loan-repaid': {
    label: 'LOAN REPAID',
    color: 'text-accent-blue',
    bg: 'bg-accent-blue/10 border-accent-blue/40',
    subtitle: 'borrower paid lender',
  },
  'loan-unlocked': {
    label: 'LOAN UNLOCKED',
    color: 'text-accent-orange',
    bg: 'bg-accent-orange/10 border-accent-orange/40',
    subtitle: 'borrower reclaimed collateral',
  },
};

export const LOAN_EVENT_TYPES = new Set<EventType>([
  'loan-originated',
  'loan-defaulted',
  'loan-repaid',
  'loan-unlocked',
]);

export function isLoanEvent(t: EventType): boolean {
  return LOAN_EVENT_TYPES.has(t);
}
