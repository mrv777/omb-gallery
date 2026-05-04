# OMB Gallery

A zoomable gallery for showcasing OMB ordinal images plus an on-chain activity feed and explorer surfaced from a self-hosted `ord` node. Built on Next.js 16 with TanStack Virtual for the gallery, SQLite (`better-sqlite3`) for the activity / explorer side, and Tailwind for the punk-zine palette.

![OMB Gallery Screenshot](screenshot.png)

## Features

- **Zoomable gallery**: pinch / scroll / drag to move around, click any inscription to open the modal with arrow-key navigation
- **Color filter**: red / blue / green / orange / black, with the chosen filter persisted across the activity / explorer surfaces too
- **Activity feed** (`/activity`): live transfers, sales, listings, and loan events for OMB inscriptions. Backed by an `ord` UTXO-diff poller plus Satflow sale enrichment.
- **Explorer** (`/explorer`): leaderboards — most-transferred, longest-unmoved, top sale volume, highest single sale, most borrowed against, **currently loaned out** (active Liquidium loan escrows detected on-chain), and top holders.
- **Slideshow + share**: play a filtered set sequentially or randomly, optionally fullscreen, and mint a shareable short-link to the snapshot.
- **Notifications**: opt-in Telegram or Discord webhook alerts for per-inscription / per-color / firehose events.

## Technologies Used

- Next.js 16 App Router, React 19
- TanStack Virtual (gallery virtualization)
- `better-sqlite3` (SQLite at `/data/app.db` — activity feed, leaderboards, notifications)
- Tailwind CSS

## Installation

### Prerequisites

- Node.js 18.17 or later

### Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/yourusername/omb-gallery.git
   cd omb-gallery
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Generate optimized thumbnails from `public/images/`:

   ```bash
   pnpm run optimize-images
   ```

4. Run the development server:

   ```bash
   pnpm dev
   ```

5. Open [http://localhost:3000](http://localhost:3000) in your browser to see the gallery.

## Usage

### Viewing the Gallery

- **Zoom**: Use the mouse wheel, pinch gesture, or hold Ctrl while scrolling
- **Pan**: Click and drag to move around when zoomed in
- **Filter**: Click the colored buttons in the top-right corner to filter by color
- **View Image**: Click any image to open it in the modal view

### Modal Controls

- **Navigate**: Use the arrow buttons or keyboard arrow keys to move between images
- **Close**: Click the X button, click outside the image, or press Escape to exit the modal
- **View Details**: Image captions are displayed at the bottom of the modal when available

## Project Structure

```
omb-gallery/
├── public/
│   └── images/
│       ├── red/
│       ├── blue/
│       ├── green/
│       ├── orange/
│       └── black/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   └── images/
│   │   │       └── route.ts
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components/
│   │   └── ZoomableGallery.tsx
│   └── lib/
│       └── types.ts
├── scripts/
│   └── copy-images.js
└── package.json
```

## Building for Production

```bash
npm run build
npm run start
```

## License

MIT License
