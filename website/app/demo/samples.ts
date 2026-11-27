/**
 * Sample databases served from public/samples. Chinook also feeds the live
 * preview on the landing page, so keep it small: the preview downloads it on
 * every first visit.
 */
export interface SampleDatabase {
  name: string;
  description: string;
  url: string;
  size: string;
}

export const SAMPLE_DATABASES: readonly SampleDatabase[] = [
  {
    name: 'Chinook',
    description: 'Music store with albums, artists, tracks',
    url: '/samples/chinook.db',
    size: '1.0 MB'
  },
  {
    name: 'Northwind',
    description: 'Classic business database with orders',
    url: '/samples/northwind.db',
    size: '24.7 MB'
  }
];

export const PREVIEW_SAMPLE = SAMPLE_DATABASES[0];
