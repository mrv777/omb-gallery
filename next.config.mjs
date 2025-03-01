/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    // Enable image optimization
    unoptimized: false,
    // Increase the image sizes array for thumbnail generation
    imageSizes: [100, 200, 336],
    // Set the maximum image size that can be optimized
    formats: ['image/webp', 'image/avif'],
    // Set a reasonable limit for image dimensions
    minimumCacheTTL: 3600, // Cache optimized images for 1 hour
    dangerouslyAllowSVG: false,
    contentDispositionType: 'inline',
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'via.placeholder.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'ordinalmaxibiz.wiki',
        pathname: '/**',
      },
      {
        protocol: 'http',
        hostname: 'ordinalmaxibiz.wiki',
        pathname: '/**',
      },
    ],
  },
  // Increase the size limit for images
  experimental: {
    largePageDataBytes: 128 * 1000, // 128KB
  },
};

export default nextConfig; 