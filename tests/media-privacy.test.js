import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createServer } from 'node:net';
import sharp from 'sharp';

let child, directory, base, cookie, gpsJpeg;
async function api(path, method = 'GET', body) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, status: response.status, data: await response.json() };
}
async function upload(buffer, name, type = 'application/octet-stream', authenticated = true) {
  const body = new FormData();
  body.append('files', new Blob([buffer], { type }), name);
  const response = await fetch(base + '/api/admin/upload', {
    method: 'POST', headers: authenticated ? { Cookie: cookie } : {}, body,
  });
  return { status: response.status, data: await response.json() };
}
async function getMedia(url, authenticated = false, extra = {}) {
  const response = await fetch(base + url, {
    ...extra, headers: { ...(authenticated ? { Cookie: cookie } : {}), ...extra.headers },
  });
  return { response, status: response.status, buffer: Buffer.from(await response.arrayBuffer()) };
}
async function draft(url, record) {
  const result = await api('/admin/posts/' + (record?.id || 'new') + '/draft', 'PUT', {
    revision: record?.revision || 0, title: 'Isolated synthetic media fixture', cover: url,
    document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fixture article' }] }] },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function publication(record, action = 'publish') {
  const result = await api(`/admin/posts/${record.id}/${action}`, 'POST', { revision: record.revision });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function profile(input) {
  const admin = await api('/admin');
  const result = await api('/admin/profile', 'PUT', { ...input, revision: admin.data.profile.revision });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.profile;
}
function hasGps(exif) {
  if (!exif) return false;
  const tiff = exif.subarray(6);
  const little = tiff.subarray(0, 2).toString() === 'II';
  const u16 = offset => little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
  const u32 = offset => little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
  const offset = u32(4);
  for (let index = 0; index < u16(offset); index++)
    if (u16(offset + 2 + index * 12) === 0x8825) return true;
  return false;
}
async function verifyCleanImage(buffer) {
  const metadata = await sharp(buffer, { animated: true }).metadata();
  for (const key of ['exif', 'iptc', 'xmp', 'icc', 'orientation'])
    assert.equal(metadata[key], undefined, 'unexpected retained metadata: ' + key);
  return metadata;
}
async function colourFixture() {
  const width = 80, height = 120, pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    pixels[(y * width + x) * 3 + (y < height / 2 ? 0 : 2)] = 255;
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .withMetadata({ orientation: 6 })
    .withIccProfile('p3')
    .withExifMerge({ IFD0: { Artist: 'Synthetic privacy fixture' }, IFD3: {
      GPSLatitudeRef: 'N', GPSLatitude: '20/1 30/1 0/1',
      GPSLongitudeRef: 'E', GPSLongitude: '110/1 0/1 0/1',
    } }).toBuffer();
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'personal-media-privacy-'));
  const listener = createServer();
  await new Promise(ok => listener.listen(0, '127.0.0.1', ok));
  const port = listener.address().port;
  await new Promise(ok => listener.close(ok));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.js', '--production'], {
    env: { ...process.env, DATA_DIR: directory, PORT: String(port), TEST_MODE: '1', ATLAS_ENABLED: '0',
      PUBLIC_ORIGINS: 'https://mumao.site,http://mumao.site,http://8.138.100.213' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((ok, fail) => {
    let logs = '';
    const timer = setTimeout(() => fail(Error('Media test server did not start: ' + logs)), 15000);
    child.stderr.on('data', chunk => { logs += chunk; });
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes('Personal Space:')) { clearTimeout(timer); ok(); }
    });
    child.once('exit', code => { clearTimeout(timer); fail(Error(`Media test server exited ${code}: ${logs}`)); });
  });
  const setup = await api('/setup', 'POST', { username: 'media-fixture-admin', password: 'media-privacy-test-password-123' });
  assert.equal(setup.status, 200);
  cookie = setup.response.headers.get('set-cookie').split(';')[0];
  gpsJpeg = await colourFixture();
  assert.equal(hasGps((await sharp(gpsJpeg).metadata()).exif), true, 'fixture must genuinely contain a GPS IFD');
});
after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise(ok => child.once('exit', ok));
    child.kill();
    await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('JPEG upload removes GPS and other metadata while preserving orientation and colour', async () => {
  const result = await upload(gpsJpeg, 'synthetic-location.jpeg', 'image/jpeg');
  assert.equal(result.status, 200);
  const url = result.data.files[0].url;
  assert.match(url, /\.jpg$/);
  assert.equal((await getMedia(url)).status, 401);
  const served = await getMedia(url, true);
  assert.equal(served.status, 200);
  assert.equal(served.response.headers.get('content-type'), 'image/jpeg');
  assert.match(served.response.headers.get('cache-control'), /private.*no-store/);
  assert.equal(served.response.headers.get('x-content-type-options'), 'nosniff');
  const metadata = await verifyCleanImage(served.buffer);
  assert.deepEqual([metadata.width, metadata.height], [120, 80]);
  const pixels = await sharp(served.buffer).raw().toBuffer();
  const sample = x => [...pixels.subarray((40 * 120 + x) * 3, (40 * 120 + x) * 3 + 3)];
  assert.ok(sample(20)[2] > 180 && sample(20)[0] < 60, 'clockwise orientation should put blue on the left');
  assert.ok(sample(100)[0] > 180 && sample(100)[2] < 60, 'clockwise orientation should put red on the right');
  await verifyCleanImage(await readFile(join(directory, 'uploads', basename(url))));
  assert.deepEqual(await readdir(join(directory, 'media-incoming')), []);
});

test('draft/public/withdrawn references gate access, including cached and shared images', async () => {
  const first = await upload(gpsJpeg, 'first.jpg');
  const second = await upload(gpsJpeg, 'second.jpg');
  const a = first.data.files[0].url, b = second.data.files[0].url;
  let article = await draft(a);
  assert.equal((await getMedia(a)).status, 401);
  assert.equal((await getMedia(a, true)).status, 200);
  article = await publication(article);
  const visible = await getMedia(a);
  assert.equal(visible.status, 200);
  article = await draft(b, article);
  assert.equal((await getMedia(a)).status, 200, 'saved draft must not remove the live cover');
  assert.equal((await getMedia(b)).status, 401, 'saved draft must not make its cover public');
  article = await publication(article, 'unpublish');
  assert.equal((await getMedia(a, false, { headers: { 'If-None-Match': visible.response.headers.get('etag') || '' } })).status, 401);
  const other = await publication(await draft(a));
  assert.equal((await getMedia(a)).status, 200, 'another published reference keeps shared media public');
  await publication(other, 'unpublish');
  assert.equal((await getMedia(a)).status, 401);
  assert.equal((await getMedia(a, true, { method: 'HEAD' })).status, 200);
});

test('profile publication references respect hidden custom fields and revision updates', async () => {
  const result = await upload(gpsJpeg, 'profile.jpg');
  const url = result.data.files[0].url;
  await profile({ fields: [{ id: 'private-image', label: 'Hidden media', value: url, visible: false }] });
  assert.equal((await getMedia(url)).status, 401);
  await profile({ portrait: url });
  assert.equal((await getMedia(url)).status, 200);
  await profile({ portrait: '' });
  assert.equal((await getMedia(url)).status, 401);
});

test('legacy originals are never returned; cleaned copies are cached without altering source files', async () => {
  const name = 'legacy-gps.jpg', url = '/uploads/' + name;
  await writeFile(join(directory, 'uploads', name), gpsJpeg);
  await publication(await draft(url));
  for (const authenticated of [false, true, false]) {
    const served = await getMedia(url, authenticated);
    assert.equal(served.status, 200);
    await verifyCleanImage(served.buffer);
    assert.notDeepEqual(served.buffer, gpsJpeg);
  }
  assert.deepEqual(await readFile(join(directory, 'uploads', name)), gpsJpeg);
  assert.ok((await readdir(join(directory, 'media-cache'))).length > 0);
});

test('legacy cache MIME follows the decoded format instead of a misleading filename', async () => {
  const name = 'legacy-jpeg-named-png.png', url = '/uploads/' + name;
  await writeFile(join(directory, 'uploads', name), gpsJpeg);
  await publication(await draft(url));
  for (let attempt = 0; attempt < 2; attempt++) {
    const served = await getMedia(url);
    assert.equal(served.status, 200);
    assert.equal((await sharp(served.buffer).metadata()).format, 'jpeg');
    assert.equal(served.response.headers.get('content-type'), 'image/jpeg');
  }
});

test('GIF and WebP uploads retain both animation frames, timing, loop count and colours', async () => {
  const width = 16, height = 32, pageHeight = 16;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    pixels[(y * width + x) * 3 + (y < pageHeight ? 0 : 2)] = 255;
  for (const format of ['gif', 'webp']) {
    const input = await sharp(pixels, { raw: { width, height, channels: 3, pageHeight } })
      [format]({ loop: 2, delay: [100, 200], lossless: true }).toBuffer();
    const result = await upload(input, 'two-frame.' + format, 'image/' + format);
    assert.equal(result.status, 200, format);
    const served = await getMedia(result.data.files[0].url, true);
    assert.equal(served.status, 200);
    const metadata = await verifyCleanImage(served.buffer);
    assert.equal(metadata.pages, 2);
    assert.equal(metadata.pageHeight, 16);
    assert.equal(metadata.loop, 2);
    assert.deepEqual(metadata.delay, [100, 200]);
    const decoded = await sharp(served.buffer, { animated: true }).removeAlpha().raw().toBuffer();
    assert.ok(decoded[0] > 180 && decoded[2] < 60);
    const frame2 = width * pageHeight * 3;
    assert.ok(decoded[frame2 + 2] > 180 && decoded[frame2] < 60);
  }
});

test('PDF upload remains available to the admin and to explicit published links', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  const result = await upload(pdf, 'synthetic-document.pdf', 'application/pdf');
  assert.equal(result.status, 200);
  const url = result.data.files[0].url;
  assert.equal((await getMedia(url)).status, 401);
  const admin = await getMedia(url, true);
  assert.equal(admin.status, 200);
  assert.match(admin.response.headers.get('content-type'), /^application\/pdf/);
  assert.deepEqual(admin.buffer, pdf);
  await profile({ fields: [{ id: 'pdf-link', label: 'Fixture PDF', value: 'Read PDF', href: url, visible: true }] });
  assert.deepEqual((await getMedia(url)).buffer, pdf);
  await profile({ fields: [] });
  assert.equal((await getMedia(url)).status, 401);
});

test('published absolute PDF and image references authorize only configured site origins', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  const uploadedPdf = await upload(pdf, 'absolute-project-link.pdf', 'application/pdf');
  assert.equal(uploadedPdf.status, 200);
  const pdfUrl = uploadedPdf.data.files[0].url;
  let project;
  for (const origin of ['https://example.test', 'https://mumao.site']) {
    const saved = await api('/admin/projects/' + (project?.id || 'new') + '/draft', 'PUT', {
      revision: project?.revision || 0,
      title: 'Isolated absolute PDF project link', link: origin + pdfUrl,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const published = await api(`/admin/projects/${saved.data.id}/publish`, 'POST', { revision: saved.data.revision });
    assert.equal(published.status, 200, JSON.stringify(published.data));
    project = published.data;
    const served = await getMedia(pdfUrl);
    assert.equal(served.status, origin === 'https://mumao.site' ? 200 : 401, origin);
    if (served.status === 200) assert.deepEqual(served.buffer, pdf);
  }
  const uploadedImage = await upload(gpsJpeg, 'absolute-cover.jpg', 'image/jpeg');
  assert.equal(uploadedImage.status, 200);
  const imageUrl = uploadedImage.data.files[0].url;
  let post;
  for (const origin of ['https://example.test', 'https://mumao.site']) {
    post = await publication(await draft(origin + imageUrl, post));
    const served = await getMedia(imageUrl);
    assert.equal(served.status, origin === 'https://mumao.site' ? 200 : 401, origin);
    if (served.status === 200) await verifyCleanImage(served.buffer);
  }
});

test('new upload responses reuse the stored sanitized bytes without a second lossy encode', async () => {
  const uploaded = await upload(gpsJpeg, 'single-encode.jpg', 'image/jpeg');
  assert.equal(uploaded.status, 200);
  const url = uploaded.data.files[0].url;
  const stored = await readFile(join(directory, 'uploads', basename(url)));
  await verifyCleanImage(stored);
  assert.notDeepEqual(stored, gpsJpeg, 'the stored upload must already be sanitized');
  for (let attempt = 0; attempt < 2; attempt++) {
    const served = await getMedia(url, true);
    assert.equal(served.status, 200);
    assert.deepEqual(served.buffer, stored, 'first and repeated requests must return the existing sanitized encoding');
  }
});

test('invalid content and unsafe paths are rejected without leaving uploaded residue', async () => {
  const beforeNames = await readdir(join(directory, 'uploads'));
  for (const [buffer, name] of [
    [Buffer.from('<html>not an image</html>'), 'fake.jpg'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>'), 'fake.png'],
    [Buffer.from('not a pdf'), 'fake.pdf'],
    [gpsJpeg, 'file.exe'],
  ]) assert.equal((await upload(buffer, name)).status, 400, name);
  const batch = new FormData();
  batch.append('files', new Blob([gpsJpeg], { type: 'image/jpeg' }), 'valid-first.jpg');
  batch.append('files', new Blob([Buffer.from('bad image')], { type: 'image/png' }), 'invalid-second.png');
  assert.equal((await fetch(base + '/api/admin/upload', { method: 'POST', headers: { Cookie: cookie }, body: batch })).status, 400);
  assert.equal((await upload(gpsJpeg, 'unauthorized.jpg', 'image/jpeg', false)).status, 401);
  assert.deepEqual(await readdir(join(directory, 'uploads')), beforeNames);
  // Response completion can precede the finally cleanup by one event-loop turn.
  for (let attempt = 0; attempt < 20 && (await readdir(join(directory, 'media-incoming'))).length; attempt++)
    await new Promise(ok => setTimeout(ok, 25));
  const residue = await readdir(join(directory, 'media-incoming'));
  const residueTypes = await Promise.all(residue.map(async name => (await readFile(join(directory, 'media-incoming', name))).subarray(0, 64).toString()));
  assert.deepEqual(residue, [], 'Unexpected incoming residue: ' + JSON.stringify(residueTypes));
  for (const path of ['/uploads/%2e%2e%2foutside.jpg', '/uploads/.hidden.jpg', '/uploads/nested/image.jpg', '/uploads/missing.jpg'])
    assert.equal((await getMedia(path, true)).status, 404, path);
});
