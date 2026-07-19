// Content for the /info resources hub. Kept as plain data so the page stays a
// thin renderer and links are trivial to edit.

export type InfoLink = { label: string; href: string };
export type InfoSection = { id: string; title: string; blurb: string; links: InfoLink[] };

export const INFO_SECTIONS: InfoSection[] = [
  {
    id: 'omb',
    title: 'OMB',
    blurb:
      'Ordinal Maxi Biz — hand-drawn black-and-white heads inscribed on Bitcoin, where eye color is tied to the block a piece was inscribed on. There is no official OMB website; this wiki is the hub. Find the community on X and Discord.',
    links: [
      { label: 'X / @OrdinalMaxiBiz', href: 'https://x.com/OrdinalMaxiBiz' },
      { label: 'Discord', href: 'https://discord.gg/ordinalmaxibiz' },
    ],
  },
  {
    id: 'parasite',
    title: 'Parasite pool',
    blurb:
      'A zero-fee Bitcoin mining pool founded by ZK for home / pleb miners — "plebs eat first." When the pool finds a block, the worker who solved it takes 1 BTC outright and the rest is split by shares. Payouts are over Lightning. ParaApp is the mobile companion for connecting a wallet and watching your workers.',
    links: [
      { label: 'parasite.space', href: 'https://parasite.space' },
      { label: 'X / @Parasite_wtf', href: 'https://x.com/Parasite_wtf' },
      { label: 'ParaApp — iOS', href: 'https://apps.apple.com/us/app/paraapp/id6757406849' },
      {
        label: 'ParaApp — Android',
        href: 'https://play.google.com/store/apps/details?id=app.paraapp',
      },
      { label: 'GitHub / parasitepool', href: 'https://github.com/parasitepool/para' },
    ],
  },
  {
    id: 'reading',
    title: 'Reading',
    blurb:
      "ZK's Substack covers Ordinals, rare sats, mining, and the thinking behind Parasite — including the manifesto that launched the pool.",
    links: [
      { label: "ZK's Substack", href: 'https://zkshark.substack.com/' },
      {
        label: 'Parasite Pool: Igniting the Mining Insurrection',
        href: 'https://zkshark.substack.com/p/parasite-pool-igniting-the-mining',
      },
    ],
  },
  {
    id: 'related',
    title: 'Tools',
    blurb: 'The wallet / Lightning infrastructure the ecosystem leans on.',
    links: [{ label: 'Xverse wallet', href: 'https://www.xverse.app' }],
  },
];
