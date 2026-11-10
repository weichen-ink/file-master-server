const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { ROOT_DIR } = require('../src/core/config');
const { processAndCacheImage } = require('../src/modules/image-host/processor');

assert.equal(process.env.FILE_MASTER_TEST_ROOT, fs.realpathSync(ROOT_DIR), 'Run npm test in an isolated project');

test('Watermarks change image pixels and auto contrast selects the configured light/dark PNG', async (t) => {
  const dir = fs.mkdtempSync(path.join(ROOT_DIR, 'watermark-pixels-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const image = (width, height, background) => sharp({ create: { width, height, channels: 3, background } }).png();
  const light = path.join(dir, 'light.png'), dark = path.join(dir, 'dark.png');
  await image(120, 30, '#ff0000').toFile(light);
  await image(120, 30, '#00ff00').toFile(dark);
  const cfg = { watermark_enable: true, watermark_type: 'image', watermark_image: light, watermark_image_dark: dark,
    watermark_auto_contrast: true, watermark_scale: 0.25, watermark_opacity: 1, watermark_margin: 24,
    watermark_pos: 'bottom-right', watermark_min_width: 10, watermark_text: 'TEST', webp_quality: 100 };
  for (const [name, background, expectedChannel] of [['black', '#000000', 0], ['white', '#ffffff', 1]]) {
    const source = path.join(dir, `${name}.png`), output = path.join(dir, `${name}.webp`);
    await image(480, 360, background).toFile(source);
    await processAndCacheImage(source, output, cfg);
    const pixel = await sharp(output).extract({ left: 400, top: 320, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.ok(pixel[expectedChannel] > 200, `${name} background must select its configured contrast watermark`);
    assert.ok(pixel[(expectedChannel + 1) % 3] < 60);
  }
  const source = path.join(dir, 'black.png');
  const off = path.join(dir, 'off.webp');
  await processAndCacheImage(source, off, { ...cfg, watermark_enable: false });
  const baseline = await sharp(off).removeAlpha().raw().toBuffer();
  for (const type of ['text', 'tile']) {
    const output = path.join(dir, `${type}.webp`);
    await processAndCacheImage(source, output, { ...cfg, watermark_type: type });
    const pixels = await sharp(output).removeAlpha().raw().toBuffer();
    let changed = 0;
    for (let i = 0; i < pixels.length; i++) if (Math.abs(pixels[i] - baseline[i]) > 20) changed++;
    assert.ok(changed > 100, `${type} must render visible marks, not just return valid WebP bytes`);
  }
});
