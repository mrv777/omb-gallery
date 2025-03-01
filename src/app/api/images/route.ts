import { NextResponse } from 'next/server';
import { GalleryImage } from '@/lib/types';
import fs from 'node:fs';
import path from 'node:path';

// This function gets images from the file system
function getImages(): GalleryImage[] {
  const images: GalleryImage[] = [];
  const colorFolders = ['red', 'blue', 'green', 'orange', 'black'];
  const imagesDir = path.join(process.cwd(), 'public/images');
  
  colorFolders.forEach(color => {
    const colorDir = path.join(imagesDir, color);
    
    // Check if the color directory exists
    if (fs.existsSync(colorDir)) {
      const files = fs.readdirSync(colorDir);
      
      // Filter for image files and create GalleryImage objects
      files.forEach((file: string) => {
        const ext = path.extname(file).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
          images.push({
            src: `/images/${color}/${file}`,
            thumbnail: `/images/${color}/${file}`,
            thumbnailWidth: 250,
            thumbnailHeight: 250,
            color: color,
          });
        }
      });
    }
  });
  
  return images;
}

export async function GET() {
  try {
    const images = getImages();
    return NextResponse.json(images);
  } catch (error) {
    console.error('Error loading images:', error);
    return NextResponse.json({ error: 'Failed to load images' }, { status: 500 });
  }
} 