import { GalleryImage } from './types';
import imageData from '../data/collections/omb/inscriptions.json';
import { searchTokensForNumber } from './series';

type ImageEntry = { filename: string; description: string; tags: string[] };
type ImagesByColor = Record<string, ImageEntry[]>;

const THUMBNAIL_SIZE = 128;

// This function returns a list of images for client-side use
export function loadImages(): GalleryImage[] {
  const colorFolders = ['red', 'blue', 'green', 'orange', 'black'];
  const images: GalleryImage[] = [];
  const data = imageData as ImagesByColor;

  colorFolders.forEach(color => {
    const imageObjects = data[color] || [];

    imageObjects.forEach(imageObj => {
      // Remove file extension for thumbnail naming
      const filename = imageObj.filename.replace(/\.[^/.]+$/, '');
      const description = imageObj.description ?? '';
      const tags = imageObj.tags ?? [];
      // The stem IS the inscription number. Parsing it once here saves the
      // series filter and playHref from re-deriving it from `src` on every
      // filter change.
      const number = parseInt(filename, 10);
      // Curated sub-series names, so typing "pirate" in the existing search box
      // finds the catalogued set as well as any description that happens to
      // mention one. Empty for the ~8,930 pieces in no series.
      const seriesTokens = searchTokensForNumber(number);

      images.push({
        src: `/images/${color}/${imageObj.filename}`,
        thumbnail: `/optimized-images/${color}/${filename}_${THUMBNAIL_SIZE}.webp`,
        thumbnailWidth: THUMBNAIL_SIZE,
        thumbnailHeight: THUMBNAIL_SIZE,
        color: color,
        number,
        caption: description,
        tags,
        searchText: `${filename} ${description} ${tags.join(' ')} ${seriesTokens}`.toLowerCase(),
      });
    });
  });

  return images;
}
