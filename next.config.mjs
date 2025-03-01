/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    // Enable image optimization
    unoptimized: false,
    // Increase the device sizes array for better responsive images
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    // Increase the image sizes array for thumbnail generation
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    // Set the maximum image size that can be optimized
    formats: ['image/webp', 'image/avif'],
    // Set a reasonable limit for image dimensions
    minimumCacheTTL: 60, // Cache optimized images for 60 seconds
    dangerouslyAllowSVG: false,
    contentDispositionType: 'inline',
    remotePatterns: [],
  },
  // Increase the size limit for images
  experimental: {
    largePageDataBytes: 128 * 1000, // 128KB
  },
};

export default nextConfig; 