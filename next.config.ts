import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  reactCompiler: true,
  // better-sqlite3 is a native module — leave it as a runtime require, do not bundle through webpack.
  serverExternalPackages: ['better-sqlite3'],
  images: {
    unoptimized: true,
    imageSizes: [100, 200, 336],
    formats: ['image/webp', 'image/avif'],
    minimumCacheTTL: 3600,
    qualities: [50, 75, 100],
    dangerouslyAllowSVG: false,
    contentDispositionType: 'inline',
  },
};

export default nextConfig;
