export interface GalleryImage {
  src: string;
  thumbnail: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
  caption?: string;
  tags?: string[];
  color: string;
}

export type ColorFilter = 'all' | 'red' | 'blue' | 'green' | 'orange' | 'black'; 