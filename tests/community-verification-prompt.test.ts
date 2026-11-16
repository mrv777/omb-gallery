import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CommunityVerificationPrompt, {
  type MatricaState,
} from '@/components/Marketplace/CommunityVerificationPrompt';

function render(state: MatricaState, nexusVerificationEnabled = false) {
  return renderToStaticMarkup(
    createElement(CommunityVerificationPrompt, {
      state,
      nexusVerificationEnabled,
      discordInviteUrl: 'https://discord.gg/ordinalmaxibiz',
      matricaUrl: 'https://matrica.io/settings',
    })
  );
}

describe('post-purchase community verification', () => {
  it.each<MatricaState>([
    { status: 'loading' },
    { status: 'none' },
    { status: 'unknown' },
    { status: 'linked', username: 'bc1placeholder', placeholder: true },
    { status: 'linked', username: 'collector', placeholder: false },
  ])('keeps Discord available when the profile state is $status', state => {
    expect(render(state)).toContain('href="https://discord.gg/ordinalmaxibiz"');
    expect(render(state)).not.toContain('before you can join');
  });

  it('distinguishes lookup failure from a missing profile', () => {
    expect(render({ status: 'unknown' })).toContain('could not check');
    expect(render({ status: 'unknown' })).not.toContain('No completed Matrica profile');
    expect(render({ status: 'none' })).toContain('No completed Matrica profile');
  });

  it('does not promise Nexus Discord verification without server configuration', () => {
    const html = render({ status: 'none' });
    expect(html).not.toContain('set up Nexus on ORD.NET');
    expect(html).not.toContain('Verify through Matrica or Nexus');
    expect(html).toContain('href="/profile"');
    expect(html).toContain('optional and separate from Discord verification');
  });

  it('offers both configured verification providers without unsupported URL parameters', () => {
    const html = render({ status: 'none' }, true);
    expect(html).toContain('Verify through Matrica or Nexus');
    expect(html).toContain('href="https://ord.net/"');
    expect(html).toContain('href="https://matrica.io/settings"');
    expect(html).not.toContain('?wallet=');
  });

  it('does not equate a Matrica profile with completed Discord verification', () => {
    const html = render({ status: 'linked', username: 'collector', placeholder: false });
    expect(html).toContain('@collector');
    expect(html).toContain('Discord verification is managed separately');
  });

  it('rejects non-web URLs supplied through configuration', () => {
    const html = renderToStaticMarkup(
      createElement(CommunityVerificationPrompt, {
        state: { status: 'none' },
        nexusVerificationEnabled: false,
        discordInviteUrl: 'javascript:alert(1)',
        matricaUrl: 'javascript:alert(1)',
      })
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('join Discord</a>');
    expect(html).toContain('href="https://matrica.io/settings"');
  });
});
