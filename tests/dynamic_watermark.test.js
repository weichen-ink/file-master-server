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
