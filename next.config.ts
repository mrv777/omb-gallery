import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  reactCompiler: true,
  // Native modules — leave as runtime requires, do not bundle through webpack.
  serverExternalPackages: ['better-sqlite3', 'sharp'],
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
