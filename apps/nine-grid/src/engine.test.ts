import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawGrid, getCropRect, getLayout, loadPhoto, panCell, releasePhotoAssets } from './engine';
import { createCell, DEFAULT_SETTINGS } from './types';
import type { GridPage, PhotoAsset } from './types';

const asset: PhotoAsset = { id: 'photo', name: 'landscape.png', url: 'blob:landscape', width: 4000, height: 2000 };
const page = (filled: boolean): GridPage => ({ id: 'page', name: '画布', cells: Array.from({ length: 9 }, (_, i) => filled && i === 0 ? createCell('photo') : null) });

afterEach(() => { releasePhotoAssets(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('source cropping and movement', () => {
  it('crops a central square from a wide photo without stretching it', () => {
    expect(getCropRect(asset, createCell(asset.id))).toEqual({ sx: 1000, sy: 0, sw: 2000, sh: 2000 });
  });
  it('uses the original pixel dimensions at high zoom and at the edges', () => {
    expect(getCropRect(asset, { assetId: asset.id, zoom: 4, x: 1, y: 1 })).toEqual({ sx: 3500, sy: 1500, sw: 500, sh: 500 });
    const portrait = { ...asset, width: 1000, height: 4000 };
    expect(getCropRect(portrait, createCell(asset.id))).toEqual({ sx: 0, sy: 1500, sw: 1000, sh: 1000 });
  });
  it('keeps malformed offsets and zoom inside the original photo', () => {
    expect(getCropRect(asset, { assetId: asset.id, zoom: -1, x: -20, y: 10 })).toEqual({ sx: 0, sy: 0, sw: 2000, sh: 2000 });
  });
  it('moves the photograph with the pointer and clamps against white edges', () => {
    const original = { ...createCell(asset.id), zoom: 2 };
    const moved = panCell(original, asset, 100, 50, 200);
    expect(moved.x).toBeCloseTo(1 / 3);
    expect(moved.y).toBeCloseTo(0.25);
    const far = panCell(original, asset, -100_000, 100_000, 200);
    expect(far.x).toBe(1);
    expect(far.y).toBe(0);
    expect(original.x).toBe(0.5);
  });
  it('does not pan on an axis with no overflow', () => {
    expect(panCell(createCell(asset.id), asset, 20, 50, 200).y).toBe(0.5);
    expect(panCell(createCell(asset.id), asset, 20, 50, 0)).toEqual(createCell(asset.id));
  });
});

describe('nine square layout', () => {
  it.each([1080, 2048, 3000, 4096])('uses equal integer squares within the %i pixel canvas', size => {
    const layout = getLayout(size, DEFAULT_SETTINGS);
    expect(layout).toHaveLength(9);
    const widths = new Set(layout.map(rect => rect.size));
    expect(widths.size).toBe(1);
    for (const rect of layout) {
      expect(Number.isInteger(rect.x) && Number.isInteger(rect.y) && Number.isInteger(rect.size)).toBe(true);
      expect(rect.x).toBeGreaterThan(0);
      expect(rect.y).toBeGreaterThan(0);
      expect(rect.x + rect.size).toBeLessThan(size);
      expect(rect.y + rect.size).toBeLessThan(size);
    }
    expect(layout[1].x - layout[0].x - layout[0].size).toBe(Math.round(size * DEFAULT_SETTINGS.gap / 100));
    expect(Math.abs(layout[0].x - (size - layout[8].x - layout[8].size))).toBeLessThanOrEqual(1);
  });
  it('has no seams between adjacent photos when gap is zero', () => {
    const cells = getLayout(2048, { ...DEFAULT_SETTINGS, padding: 0, gap: 0 });
    expect(cells[0].x + cells[0].size).toBe(cells[1].x);
    expect(cells[1].x + cells[1].size).toBe(cells[2].x);
    expect(cells[0].y + cells[0].size).toBe(cells[3].y);
  });
  it('never produces negative or out-of-bounds cells for oversized spacing or a tiny preview', () => {
    for (const edge of [3, 10, 100, 4096]) {
      for (const cell of getLayout(edge, { ...DEFAULT_SETTINGS, padding: 100, gap: 100 })) {
        expect(cell.size).toBeGreaterThanOrEqual(1);
        expect(cell.x).toBeGreaterThanOrEqual(0);
        expect(cell.x + cell.size).toBeLessThanOrEqual(edge);
        expect(cell.y + cell.size).toBeLessThanOrEqual(edge);
      }
    }
  });
});

describe('browser canvas rendering', () => {
  const mockCanvas = () => {
    const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: '' };
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    return { canvas, context };
  };
  it('paints the complete output opaque white even when all nine cells are blank', async () => {
    const { canvas, context } = mockCanvas();
    await drawGrid(canvas, page(false), [], DEFAULT_SETTINGS, 3000);
    expect(context.fillStyle).toBe('#ffffff');
    expect(context.fillRect).toHaveBeenCalledExactlyOnceWith(0, 0, 3000, 3000);
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(canvas.width).toBe(3000);
    expect(canvas.height).toBe(3000);
  });
  it('prevents an old asynchronous image decode from undoing a newer edit', async () => {
    const pending: Array<() => void> = [];
    vi.stubGlobal('Image', class {
      naturalWidth = 4000;
      naturalHeight = 2000;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { pending.push(() => this.onload?.()); }
    });
    const { canvas, context } = mockCanvas();
    const old = drawGrid(canvas, page(true), [asset], DEFAULT_SETTINGS, 3000);
    await drawGrid(canvas, page(false), [asset], DEFAULT_SETTINGS, 1080);
    pending.forEach(complete => complete());
    await old;
    expect(canvas.width).toBe(1080);
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(context.fillRect).toHaveBeenCalledTimes(1);
  });
  it('rejects SVG content even if the file extension and MIME type are disguised', async () => {
    const file = new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], 'picture.png', { type: 'image/png' });
    await expect(loadPhoto(file)).rejects.toThrow('SVG');
  });
});
