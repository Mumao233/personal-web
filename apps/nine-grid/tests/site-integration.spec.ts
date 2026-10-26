import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
// @ts-expect-error pngjs is a test-only JavaScript package.
import { PNG } from 'pngjs';

test.use({ reducedMotion: 'reduce' });

function syntheticPhoto() {
  const png = new PNG({ width: 900, height: 600 });
  for (let offset = 0; offset < png.data.length; offset += 4) png.data.set([143, 91, 57, 255], offset);
  return { name: '本地验收合成照片.png', mimeType: 'image/png', buffer: PNG.sync.write(png) as Buffer };
}

function inspectEditorTraffic(page: Page, origin: string) {
  const outgoing: string[] = [];
  const errors: string[] = [];
  page.on('request', request => {
    if (!/^https?:/i.test(request.url())) return;
    const url = new URL(request.url());
    if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) {
      outgoing.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return { outgoing, errors };
}

async function screenshot(page: Page, testInfo: TestInfo, filename: string) {
  await page.screenshot({ path: testInfo.outputPath(filename), fullPage: true });
}

async function assertWhiteExport(page: Page, testInfo: TestInfo, filename: string) {
  await page.getByRole('button', { name: /^1080/ }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出图片', exact: true }).click();
  const download = await downloading;
  const outputPath = testInfo.outputPath(filename);
  await download.saveAs(outputPath);
  const png = PNG.sync.read(await readFile(outputPath));
  expect([png.width, png.height]).toEqual([1080, 1080]);
  for (const [x, y] of [[2, 2], [1077, 1077], [875, 875], [200, 875]]) {
    const offset = (y * png.width + x) * 4;
    expect([...png.data.subarray(offset, offset + 4)]).toEqual([255, 255, 255, 255]);
  }
  const center = (200 * png.width + 200) * 4;
  expect([...png.data.subarray(center, center + 4)]).toEqual([143, 91, 57, 255]);
}

test('九格只从作品与项目进入，首页、全局导航和主题区没有额外入口', async ({ page, baseURL }, testInfo) => {
  const origin = new URL(baseURL!).origin;
  await page.goto(`${origin}/`);
  await expect(page.getByRole('navigation', { name: '主要导航', exact: true })).toBeVisible();
  await expect(page.locator('a[href^="/nine-grid"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /九格|九宫格/ })).toHaveCount(0);
  await expect(page.locator('header')).not.toContainText('九格');
  await screenshot(page, testInfo, 'home-without-nine-grid-entry.png');

  await page.getByRole('navigation', { name: '主要导航', exact: true }).getByRole('link', { name: '作品与项目', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/?page=projects`);
  const entry = page.locator('a.nine-grid-project-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry).toHaveAttribute('href', '/nine-grid/');
  await expect(entry).toContainText('九格');
  await expect(page.locator('header a[href^="/nine-grid"], nav a[href^="/nine-grid"]')).toHaveCount(0);
  await entry.scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'projects-entry-desktop.png');
  await entry.click();
  await expect(page).toHaveURL(`${origin}/nine-grid/`);
  await expect(page.getByTestId('grid-cell-0')).toBeVisible();
  await expect(page.getByRole('button', { name: /切换到.*主题/ })).toHaveCount(0);
  const back = page.getByRole('link', { name: '返回作品与项目', exact: true });
  await expect(back).toHaveAttribute('href', '/?page=projects');
  await back.click();
  await expect(page).toHaveURL(`${origin}/?page=projects`);
  await expect(page.locator('a.nine-grid-project-entry')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/`);
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  const mobileNavigation = page.getByRole('navigation', { name: '手机导航', exact: true });
  await expect(mobileNavigation).toBeVisible();
  await expect(mobileNavigation.locator('a[href^="/nine-grid"]')).toHaveCount(0);
  await expect(mobileNavigation).not.toContainText('九格');
  await screenshot(page, testInfo, 'mobile-navigation-without-nine-grid-entry.png');
});

for (const theme of ['dark', 'light'] as const) {
  test(`${theme} 主站主题继承到九格，照片不外传且导出仍是白底`, async ({ page, baseURL }, testInfo) => {
    const origin = new URL(baseURL!).origin;
    await page.addInitScript(value => localStorage.setItem('personal-space-theme', value), theme);
    await page.goto(`${origin}/?page=projects`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.locator('a.nine-grid-project-entry').click();
    await expect(page).toHaveURL(`${origin}/nine-grid/`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
    await expect(page.getByRole('button', { name: /切换到.*主题/ })).toHaveCount(0);
    const traffic = inspectEditorTraffic(page, origin);
    await page.getByTestId('upload-input').setInputFiles(syntheticPhoto());
    await expect(page.getByTestId('grid-cell-0')).not.toHaveAttribute('data-asset-id', '');
    await page.getByTestId('grid-cell-0').click();
    await expect(page.locator('.photo-library img')).toHaveAttribute('src', /^blob:/);
    const panelColor = await page.locator('.left-panel').evaluate(element => getComputedStyle(element).backgroundColor);
    const channels = panelColor.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    if (theme === 'dark') expect(Math.max(...channels)).toBeLessThan(80);
    else expect(Math.min(...channels)).toBeGreaterThan(180);
    await expect(page.locator('.canvas-wrap')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await assertWhiteExport(page, testInfo, `${theme}-white-canvas.png`);
    const closeNotice = page.getByRole('button', { name: '关闭提示', exact: true });
    if (await closeNotice.isVisible()) await closeNotice.click();
    await screenshot(page, testInfo, `${theme}-editor-desktop.png`);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('link', { name: '返回作品与项目', exact: true })).toBeVisible();
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
    await page.getByTestId('grid-cell-0').click();
    await page.getByRole('button', { name: '调整裁切', exact: true }).click();
    await expect(page.getByLabel('照片缩放', { exact: true })).toBeEnabled();
    await screenshot(page, testInfo, `${theme}-editor-390px.png`);
    expect(traffic.outgoing).toEqual([]);
    expect(traffic.errors).toEqual([]);
  });
}

test('另一主站标签页切换主题时，已打开的九格随之更新', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await page.goto('./');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const website = await context.newPage();
  await website.goto(`${origin}/?page=projects`);
  await website.locator('.desktop-theme-toggle').click();
  await expect(website.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await website.locator('.desktop-theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.canvas-wrap')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await website.close();
});
