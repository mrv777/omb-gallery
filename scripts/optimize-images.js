const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Configuration
const SOURCE_DIR = path.join(process.cwd(), 'public/images');
const OUTPUT_DIR = path.join(process.cwd(), 'public/optimized-images');
const THUMBNAIL_SIZES = [48, 128]; // 48px for high zoom-out, 128px for normal

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Process all color folders
async function processImages() {
  console.log('Starting image optimization...');
  
  // Get all color folders
  const colorFolders = fs.readdirSync(SOURCE_DIR).filter(item => {
    const itemPath = path.join(SOURCE_DIR, item);
    return fs.statSync(itemPath).isDirectory() && !item.startsWith('.');
  });
  
  console.log(`Found ${colorFolders.length} color folders: ${colorFolders.join(', ')}`);
  
  // Process each color folder
  for (const color of colorFolders) {
    const colorSourceDir = path.join(SOURCE_DIR, color);
    const colorOutputDir = path.join(OUTPUT_DIR, color);
    
    // Create color output directory
    if (!fs.existsSync(colorOutputDir)) {
      fs.mkdirSync(colorOutputDir, { recursive: true });
    }
    
    // Get all image files in the color folder
    const imageFiles = fs.readdirSync(colorSourceDir).filter(file => {
      return file.match(/\.(jpg|jpeg|png|webp)$/i);
    });
    
    console.log(`Processing ${imageFiles.length} images in ${color} folder...`);
    
    // Process each image
    for (const imageFile of imageFiles) {
      const sourcePath = path.join(colorSourceDir, imageFile);
      
      // Create original optimized version
      const outputFilename = path.parse(imageFile).name;
      const outputExt = '.webp'; // Convert all to WebP for better compression
      
      try {
        // Create thumbnails
        for (const size of THUMBNAIL_SIZES) {
          const thumbnailPath = path.join(
            colorOutputDir, 
            `${outputFilename}_${size}${outputExt}`
          );
          
          await sharp(sourcePath)
            .resize(size, size, { fit: 'inside' })
            .webp({ quality: 50 })
            .toFile(thumbnailPath);
        }
      } catch (error) {
        console.error(`Error processing ${sourcePath}:`, error);
      }
    }
  }
  
  console.log('Image optimization complete!');
}

// Run the optimization
processImages().catch(err => {
  console.error('Error during image optimization:', err);
  process.exit(1);
});
