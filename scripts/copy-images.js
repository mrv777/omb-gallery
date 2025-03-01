const fs = require('fs');
const path = require('path');

// Create the public/images directory if it doesn't exist
const publicImagesDir = path.join(__dirname, '../public/images');
if (!fs.existsSync(publicImagesDir)) {
  fs.mkdirSync(publicImagesDir, { recursive: true });
}

// Source directory with the original images
const sourceDir = path.join(__dirname, '../ordinal_maxi_biz');

// Color folders
const colorFolders = ['red', 'blue', 'green', 'orange', 'black'];

// Copy each color folder to the public/images directory
colorFolders.forEach(color => {
  const sourceColorDir = path.join(sourceDir, color);
  const targetColorDir = path.join(publicImagesDir, color);
  
  // Skip if source directory doesn't exist
  if (!fs.existsSync(sourceColorDir)) {
    console.log(`Source directory ${sourceColorDir} does not exist. Skipping.`);
    return;
  }
  
  // Create target color directory if it doesn't exist
  if (!fs.existsSync(targetColorDir)) {
    fs.mkdirSync(targetColorDir, { recursive: true });
  }
  
  // Copy all image files from source to target
  const files = fs.readdirSync(sourceColorDir);
  files.forEach(file => {
    if (file.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
      const sourceFile = path.join(sourceColorDir, file);
      const targetFile = path.join(targetColorDir, file);
      
      fs.copyFileSync(sourceFile, targetFile);
      console.log(`Copied ${sourceFile} to ${targetFile}`);
    }
  });
});

console.log('Image copying complete!'); 