# OMB Gallery

A zoomable gallery for the OMB ordinal collection, plus an on-chain
activity feed and explorer driven by a self-hosted `ord` node. Live at
[ordinalmaxibiz.wiki](https://ordinalmaxibiz.wiki).

![OMB Gallery Screenshot](screenshot.png)

## Features

- **Gallery** — pinch / scroll / drag to navigate ~9k inscriptions; click
  any image for the modal view; filter by color.
- **Activity feed** (`/activity`) — live transfers, sales, listings,
  mints, and loan events. Marketplace fingerprinting (Magisat / Magic
  Eden / ord.net) plus Satflow enrichment.
- **Explorer** (`/explorer`) — leaderboards: most-transferred, longest-
  unmoved, top sale volume, highest single sale, most borrowed against,
  currently loaned out, top holders, and rarest roles.
- **Slideshow** — sequential or random playback of any filtered set,
  optionally fullscreen, with shareable short-links.
- **Notifications** — opt-in Telegram or Discord webhook alerts for
  per-inscription, per-color, or firehose events.
- **Holder profiles** — Matrica-linked wallet aggregation plus an
  on-chain heuristic that surfaces likely-linked sub-wallets.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind ·
`@tanstack/react-virtual` · `better-sqlite3` · `sharp` (build-time
thumbnails).

## Local development

Requires Node.js 24 LTS and pnpm 10.30+ (`corepack enable`).

```bash
pnpm install
pnpm run optimize-images   # one-time, generates public/optimized-images/
pnpm dev                   # http://localhost:3000
```

The activity / explorer surfaces need an `ord` node and a SQLite DB at
`/data/app.db`; without those env vars the gallery still works
standalone. See `DEPLOYMENT.md` if you want to run the full stack.

## Production build

```bash
pnpm build
pnpm start
```

## Tips

If this project is useful to you, a small Bitcoin tip is appreciated:

```
bc1q0k2wu6wn276fccpjemvkj889q4g8eltwz2kjtc
```

## License

MIT
