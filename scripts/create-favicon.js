const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function createFavicon() {
  const sourceImagePath = path.join(__dirname, '../public/images/red/89945.jpg');
  const outputPath = path.join(__dirname, '../public/favicon.ico');
  
  try {
    // Create a 32x32 favicon (standard size)
    await sharp(sourceImagePath)
      .resize(32, 32)
      .toFile(path.join(__dirname, '../public/favicon-32.png'));
    
    // Create a 16x16 favicon (also common)
    await sharp(sourceImagePath)
      .resize(16, 16)
      .toFile(path.join(__dirname, '../public/favicon-16.png'));
    
    console.log('Favicon images created successfully!');
    console.log('Note: For a proper .ico file, you may need to use a tool like "png-to-ico" or an online converter.');
    console.log('For now, you can use the PNG files directly in your HTML.');
  } catch (error) {
    console.error('Error creating favicon:', error);
  }
}

createFavicon(); 