import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PurchaseError,
  purchasePhaseLabel,
  type PurchasePhase,
} from '@/components/Marketplace/BuyDialog';

describe('mobile marketplace purchase status', () => {
  it.each<[PurchasePhase, string]>([
    ['idle', 'confirm buy'],
    ['preparing', 'preparing'],
    ['signing', 'signing'],
  ])('labels the %s phase as %s', (phase, label) => {
    expect(purchasePhaseLabel(phase)).toBe(label);
  });

  it('renders failures as an assertive alert beside the pinned actions', () => {
    const html = renderToStaticMarkup(
      createElement(PurchaseError, { error: 'Not enough spendable funds.' })
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('data-testid="purchase-error"');
    expect(html).toContain('Not enough spendable funds.');
  });

  it('renders no empty alert before a failure exists', () => {
    expect(renderToStaticMarkup(createElement(PurchaseError, { error: null }))).toBe('');
  });
});
