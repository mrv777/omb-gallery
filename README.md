# OMB Gallery

A zoomable gallery for showcasing OMB images, built with Next.js 15, Next.js Image component, and React Zoom Pan Pinch.

![OMB Gallery Screenshot](screenshot.png)

## Features

- **Zoomable Interface**: Pinch, scroll, or use controls to zoom in and out of the gallery
- **Modal View**: Click on any image to open it in a full-screen modal with navigation
- **Color Filtering**: Filter images by their color category (red, blue, green, orange, black)
- **Unobtrusive Controls**: Filter controls are subtle and don't distract from the viewing experience
- **Responsive Design**: Works on desktop and mobile devices
- **Optimized Images**: Uses Next.js Image component for automatic optimization and lazy loading

## Technologies Used

- Next.js 15
- Next.js Image Component
- React Zoom Pan Pinch
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
