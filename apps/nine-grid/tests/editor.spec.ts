import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
// pngjs is deliberately used to inspect the actual downloaded PNG pixels.
// @ts-expect-error pngjs is a test-only JavaScript package.
import { PNG } from 'pngjs';
import { unzipSync } from 'fflate';

type Pixel = [number, number, number, number];
type DecodedPng = { width: number; height: number; data: Buffer };

function fixture(name: string, width: number, height: number, color: (x: number, y: number) => Pixel) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      png.data.set(color(x, y), offset);
    }
  }
  return { name, mimeType: 'image/png', buffer: PNG.sync.write(png) as Buffer };
}

const striped = fixture('横向三色原图.png', 1800, 1200, x =>
  x < 600 ? [238, 68, 68, 255] : x < 1200 ? [34, 170, 102, 255] : [51, 102, 238, 255]);
const blue = fixture('竖向蓝色原图.png', 1200, 1800, () => [51, 102, 238, 255]);
const transparent = fixture('透明背景原图.png', 1200, 1200, () => [0, 0, 0, 0]);

function pixel(png: DecodedPng, x: number, y: number): number[] {
  const offset = (Math.floor(y) * png.width + Math.floor(x)) * 4;
  return [...png.data.subarray(offset, offset + 4)];
}

async function setRange(page: Page, label: string, value: string) {
  const input = page.getByLabel(label, { exact: true });
  if (await input.getAttribute('type') === 'range') {
    const minimum = Number(await input.getAttribute('min') ?? 0);
    const step = Number(await input.getAttribute('step') ?? 1);
    await input.focus();
    await input.press('Home');
    for (let count = 0; count < Math.round((Number(value) - minimum) / step); count++) {
      await input.press('ArrowRight');
    }
  } else {
    await input.fill(value);
  }
  await expect(input).toHaveValue(value);
  await input.press('Tab');
}

async function downloadPng(page: Page, testInfo: TestInfo, name: string): Promise<DecodedPng> {
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出图片', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.png$/i);
  const outputPath = testInfo.outputPath(name);
  await download.saveAs(outputPath);
  return PNG.sync.read(await readFile(outputPath)) as DecodedPng;
}

function observeErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

test('多图导入、拖动换位、清空和撤销重做', async ({ page }) => {
  const errors = observeErrors(page);
  await page.goto('./');
  await expect(page.getByTestId('grid-cell-0')).toHaveAttribute('data-asset-id', '');
  await page.getByTestId('upload-input').setInputFiles([striped, blue]);
  const first = page.getByTestId('grid-cell-0');
  const second = page.getByTestId('grid-cell-1');
  await expect(first).not.toHaveAttribute('data-asset-id', '');
  await expect(second).not.toHaveAttribute('data-asset-id', '');
  const firstId = await first.getAttribute('data-asset-id');
  const secondId = await second.getAttribute('data-asset-id');
  for (let i = 2; i < 9; i++) await expect(page.getByTestId(`grid-cell-${i}`)).toHaveAttribute('data-asset-id', '');
  await first.dragTo(second);
  await expect(first).toHaveAttribute('data-asset-id', secondId!);
  await expect(second).toHaveAttribute('data-asset-id', firstId!);
  await first.click();
  await page.getByRole('button', { name: '清空格子', exact: true }).click();
  await expect(first).toHaveAttribute('data-asset-id', '');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(first).toHaveAttribute('data-asset-id', secondId!);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(first).toHaveAttribute('data-asset-id', '');
  await page.keyboard.press('Control+z');
  await expect(first).toHaveAttribute('data-asset-id', secondId!);
  expect(errors).toEqual([]);
});

test('点击空格上传、替换及外部文件拖放均定位到正确格子', async ({ page }) => {
  const errors = observeErrors(page);
  await page.goto('./');
  const choosing = page.waitForEvent('filechooser');
  await page.getByTestId('grid-cell-4').click();
  await (await choosing).setFiles(striped);
  await expect(page.getByTestId('grid-cell-4')).not.toHaveAttribute('data-asset-id', '');
  const original = await page.getByTestId('grid-cell-4').getAttribute('data-asset-id');
  await expect(page.getByTestId('grid-cell-0')).toHaveAttribute('data-asset-id', '');
  const replacing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '替换照片', exact: true }).click();
  await (await replacing).setFiles(blue);
  await expect(page.getByTestId('grid-cell-4')).not.toHaveAttribute('data-asset-id', original!);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByTestId('grid-cell-4')).toHaveAttribute('data-asset-id', original!);
  const dataTransfer = await page.evaluateHandle(({ bytes, name }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
    return transfer;
  }, { bytes: [...blue.buffer], name: '拖入照片.png' });
  await page.getByTestId('grid-cell-7').dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
  await expect(page.getByTestId('grid-cell-7')).not.toHaveAttribute('data-asset-id', '');
  await expect(page.getByTestId('grid-cell-4')).toHaveAttribute('data-asset-id', original!);
  await expect(page.getByTestId('grid-cell-0')).toHaveAttribute('data-asset-id', '');
  expect(errors).toEqual([]);
});

test('四档 PNG 保留正确尺寸、不透明白底、间距和空白格', async ({ page }, testInfo) => {
  const errors = observeErrors(page);
  await page.goto('./');
  await page.getByTestId('upload-input').setInputFiles([striped, blue, transparent]);
  await expect(page.getByTestId('grid-cell-2')).not.toHaveAttribute('data-asset-id', '');
  await setRange(page, '四周留白', '5');
  await setRange(page, '格子间距', '3');
  for (const size of [1080, 2048, 3000, 4096]) {
    await page.getByRole('button', { name: new RegExp(`^${size}`) }).click();
    const png = await downloadPng(page, testInfo, `九格-${size}.png`);
    expect([png.width, png.height]).toEqual([size, size]);
    expect(pixel(png, 2, 2)).toEqual([255, 255, 255, 255]);
    expect(pixel(png, size - 2, size - 2)).toEqual([255, 255, 255, 255]);
    expect(pixel(png, size * .82, size * .82)).toEqual([255, 255, 255, 255]);
    expect(pixel(png, size * .82, size * .19)).toEqual([255, 255, 255, 255]);
    expect(pixel(png, size * .34, size * .19)).toEqual([255, 255, 255, 255]);
    expect(pixel(png, size * .5, size * .19)).toEqual([51, 102, 238, 255]);
  }
  expect(errors).toEqual([]);
});

test('缩放与拖动裁切会改变实际导出内容，并可撤销', async ({ page }, testInfo) => {
  const errors = observeErrors(page);
  await page.goto('./');
  await page.getByTestId('upload-input').setInputFiles(striped);
  await expect(page.getByTestId('grid-cell-0')).not.toHaveAttribute('data-asset-id', '');
  await page.getByTestId('grid-cell-0').click();
  await page.getByRole('button', { name: '调整裁切', exact: true }).click();
  await setRange(page, '照片缩放', '2');
  await page.getByRole('button', { name: /^1080/ }).click();
  const before = await downloadPng(page, testInfo, '裁切-移动前.png');
  expect(pixel(before, 200, 200)).toEqual([34, 170, 102, 255]);
  const bounds = await page.getByTestId('grid-cell-0').boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * .15, bounds!.y + bounds!.height * .5);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * .95, bounds!.y + bounds!.height * .5, { steps: 12 });
  await page.mouse.up();
  const after = await downloadPng(page, testInfo, '裁切-移动后.png');
  expect(pixel(after, 200, 200)).toEqual([238, 68, 68, 255]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  const restored = await downloadPng(page, testInfo, '裁切-撤销.png');
  expect(pixel(restored, 200, 200)).toEqual([34, 170, 102, 255]);
  expect(errors).toEqual([]);
});

test('十张照片生成多个画布并导出包含完整 PNG 的 ZIP', async ({ page }, testInfo) => {
  const errors = observeErrors(page);
  await page.goto('./');
  const photos = Array.from({ length: 10 }, (_, i) => ({ ...blue, name: `照片-${i + 1}.png` }));
  await page.getByTestId('upload-input').setInputFiles(photos);
  await expect(page.getByRole('button', { name: '切换到画布 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^1080/ }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: /^导出全部/ }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.zip$/i);
  const outputPath = testInfo.outputPath('批量九格.zip');
  await download.saveAs(outputPath);
  const files = unzipSync(new Uint8Array(await readFile(outputPath)));
  const names = Object.keys(files).filter(name => name.endsWith('.png'));
  expect(names).toHaveLength(2);
  let populatedCenters = 0;
  for (const name of names) {
    const png = PNG.sync.read(Buffer.from(files[name])) as DecodedPng;
    expect([png.width, png.height]).toEqual([1080, 1080]);
    for (const y of [.19, .5, .81]) for (const x of [.19, .5, .81]) {
      if (pixel(png, 1080 * x, 1080 * y).join() === '51,102,238,255') populatedCenters++;
    }
  }
  expect(populatedCenters).toBe(10);
  await page.getByRole('button', { name: '批量生成', exact: true }).click();
  await expect(page.locator('.page-item')).toHaveCount(4);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.page-item')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('滑杆保持焦点时仍可使用撤销快捷键', async ({ page }) => {
  const errors = observeErrors(page);
  await page.goto('./');
  const gap = page.getByLabel('格子间距', { exact: true });
  await expect(gap).toHaveValue('2');
  await gap.focus();
  await gap.press('ArrowRight');
  await expect(gap).toHaveValue('2.1');
  await gap.press('Control+z');
  await expect(gap).toHaveValue('2');
  expect(errors).toEqual([]);
});

test('批量排版保留手动空白页，删除后新增画布不重名', async ({ page }) => {
  const errors = observeErrors(page);
  await page.goto('./');
  await page.getByTestId('upload-input').setInputFiles(blue);
  await expect(page.getByTestId('grid-cell-0')).not.toHaveAttribute('data-asset-id', '');
  await page.getByRole('button', { name: '新增画布', exact: true }).click();
  await page.getByRole('button', { name: '新增画布', exact: true }).click();
  await page.getByRole('button', { name: '切换到画布 2', exact: true }).click();
  await page.getByRole('button', { name: '删除当前画布', exact: true }).click();
  await page.getByRole('button', { name: '新增画布', exact: true }).click();
  await expect(page.getByRole('button', { name: '切换到画布 4', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '切换到画布 3', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '批量生成', exact: true }).click();
  await expect(page.locator('.page-item')).toHaveCount(4);
  await page.getByRole('button', { name: '切换到画布 3', exact: true }).click();
  for (let i = 0; i < 9; i++) await expect(page.getByTestId(`grid-cell-${i}`)).toHaveAttribute('data-asset-id', '');
  expect(errors).toEqual([]);
});

test('窄屏可操作，无水平溢出', async ({ page }) => {
  const errors = observeErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await page.getByTestId('upload-input').setInputFiles(blue);
  await expect(page.getByTestId('grid-cell-0')).not.toHaveAttribute('data-asset-id', '');
  await expect(page.getByRole('button', { name: '导出图片', exact: true })).toBeVisible();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
  expect(errors).toEqual([]);
});
