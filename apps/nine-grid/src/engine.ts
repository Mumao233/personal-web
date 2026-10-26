import { Zip, ZipPassThrough } from 'fflate';
import type { Cell, GridPage, PhotoAsset, Settings } from './types';

export interface GridRect { x: number; y: number; size: number }
export interface CropRect { sx: number; sy: number; sw: number; sh: number }

const imageCache = new Map<string, Promise<HTMLImageElement>>();
const ownedUrls = new Set<string>();
const renderVersions = new WeakMap<HTMLCanvasElement, number>();
let assetEpoch = 0;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

/** Equal integer squares avoid fractional-pixel seams even with no spacing. */
export function getLayout(size: number, settings: Settings): GridRect[] {
  const edge = Math.max(3, Math.round(Number.isFinite(size) ? size : 3));
  const padding = Math.min(Math.round(edge * clamp(settings.padding, 0, 24) / 100), Math.floor((edge - 3) / 2));
  const gap = Math.min(Math.round(edge * clamp(settings.gap, 0, 24) / 100), Math.floor((edge - 2 * padding - 3) / 2));
  const cellSize = Math.floor((edge - 2 * padding - 2 * gap) / 3);
  const start = Math.floor((edge - 3 * cellSize - 2 * gap) / 2);
  return Array.from({ length: 9 }, (_, index) => ({
    x: start + (index % 3) * (cellSize + gap),
    y: start + Math.floor(index / 3) * (cellSize + gap),
    size: cellSize,
  }));
}

/** Source and destination are both squares: photographs are never stretched. */
export function getCropRect(asset: PhotoAsset, cell: Cell): CropRect {
  if (!(asset.width > 0 && asset.height > 0)) throw new Error('图片尺寸无效，请重新上传。');
  const side = Math.min(asset.width, asset.height) / clamp(cell.zoom, 1, 4);
  return {
    sx: (asset.width - side) * clamp(cell.x, 0, 1),
    sy: (asset.height - side) * clamp(cell.y, 0, 1),
    sw: side,
    sh: side,
  };
}

/** Pass the original cell and cumulative pointer displacement for each gesture. */
export function panCell(cell: Cell, asset: PhotoAsset, dx: number, dy: number, displayCellSize: number): Cell {
  if (!(displayCellSize > 0)) return cell;
  const crop = getCropRect(asset, cell);
  const sourcePerScreenPixel = crop.sw / displayCellSize;
  const overflowX = asset.width - crop.sw;
  const overflowY = asset.height - crop.sh;
  return {
    ...cell,
    x: overflowX > 0 ? clamp(cell.x - dx * sourcePerScreenPixel / overflowX, 0, 1) : 0.5,
    y: overflowY > 0 ? clamp(cell.y - dy * sourcePerScreenPixel / overflowY, 0, 1) : 0.5,
  };
}

function getImage(url: string): Promise<HTMLImageElement> {
  const existing = imageCache.get(url);
  if (existing) return existing;
  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      image.onload = null;
      image.onerror = null;
      if (image.naturalWidth && image.naturalHeight) resolve(image);
      else reject(new Error('图片尺寸无效。'));
    };
    image.onerror = () => {
      image.onload = null;
      image.onerror = null;
      reject(new Error('无法读取这张图片，请使用 JPG、PNG、WebP 等浏览器支持的图片。'));
    };
    image.src = url;
  });
  imageCache.set(url, pending);
  void pending.catch(() => { if (imageCache.get(url) === pending) imageCache.delete(url); });
  return pending;
}

export async function loadPhoto(file: File): Promise<PhotoAsset> {
  if (!file.size) throw new Error(`“${file.name}”是空文件。`);
  const head = await file.slice(0, 2048).text();
  if (/svg/i.test(file.type) || /\.svgz?$/i.test(file.name) || /<svg[\s>]/i.test(head)) {
    throw new Error('暂不支持 SVG，请先转换为 PNG 或 JPG。');
  }
  if (file.type && !file.type.startsWith('image/')) throw new Error(`“${file.name}”不是图片文件。`);
  const epoch = assetEpoch;
  const url = URL.createObjectURL(file);
  ownedUrls.add(url);
  try {
    const image = await getImage(url);
    if (epoch !== assetEpoch) throw new Error('图片导入已取消。');
    return { id: crypto.randomUUID(), name: file.name, url, width: image.naturalWidth, height: image.naturalHeight };
  } catch (error) {
    URL.revokeObjectURL(url);
    ownedUrls.delete(url);
    imageCache.delete(url);
    throw error;
  }
}

export async function drawGrid(
  canvas: HTMLCanvasElement,
  page: GridPage,
  assets: PhotoAsset[],
  settings: Settings,
  size: number,
): Promise<void> {
  const version = (renderVersions.get(canvas) ?? 0) + 1;
  renderVersions.set(canvas, version);
  const assetMap = new Map(assets.map(asset => [asset.id, asset]));
  const prepared = await Promise.all(page.cells.slice(0, 9).map(async cell => {
    if (!cell) return null;
    const asset = assetMap.get(cell.assetId);
    if (!asset) throw new Error('照片来源已丢失，请重新放入这张照片。');
    return { cell, asset, image: await getImage(asset.url) };
  }));
  // A slower earlier render must never overwrite a newer edit or empty canvas.
  if (renderVersions.get(canvas) !== version) return;
  const edge = Math.max(3, Math.round(size));
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法创建画布，请使用新版 Chrome 或 Edge。');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, edge, edge);
  const layout = getLayout(edge, settings);
  prepared.forEach((item, index) => {
    if (!item) return;
    const crop = getCropRect(item.asset, item.cell);
    const rect = layout[index];
    context.drawImage(item.image, crop.sx, crop.sy, crop.sw, crop.sh, rect.x, rect.y, rect.size, rect.size);
  });
}

export async function exportPage(page: GridPage, assets: PhotoAsset[], settings: Settings): Promise<Blob> {
  const canvas = document.createElement('canvas');
  try {
    await drawGrid(canvas, page, assets, settings, settings.resolution);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('导出失败，浏览器内存不足，请降低分辨率后重试。')), 'image/png');
    });
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

const nextFrame = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export async function exportPages(
  pages: GridPage[],
  assets: PhotoAsset[],
  settings: Settings,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  if (!pages.length) throw new Error('请先创建一个画布。');
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let zipError: Error | null = null;
  let finished = false;
  const archive = new Zip((error, data, final) => {
    if (error) zipError = error;
    else chunks.push(data as Uint8Array<ArrayBuffer>);
    if (final) finished = true;
  });
  onProgress?.(0, pages.length);
  try {
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      const png = await exportPage(page, assets, settings);
      const safeName = page.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80) || '画布';
      const entry = new ZipPassThrough(`${String(index + 1).padStart(2, '0')}-${safeName}.png`);
      archive.add(entry);
      entry.push(new Uint8Array(await png.arrayBuffer()), true);
      if (zipError) throw zipError;
      onProgress?.(index + 1, pages.length);
      await nextFrame();
    }
    archive.end();
    if (zipError) throw zipError;
    if (!finished) throw new Error('图片打包未完成，请重试。');
    return new Blob(chunks, { type: 'application/zip' });
  } catch (error) {
    archive.terminate();
    throw error;
  }
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Leave enough time for the browser download manager to consume a large ZIP.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Keep URLs alive through undo/redo; release only when the whole editor unmounts. */
export function releasePhotoAssets(): void {
  assetEpoch++;
  for (const url of ownedUrls) URL.revokeObjectURL(url);
  ownedUrls.clear();
  imageCache.clear();
}
