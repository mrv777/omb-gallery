// Content for the /info resources hub. Kept as plain data so the page stays a
// thin renderer and links are trivial to edit.

export type InfoLink = {
  label: string;
  href: string;
  /** True for same-site links rendered via <Link> without the ↗ marker. */
  internal?: boolean;
};
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
    id: 'history',
    title: 'History & provenance',
    blurb:
      'How the collection came to be, drop by drop — plus the satoshis underneath it. 8,799 of the 9,001 sit on block-9 sats from January 2009; the 102 red eyes each got their own individually-hunted sat. Every number on the page is recomputed from our index at request time, and every off-chain claim carries a source.',
    links: [
      { label: 'The full history', href: '/history', internal: true },
      { label: 'What the collection sits on', href: '/history#sats', internal: true },
      { label: 'Named sub-series', href: '/history#series', internal: true },
    ],
  },
  {
    id: 'bravocados',
    title: 'Bitcoin Bravocados',
    blurb:
      'The 1,002-piece OMB companion collection — on-chain avocados inscribed as children of one parent. The first 100 sit in a dispensary wallet and are handed out one at a time to Parasite pool miners who land a big share.',
    links: [{ label: 'Browse the collection', href: '/bravocados', internal: true }],
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
