const fs = require('fs');
const path = require('path');

// Path to the images directory
const imagesDir = path.join(process.cwd(), 'public/images');

// Color folders to scan
const colorFolders = ['red', 'blue', 'green', 'orange', 'black'];

// Object to store image filenames by color
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
    
    // Store the sorted array
    imagesByColor[color] = imageFiles;
    
    console.log(`Found ${imageFiles.length} images in ${color} folder`);
  } else {
    console.log(`Directory not found: ${colorDir}`);
    imagesByColor[color] = [];
  }
});

// Generate the code for imageLoader.ts
let code = `import { GalleryImage } from './types';

// This function returns a list of images for client-side use
// Generated automatically by script
export function loadImages(): GalleryImage[] {
  const colorFolders = ['red', 'blue', 'green', 'orange', 'black'];
  const images: GalleryImage[] = [];
  
  // Define all available images by color
  const imagesByColor: Record<string, string[]> = {
`;

// Add each color's array to the code
colorFolders.forEach(color => {
  code += `    ${color}: [\n`;
  
  // Split the array into chunks for better readability
  const files = imagesByColor[color];
  const chunkSize = 5;
  
  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize);
    const line = chunk.map(file => `'${file}'`).join(', ');
    code += `      ${line},\n`;
  }
  
  code += `    ],\n`;
});

code += `  };
  
  colorFolders.forEach(color => {
    const fileNames = imagesByColor[color];
    
    fileNames.forEach(fileName => {
      images.push({
        src: \`/images/\${color}/\${fileName}\`,
        thumbnail: \`/images/\${color}/\${fileName}\`,
        thumbnailWidth: 250,
        thumbnailHeight: 250,
        color: color,
      });
    });
  });
  
  return images;
}`;

// Write the code to a file
fs.writeFileSync('generated-image-loader.ts', code);
console.log('Generated code written to generated-image-loader.ts');

// Also output to console
console.log('\nGenerated code:');
console.log(code); 