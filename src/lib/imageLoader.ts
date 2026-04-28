import { GalleryImage } from "./types";
import imageData from "../data/collections/omb/inscriptions.json";

type ImageEntry = { filename: string; description: string; tags: string[] };
type ImagesByColor = Record<string, ImageEntry[]>;

const THUMBNAIL_SIZE = 128;

// This function returns a list of images for client-side use
export function loadImages(): GalleryImage[] {
  const colorFolders = ["red", "blue", "green", "orange", "black"];
  const images: GalleryImage[] = [];
  const data = imageData as ImagesByColor;

  colorFolders.forEach((color) => {
    const imageObjects = data[color] || [];

    imageObjects.forEach((imageObj) => {
      // Remove file extension for thumbnail naming
      const filename = imageObj.filename.replace(/\.[^/.]+$/, "");
      const description = imageObj.description ?? "";
      const tags = imageObj.tags ?? [];

      images.push({
        src: `/images/${color}/${imageObj.filename}`,
        thumbnail: `/optimized-images/${color}/${filename}_${THUMBNAIL_SIZE}.webp`,
        thumbnailWidth: THUMBNAIL_SIZE,
        thumbnailHeight: THUMBNAIL_SIZE,
        color: color,
        caption: description,
        tags,
        searchText: `${filename} ${description} ${tags.join(" ")}`.toLowerCase(),
      });
    });
  });

  return images;
}
