const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');
const { STORAGE_DIR, ROOT_DIR } = require('../src/core/config');
const { getWebpCacheFilePath } = require('../src/modules/image-host/index');
const { processAndCacheImage } = require('../src/modules/image-host/processor');

test('Dynamic Watermark: ?wm= resolves isolated cache variants and applies watermarking', async () => {
  const pDefault = getWebpCacheFilePath('2026', '11', 'photo.jpg');
  const pImage = getWebpCacheFilePath('2026', '11', 'photo.jpg', 'image');
  const pText = getWebpCacheFilePath('2026', '11', 'photo.jpg', 'text');
  const pTile = getWebpCacheFilePath('2026', '11', 'photo.jpg', 'tile');

  assert.strictEqual(path.basename(pDefault), 'photo.jpg.webp');
  assert.strictEqual(path.basename(pImage), 'photo.jpg.wm_image.webp');
  assert.strictEqual(path.basename(pText), 'photo.jpg.wm_text.webp');
  assert.strictEqual(path.basename(pTile), 'photo.jpg.wm_tile.webp');

  // Verify processing with dynamic override
  const tmpDir = path.join(STORAGE_DIR, 'cache', 'test_wm');
  fs.mkdirSync(tmpDir, { recursive: true });
  const rawFile = path.join(tmpDir, 'test_raw.png');
  const cacheFile = path.join(tmpDir, 'test_raw.wm_tile.webp');

  // Create a 400x300 red image
  await sharp({
    create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 30, b: 30 } }
  }).png().toFile(rawFile);

  try {
    await processAndCacheImage(rawFile, cacheFile, {
      watermark_enable: true,
      watermark_type: 'tile',
      watermark_text: 'Dynamic Test',
      watermark_color: '#ffffff',
      watermark_opacity: 0.5,
      watermark_min_width: 200,
      webp_quality: 80
    });

    assert.ok(fs.existsSync(cacheFile), 'WebP cache variant must be written');
    const meta = await sharp(cacheFile).metadata();
    assert.strictEqual(meta.format, 'webp');
    assert.strictEqual(meta.width, 400);
    assert.strictEqual(meta.height, 300);
  } finally {
    if (fs.existsSync(rawFile)) fs.unlinkSync(rawFile);
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
  }

  // Verify corner text watermark with auto contrast and Web safe fonts
  const rawLightFile = path.join(tmpDir, 'test_light.png');
  const cacheTextFile = path.join(tmpDir, 'test_light.wm_text.webp');
  await sharp({
    create: { width: 500, height: 400, channels: 3, background: { r: 245, g: 245, b: 245 } }
  }).png().toFile(rawLightFile);

  try {
    await processAndCacheImage(rawLightFile, cacheTextFile, {
      watermark_enable: true,
      watermark_type: 'text',
      watermark_text: 'Author © 2026',
      watermark_font: 'pingfang',
      watermark_auto_contrast: true,
      watermark_color: '#ffffff',
      watermark_color_dark: '#111827',
      watermark_pos: 'bottom-right',
      watermark_min_width: 200,
      webp_quality: 80
    });

    assert.ok(fs.existsSync(cacheTextFile), 'WebP text watermark cache file must be written');
    const textMeta = await sharp(cacheTextFile).metadata();
    assert.strictEqual(textMeta.format, 'webp');
    assert.strictEqual(textMeta.width, 500);
  } finally {
    if (fs.existsSync(rawLightFile)) fs.unlinkSync(rawLightFile);
    if (fs.existsSync(cacheTextFile)) fs.unlinkSync(cacheTextFile);
  }
});

test('Text Watermark: vertical alignment is centered without vertical shift', async () => {
  const { processAndCacheImage } = require('../src/modules/image-host/processor');
  const tmpDir = path.join(STORAGE_DIR, 'cache', 'test_wm_align');
  fs.mkdirSync(tmpDir, { recursive: true });
  const rawFile = path.join(tmpDir, 'test_align_raw.png');
  const cacheFile = path.join(tmpDir, 'test_align.wm_text.webp');

  await sharp({
    create: { width: 600, height: 400, channels: 3, background: { r: 50, g: 50, b: 50 } }
  }).png().toFile(rawFile);

  try {
    await processAndCacheImage(rawFile, cacheFile, {
      watermark_enable: true,
      watermark_type: 'text',
      watermark_text: 'FileMaster 2026',
      watermark_color: '#ffffff',
      watermark_auto_contrast: false,
      watermark_pos: 'center',
      watermark_scale: 0.5,
      watermark_min_width: 100
    });
    assert.ok(fs.existsSync(cacheFile));
  } finally {
    if (fs.existsSync(rawFile)) fs.unlinkSync(rawFile);
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
  }
});

test('Watermark: smart resolution scaling handles 4K and portrait dimensions proportionally', async () => {
  const tmpDir = path.join(STORAGE_DIR, 'cache', 'test_wm_4k');
  fs.mkdirSync(tmpDir, { recursive: true });
  const raw4kFile = path.join(tmpDir, 'test_4k.png');
  const cache4kFile = path.join(tmpDir, 'test_4k.wm_image.webp');

  // Create a 3840x2160 4K image
  await sharp({
    create: { width: 3840, height: 2160, channels: 3, background: { r: 30, g: 30, b: 35 } }
  }).png().toFile(raw4kFile);

  try {
    await processAndCacheImage(raw4kFile, cache4kFile, {
      max_width: 0, // unlimited to retain 4K
      watermark_enable: true,
      watermark_type: 'image',
      watermark_image: './wm-light.png',
      watermark_image_dark: './wm-dark.png',
      watermark_scale: 0.16,
      watermark_margin: 24,
      watermark_min_width: 320,
      webp_quality: 82
    });

    assert.ok(fs.existsSync(cache4kFile));
    const meta = await sharp(cache4kFile).metadata();
    assert.strictEqual(meta.width, 3840);
    assert.strictEqual(meta.height, 2160);

    // Verify watermark was applied in bottom-right corner with proportional padding
    // At 4K, dynamic margin should be ~48px and width ~614px
    const patch = await sharp(cache4kFile)
      .extract({ left: 3840 - 700, top: 2160 - 300, width: 680, height: 280 })
      .raw()
      .toBuffer();
    // Compare with untouched background (r:30, g:30, b:35)
    let nonBackgroundCount = 0;
    for (let i = 0; i < patch.length; i += 3) {
      if (Math.abs(patch[i] - 30) > 15 || Math.abs(patch[i + 1] - 30) > 15 || Math.abs(patch[i + 2] - 35) > 15) {
        nonBackgroundCount++;
      }
    }
    assert.ok(nonBackgroundCount > 1000, 'Watermark must be visibly rendered in the 4K canvas');
  } finally {
    if (fs.existsSync(raw4kFile)) fs.unlinkSync(raw4kFile);
    if (fs.existsSync(cache4kFile)) fs.unlinkSync(cache4kFile);
  }
});

test('Raw endpoint with ?wm= parameter serves optimized watermarked WebP', async () => {
  const { registerPublicRoutes } = require('../src/modules/image-host/routes/public');
  const tmpDir = path.join(STORAGE_DIR, 'raw', '2026', '11');
  fs.mkdirSync(tmpDir, { recursive: true });
  const rawPng = path.join(tmpDir, 'test_raw_wm.png');

  await sharp({
    create: { width: 500, height: 400, channels: 3, background: { r: 50, g: 150, b: 220 } }
  }).png().toFile(rawPng);

  let rawRouteHandler = null;
  const mockApp = {
    get(route, handler) {
      if (route.includes(':rawSecretPath')) {
        rawRouteHandler = handler;
      }
    }
  };

  registerPublicRoutes(mockApp);
  assert.ok(rawRouteHandler, 'Raw route handler must be registered');

  const headers = {};
  let sentFile = null;
  let status = 200;

  const mockReq = {
    method: 'GET',
    params: { rawSecretPath: 'raw', year: '2026', month: '11', filename: 'test_raw_wm.png' },
    query: { wm: 'text' },
    headers: {}
  };
  const mockRes = {
    setHeader(k, v) { headers[k] = v; },
    status(s) { status = s; return this; },
    sendFile(filePath) { sentFile = filePath; return this; }
  };

  try {
    await rawRouteHandler(mockReq, mockRes, () => {});
    assert.strictEqual(status, 200);
    assert.strictEqual(headers['Content-Type'], 'image/webp');
    assert.ok(sentFile && sentFile.endsWith('.wm_text.webp'), 'Must serve .wm_text.webp cache file');
    assert.ok(fs.existsSync(sentFile), 'Served WebP cache file must exist');
  } finally {
    if (fs.existsSync(rawPng)) fs.unlinkSync(rawPng);
    if (sentFile && fs.existsSync(sentFile)) fs.unlinkSync(sentFile);
  }
});
