export interface GalleryImage {
  src: string;
  thumbnail: string;
  thumbnailWidth: number;
  thumbnailHeight: number;
  caption?: string;
  tags?: string[];
  color: string;
  /** Inscription number, parsed once from the filename stem in imageLoader. */
  number: number;
  // Lowercased "<filename> <caption> <tags>" for cheap substring search.
  searchText: string;
}

export type ColorFilter = 'all' | 'red' | 'blue' | 'green' | 'orange' | 'black';
