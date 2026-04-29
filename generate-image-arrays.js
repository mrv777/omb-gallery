const fs = require('fs');
const path = require('path');

// Path to the images directory
const imagesDir = path.join(process.cwd(), 'public/images');

// Color folders to scan
const colorFolders = ['red', 'blue', 'green', 'orange', 'black'];

// Object to store image data by color
const imagesByColor = {};

// Scan each color folder
colorFolders.forEach(color => {
  const colorDir = path.join(imagesDir, color);

  // Check if the color directory exists
  if (fs.existsSync(colorDir)) {
    // Get all files in the directory
    const files = fs.readdirSync(colorDir);

    // Filter for image files and sort them
    const imageFiles = files
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
      })
      .sort(); // Sort filenames alphabetically

    // Transform into objects with filename and description
    const imageObjects = imageFiles.map(filename => ({
      filename,
      description: '', // Empty description field that can be populated later
      tags: [], // Empty tags array
    }));

    // Store the sorted array of objects
    imagesByColor[color] = imageObjects;

    console.log(`Found ${imageObjects.length} images in ${color} folder`);
  } else {
    console.log(`Directory not found: ${colorDir}`);
    imagesByColor[color] = [];
  }
});

// Ensure output directory exists
fs.mkdirSync('src/data', { recursive: true });

// Write the JSON file
fs.writeFileSync('src/data/images.json', JSON.stringify(imagesByColor, null, 2));

// Output summary
const total = Object.values(imagesByColor).reduce((sum, arr) => sum + arr.length, 0);
console.log(`\nGenerated src/data/images.json with ${total} images`);
