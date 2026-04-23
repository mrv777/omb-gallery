/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  images: {
    // Disable Next.js runtime image optimization since we're pre-optimizing during build
    unoptimized: true,
    // Increase the image sizes array for thumbnail generation
    imageSizes: [100, 200, 336],
    // Set the maximum image size that can be optimized
    formats: ['image/webp', 'image/avif'],
    // Set a reasonable limit for image dimensions
    minimumCacheTTL: 3600, // Cache optimized images for 1 hour
    qualities: [50, 75, 100],
    dangerouslyAllowSVG: false,
    contentDispositionType: 'inline',
  },
  // Increase the size limit for images
  experimental: {
    largePageDataBytes: 128 * 1000, // 128KB
  },
};

export default nextConfig;
