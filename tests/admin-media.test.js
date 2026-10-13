import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { loadPreviewMedia, MAX_MEDIA_BYTES, mediaCachePath, prepareMedia, savePreparedMedia } from '../server/media-processing.js';
import { executeAdminRequest } from '../server/admin-cli.js';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const fixtureImage = colour => sharp({ create: { width: 16, height: 16, channels: 3, background: colour } })
  .jpeg().withMetadata({ orientation: 6 }).withExifMerge({ IFD0: { Artist: 'Isolated media fixture' } }).toBuffer();
async function isolated(t) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-admin-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const operationName = (id, index, extension = '.jpg') => 'assistant-' + createHash('sha256')
  .update(JSON.stringify([id, index])).digest('hex') + extension;
function database(directory) {
  const db = new DatabaseSync(join(directory, 'space.sqlite'));
  db.exec('CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  return db;
}

test('pure media import never initializes or seeds a database', async t => {
  const directory = await isolated(t);
  const dataDirectory = join(directory, 'must-stay-absent');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import("./server/media-processing.js")'], {
    env: { ...process.env, DATA_DIR: dataDirectory }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(await readdir(directory), []);
});

test('shared preparation validates the full upload envelope, strips metadata and preserves PDFs', async () => {
  const original = await fixtureImage('red');
  const result = await prepareMedia([{ name: '图片.jpeg', buffer: original }, { name: '附件.pdf', buffer: pdf }]);
  assert.equal(result[0].extension, '.jpg');
  assert.equal((await sharp(result[0].buffer).metadata()).exif, undefined);
  assert.equal((await sharp(result[0].buffer).metadata()).orientation, undefined);
  assert.deepEqual(result[1].buffer, pdf);
  for (const files of [[], new Array(21).fill({ name: 'a.jpg', buffer: original }),
    [{ name: '../a.jpg', buffer: original }], [{ name: 'a\\b.jpg', buffer: original }],
    [{ name: 'a\n.jpg', buffer: original }], [{ name: 'movie.mp4', buffer: original }],
    [{ name: 'a.pdf', buffer: Buffer.from('invalid PDF') }], [{ name: 'fake.png', buffer: Buffer.from('<svg/>') }],
    [{ name: 'a.jpg', buffer: Buffer.alloc(0) }], [{ name: 'a.pdf', buffer: Buffer.alloc(MAX_MEDIA_BYTES + 1) }],
  ]) await assert.rejects(prepareMedia(files), error => error.status === 400);
});

test('uploads use stable operation names, populate matching caches and preserve existing files on replay rollback', async t => {
  const directory = await isolated(t);
  const prepared = await prepareMedia([{ name: 'portrait.jpg', buffer: await fixtureImage('red') }, { name: 'paper.pdf', buffer: pdf }]);
  const first = await savePreparedMedia(directory, prepared, { operationId: 'stable-operation-1' });
  const name = basename(first.files[0].url);
  const storedPath = join(directory, 'uploads', name);
  const info = await stat(storedPath);
  const cachePath = mediaCachePath(join(directory, 'media-cache'), name, info);
  assert.deepEqual(await readFile(cachePath), prepared[0].buffer);
  if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
  const replay = await savePreparedMedia(directory, prepared, { operationId: 'stable-operation-1' });
  assert.deepEqual(replay.files, first.files);
  await replay.rollback();
  assert.deepEqual(await readFile(storedPath), prepared[0].buffer);
  assert.equal((await readdir(join(directory, 'uploads'))).length, 2);
  await first.rollback();
  await first.rollback();
  assert.deepEqual(await readdir(join(directory, 'uploads')), []);
  assert.deepEqual(await readdir(join(directory, 'media-cache')), []);
});

test('a changed payload cannot overwrite an existing operation upload', async t => {
  const directory = await isolated(t);
  const first = await prepareMedia([{ name: 'a.jpg', buffer: await fixtureImage('red') }]);
  const second = await prepareMedia([{ name: 'a.jpg', buffer: await fixtureImage('blue') }]);
  const saved = await savePreparedMedia(directory, first, { operationId: 'same-key' });
  await assert.rejects(savePreparedMedia(directory, second, { operationId: 'same-key' }), error => error.status === 409);
  assert.deepEqual(await readFile(join(directory, 'uploads', basename(saved.files[0].url))), first[0].buffer);
  assert.ok((await readdir(join(directory, 'uploads'))).every(name => !name.endsWith('.tmp')));
});

test('mid-batch file failure removes only files created by this request', async t => {
  const directory = await isolated(t);
  const prepared = await prepareMedia([{ name: 'first.jpg', buffer: await fixtureImage('red') }, { name: 'second.jpg', buffer: await fixtureImage('blue') }]);
  await mkdir(join(directory, 'uploads'));
  const existing = operationName('failing-batch', 1);
  await writeFile(join(directory, 'uploads', existing), Buffer.from('existing file remains'));
  await assert.rejects(savePreparedMedia(directory, prepared, { operationId: 'failing-batch' }), error => error.status === 409);
  assert.deepEqual(await readdir(join(directory, 'uploads')), [existing]);
  assert.equal((await readFile(join(directory, 'uploads', existing))).toString(), 'existing file remains');
  assert.deepEqual(await readdir(join(directory, 'media-cache')), []);
});

test('preview reads clean cached bytes and sanitizes legacy files without changing the filesystem', async t => {
  const directory = await isolated(t);
  await mkdir(join(directory, 'uploads'));
  const original = await fixtureImage('red');
  await writeFile(join(directory, 'uploads', 'legacy.png'), original);
  await writeFile(join(directory, 'uploads', 'paper.pdf'), pdf);
  const result = await loadPreviewMedia(directory, ['legacy.png', 'paper.pdf', 'legacy.png']);
  assert.equal(result.length, 2);
  assert.equal(result[0].mime, 'image/jpeg');
  assert.equal((await sharp(Buffer.from(result[0].base64, 'base64')).metadata()).exif, undefined);
  assert.deepEqual(Buffer.from(result[1].base64, 'base64'), pdf);
  assert.deepEqual(await readdir(directory), ['uploads'], 'read-only preview must not create a cache');
  assert.deepEqual(await readFile(join(directory, 'uploads', 'legacy.png')), original);
  const saved = await savePreparedMedia(directory, await prepareMedia([{ name: 'fresh.jpg', buffer: original }]));
  const name = basename(saved.files[0].url);
  assert.deepEqual(Buffer.from((await loadPreviewMedia(directory, [name]))[0].base64, 'base64'), await readFile(join(directory, 'uploads', name)));
});

test('preview rejects path traversal, unsupported formats, over-size files and aggregate overrun', async t => {
  const directory = await isolated(t);
  await mkdir(join(directory, 'uploads'));
  for (const name of ['../secret.jpg', '/uploads/a.jpg', 'x\\a.jpg', '.hidden.jpg', 'a..jpg', 'film.mp4', 'https://site.test/a.jpg'])
    await assert.rejects(loadPreviewMedia(directory, [name]), error => error.status === 400);
  const largePdf = Buffer.alloc(MAX_MEDIA_BYTES + 1); pdf.copy(largePdf);
  await writeFile(join(directory, 'uploads', 'too-big.pdf'), largePdf);
  await assert.rejects(loadPreviewMedia(directory, ['too-big.pdf']), error => error.status === 400);
  const tenMiB = largePdf.subarray(0, 10 * 1024 * 1024 + 1);
  for (const name of ['a.pdf', 'b.pdf', 'c.pdf']) await writeFile(join(directory, 'uploads', name), tenMiB);
  await assert.rejects(loadPreviewMedia(directory, ['a.pdf', 'b.pdf', 'c.pdf']), error => error.status === 400);
});

test('media access rejects symlinked directories and never writes outside the data directory', async t => {
  const directory = await isolated(t);
  const outside = join(directory, 'outside');
  const data = join(directory, 'data');
  await mkdir(outside); await mkdir(data);
  await symlink(outside, join(data, 'uploads'), process.platform === 'win32' ? 'junction' : 'dir');
  const prepared = await prepareMedia([{ name: 'a.pdf', buffer: pdf }]);
  await assert.rejects(savePreparedMedia(data, prepared), error => error.status === 400);
  await assert.rejects(loadPreviewMedia(data, ['a.pdf']), error => error.status === 400);
  assert.deepEqual(await readdir(outside), []);
});

test('media access rejects individual symlinked files and caches', async t => {
  const directory = await isolated(t);
  await mkdir(join(directory, 'uploads')); await mkdir(join(directory, 'media-cache'));
  const target = join(directory, 'private.pdf'); await writeFile(target, pdf);
  try { await symlink(target, join(directory, 'uploads', 'alias.pdf'), 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Host does not permit file symlinks; directory junction rejection covered separately'); return; } throw error; }
  await assert.rejects(loadPreviewMedia(directory, ['alias.pdf']), error => error.status === 400);
  const name = 'legacy.jpg'; await writeFile(join(directory, 'uploads', name), await fixtureImage('red'));
  const cachedPath = mediaCachePath(join(directory, 'media-cache'), name, await stat(join(directory, 'uploads', name)));
  await symlink(target, cachedPath, 'file');
  await assert.rejects(loadPreviewMedia(directory, [name]), error => error.status === 400);
});

test('assistant media receipt failure rolls back files and retry succeeds without duplicates', async t => {
  const directory = await isolated(t);
  const db = database(directory);
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON records WHEN NEW.kind='assistant_receipts' BEGIN SELECT RAISE(ABORT,'isolated receipt fault'); END");
  const request = { action: 'media-upload', requestId: 'media-receipt-001', files: [{ name: 'a.jpg', base64: (await fixtureImage('red')).toString('base64') }] };
  await assert.rejects(executeAdminRequest(directory, request), /isolated receipt fault/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM records").get().count, 0);
  assert.deepEqual(await readdir(join(directory, 'uploads')), []);
  assert.deepEqual(await readdir(join(directory, 'media-cache')), []);
  db.exec('DROP TRIGGER fail_receipt');
  const saved = await executeAdminRequest(directory, request);
  const replayed = await executeAdminRequest(directory, request);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.files, saved.files);
  assert.equal((await readdir(join(directory, 'uploads'))).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM records WHERE kind='assistant_receipts'").get().count, 1);
  db.close();
});

test('assistant recovers files left after process interruption before receipt commit', async t => {
  const directory = await isolated(t);
  database(directory).close();
  const original = await fixtureImage('red');
  const request = { action: 'media-upload', requestId: 'media-crash-retry-001', files: [{ name: 'a.jpg', base64: original.toString('base64') }] };
  // This is the durable filesystem state after a killed process with no committed receipt.
  const existing = await savePreparedMedia(directory, await prepareMedia([{ name: 'a.jpg', buffer: original }]), { operationId: request.requestId });
  const recovered = await executeAdminRequest(directory, request);
  assert.deepEqual(recovered.files, existing.files);
  assert.equal((await readdir(join(directory, 'uploads'))).length, 1);
  assert.equal((await readdir(join(directory, 'media-cache'))).length, 1);
  assert.equal((await executeAdminRequest(directory, request)).replayed, true);
});

test('a valid 15 MiB PDF survives assistant base64 validation, upload, preview and replay', async t => {
  const directory = await isolated(t);
  database(directory).close();
  const maximum = Buffer.alloc(MAX_MEDIA_BYTES); pdf.copy(maximum);
  const request = { action: 'media-upload', requestId: 'media-maximum-001', files: [{ name: 'maximum.pdf', base64: maximum.toString('base64') }] };
  const result = await executeAdminRequest(directory, request);
  const name = basename(result.files[0].url);
  const preview = await executeAdminRequest(directory, { action: 'media-get', names: [name] });
  assert.equal(preview.ok, true);
  assert.deepEqual(Buffer.from(preview.files[0].base64, 'base64'), maximum);
  assert.equal((await executeAdminRequest(directory, request)).replayed, true);
});
