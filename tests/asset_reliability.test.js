const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { persistUniqueUpload, hashFileSha256, verifyOriginalFiles } = require('../src/modules/image-host/asset-files');
const { processAndCacheImage, ensureThumbnail, invalidateProcessingCache } = require('../src/modules/image-host/processor');
const { createTaskQueue } = require('../src/core/task-queue');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('Uploads verify occupied suffixes and publish complete files without overwriting', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-upload-'));
  try {
    const bytes = Buffer.from('incoming');
    const sha = digest(bytes);
    await fs.writeFile(path.join(dir, 'photo.png'), 'original');
    await fs.writeFile(path.join(dir, `photo_${sha.slice(0, 8)}.png`), 'unrelated');
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      persistUniqueUpload({ buffer: bytes }, dir, 'photo.png', sha)));
    assert.equal(results.filter((r) => !r.deduplicated).length, 1);
    for (const result of results) assert.equal(await hashFileSha256(path.join(dir, result.filename)), sha);
    assert.equal(await fs.readFile(path.join(dir, 'photo.png'), 'utf8'), 'original');
    assert.equal(await fs.readFile(path.join(dir, `photo_${sha.slice(0, 8)}.png`), 'utf8'), 'unrelated');
    assert.ok(!(await fs.readdir(dir)).some((name) => name.endsWith('.tmp')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Concurrent cold-cache requests all succeed and thumbnails have bounded dimensions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-images-'));
  try {
    const raw = path.join(dir, 'source.png');
    const output = path.join(dir, 'cached.webp');
    await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#456789' } }).png().toFile(raw);
    await Promise.all(Array.from({ length: 8 }, () => processAndCacheImage(raw, output,
      { watermark_enable: false, max_width: 1000 })));
    assert.equal((await sharp(output).metadata()).width, 1000);
    const thumbnail = path.join(dir, 'thumbnail.webp');
    await Promise.all(Array.from({ length: 8 }, () => ensureThumbnail(raw, thumbnail)));
    const meta = await sharp(thumbnail).metadata();
    assert.ok(meta.width <= 320 && meta.height <= 240);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['cached.webp', 'source.png', 'thumbnail.webp']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Bounded task queue caps concurrency and survives rejected work', async () => {
  const queue = createTaskQueue(2, 10);
  let active = 0, peak = 0;
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => queue(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    if (i === 1) throw new Error('expected');
    return i;
  })));
  assert.equal(peak, 2);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 9);
  assert.equal(await queue(() => 42), 42);
});

test('Changing image settings invalidates queued work instead of publishing stale caches', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-cache-generation-'));
  try {
    const raw = path.join(dir, 'raw.png'), cache = path.join(dir, 'cached.webp');
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#123456' } }).png().toFile(raw);
    const oldJob = processAndCacheImage(raw, cache, { watermark_enable: false, max_width: 200 });
    invalidateProcessingCache();
    await assert.rejects(oldJob, (err) => err.status === 503);
    await assert.rejects(fs.stat(cache), { code: 'ENOENT' });
    await processAndCacheImage(raw, cache, { watermark_enable: false, max_width: 100 });
    assert.equal((await sharp(cache).metadata()).width, 100);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Full integrity check rereads bytes, preserves baselines, and reports missing/unindexed files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-integrity-'));
  try {
    const month = path.join(dir, '2026', '11');
    await fs.mkdir(month, { recursive: true });
    await fs.writeFile(path.join(month, 'good.png'), 'good');
    await fs.writeFile(path.join(month, 'bad.png'), 'modified');
    await fs.writeFile(path.join(month, 'new.png'), 'new');
    const expected = new Map([
      ['2026/11/good.png', { sha256: digest('good') }],
      ['2026/11/bad.png', { sha256: digest('modified'), baselineSha256: digest('original') }],
      ['2026/11/missing.png', { sha256: digest('missing') }]
    ]);
    const result = await verifyOriginalFiles(dir, expected);
    assert.equal(result.checked, 3);
    assert.equal(result.matched, 1);
    assert.deepEqual(result.issues.map((i) => i.type).sort(), ['mismatch', 'missing', 'unindexed']);
    assert.equal(expected.get('2026/11/bad.png').baselineSha256, digest('original'));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(verifyOriginalFiles(dir, expected, { signal: controller.signal }), { name: 'AbortError' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Unsupported hard links fail without exposing a partial file or overwriting an existing file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fm-nolink-'));
  const realLink = fs.link;
  const realCopy = fs.copyFile;
  let copies = 0;
  fs.link = async () => { throw Object.assign(new Error('not supported'), { code: 'EPERM' }); };
  fs.copyFile = async (...args) => { copies++; return realCopy(...args); };
  try {
    await fs.writeFile(path.join(dir, 'existing.png'), 'original');
    for (const name of ['new.png', 'existing.png']) {
      await assert.rejects(persistUniqueUpload({ buffer: Buffer.from('incoming') }, dir, name, digest('incoming')),
        { code: 'ATOMIC_PUBLISH_UNSUPPORTED', status: 501 });
    }
    assert.equal(copies, 0, 'never copy incomplete bytes to the public filename');
    assert.deepEqual(await fs.readdir(dir), ['existing.png']);
    assert.equal(await fs.readFile(path.join(dir, 'existing.png'), 'utf8'), 'original');
  } finally {
    fs.link = realLink;
    fs.copyFile = realCopy;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
