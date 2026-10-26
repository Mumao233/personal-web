export type Resolution = 1080 | 2048 | 3000 | 4096;
export interface PhotoAsset { id: string; name: string; url: string; width: number; height: number }
export interface Cell { assetId: string; zoom: number; x: number; y: number }
export interface GridPage { id: string; name: string; cells: (Cell | null)[] }
export interface Settings { padding: number; gap: number; resolution: Resolution }
export interface GridDocument { assets: PhotoAsset[]; pages: GridPage[]; activePageId: string; settings: Settings }
export const DEFAULT_SETTINGS: Settings = { padding: 4, gap: 2, resolution: 3000 };
export const createCell = (assetId: string): Cell => ({ assetId, zoom: 1, x: 0.5, y: 0.5 });
export const createPage = (name: string): GridPage => ({ id: crypto.randomUUID(), name, cells: Array(9).fill(null) });
export function createDocument(): GridDocument {
  const page = createPage('画布 1');
  return { assets: [], pages: [page], activePageId: page.id, settings: { ...DEFAULT_SETTINGS } };
}
