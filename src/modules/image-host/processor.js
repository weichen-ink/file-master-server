const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const sharp = require('sharp');
const { ROOT_DIR } = require('../../core/config');

const execFileAsync = promisify(execFile);

// Formats that standard browsers and prebuilt sharp binaries may not decode out of the box
const NEEDS_TRANSCODE_EXTS = new Set(['.heic', '.heif', '.tif', '.tiff']);

/**
 * Transcodes HEIC/HEIF/TIFF originals into high-quality JPEG previews for browser rendering and sharp watermarking.
 * Linux-first pipeline:
 *   1. Native Sharp/libvips (handles TIFF natively on Linux and HEIC when libheif is linked)
 *   2. Linux CLI decoders: heif-convert (libheif-examples) -> ffmpeg
 *   3. macOS fallback: /usr/bin/sips (only attempted when process.platform === 'darwin')
 */
async function ensureTranscodedPreviewJpeg(rawFilePath, previewCachePath) {
  if (fs.existsSync(previewCachePath)) {
    const rawStat = fs.statSync(rawFilePath);
    const cacheStat = fs.statSync(previewCachePath);
    if (cacheStat.mtimeMs >= rawStat.mtimeMs && cacheStat.size > 0) {
      return previewCachePath;
    }
  }

  fs.mkdirSync(path.dirname(previewCachePath), { recursive: true });
  const tmpPath = `${previewCachePath}.${process.pid}.${Date.now()}.tmp.jpg`;
  const cleanupTmp = () => {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  };

  // 1. Try in-process Sharp (libvips) first - works out-of-the-box on Linux for TIFF and libheif-enabled builds
  try {
    await sharp(rawFilePath).rotate().jpeg({ quality: 92 }).toFile(tmpPath);
    fs.renameSync(tmpPath, previewCachePath);
    return previewCachePath;
  } catch {
    cleanupTmp();
  }

  // 2. Try Linux native heif-convert (apt package: libheif-examples)
  try {
    await execFileAsync('heif-convert', ['-q', '92', rawFilePath, tmpPath]);
    if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
      fs.renameSync(tmpPath, previewCachePath);
      return previewCachePath;
    }
  } catch {
    cleanupTmp();
  }

  // 3. Try cross-platform ffmpeg on Linux/Windows/macOS
  try {
    await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-i', rawFilePath, '-frames:v', '1', '-q:v', '2', tmpPath]);
    if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
      fs.renameSync(tmpPath, previewCachePath);
      return previewCachePath;
    }
  } catch {
    cleanupTmp();
  }

  // 4. If running on macOS local dev environment, try /usr/bin/sips
  if (process.platform === 'darwin') {
    try {
      await execFileAsync('/usr/bin/sips', [
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '92',
        rawFilePath,
        '--out',
        tmpPath
      ]);
      if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
        fs.renameSync(tmpPath, previewCachePath);
        return previewCachePath;
      }
    } catch {
      cleanupTmp();
    }
  }

  throw new Error(
    `Unable to transcode ${path.basename(rawFilePath)}. On Linux, install "libheif-examples" or "ffmpeg" (apt-get install -y libheif-examples ffmpeg).`
  );
}

/**
 * Generates a default semi-transparent watermark PNG if none exists at watermark.png.
 */
async function ensureDefaultWatermark(watermarkFilePath, text = '© FileMaster') {
  if (fs.existsSync(watermarkFilePath)) return;
  const svg = `
    <svg width="360" height="80" xmlns="http://www.w3.org/2000/svg">
      <style>
        .bg { fill: rgba(0, 0, 0, 0.38); rx: 14px; ry: 14px; }
        .txt { fill: #ffffff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 32px; font-weight: 700; }
      </style>
      <rect x="4" y="8" width="352" height="64" class="bg" />
      <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" class="txt">${escapeXml(text)}</text>
    </svg>
  `;
  await sharp(Buffer.from(svg)).png().toFile(watermarkFilePath);
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Calculates (left, top) offsets for positioning the watermark on the target canvas.
 */
function calcCoordinates(pos, mainW, mainH, wmW, wmH, margin) {
  const m = Math.max(0, Number(margin) || 24);
  let left = mainW - wmW - m;
  let top = mainH - wmH - m;

  switch (pos) {
    case 'bottom-left':
      left = m;
      top = mainH - wmH - m;
      break;
    case 'top-right':
      left = mainW - wmW - m;
      top = m;
      break;
    case 'top-left':
      left = m;
      top = m;
      break;
    case 'center':
      left = Math.round((mainW - wmW) / 2);
      top = Math.round((mainH - wmH) / 2);
      break;
    case 'bottom-right':
    default:
      left = mainW - wmW - m;
      top = mainH - wmH - m;
      break;
  }

  return {
    left: Math.max(0, Math.round(left)),
    top: Math.max(0, Math.round(top))
  };
}

/**
 * Generates the watermark overlay buffer supporting image, text, and tiled modes.
 */
async function buildWatermarkOverlay(imgCfg, targetWidth, targetHeight) {
  const opacity = Math.min(1, Math.max(0.05, Number(imgCfg.watermark_opacity) || 0.65));
  const scale = Math.min(0.8, Math.max(0.05, Number(imgCfg.watermark_scale) || 0.16));
  const margin = Number(imgCfg.watermark_margin) || 24;
  const pos = imgCfg.watermark_pos || 'bottom-right';
  const type = imgCfg.watermark_type || 'image';

  // Mode 1: PNG image watermark
  if (type === 'image') {
    const wmPath = path.resolve(ROOT_DIR, imgCfg.watermark_image || './watermark.png');
    await ensureDefaultWatermark(wmPath, imgCfg.watermark_text || '© FileMaster');

    const wmTargetWidth = Math.max(60, Math.round(targetWidth * scale));
    const resizedBuffer = await sharp(wmPath)
      .resize({ width: wmTargetWidth, withoutEnlargement: false })
      .ensureAlpha()
      .composite([
        {
          input: Buffer.from([255, 255, 255, Math.round(opacity * 255)]),
          raw: { width: 1, height: 1, channels: 4 },
          tile: true,
          blend: 'dest-in'
        }
      ])
      .png()
      .toBuffer();

    const wmMeta = await sharp(resizedBuffer).metadata();
    const { left, top } = calcCoordinates(
      pos,
      targetWidth,
      targetHeight,
      wmMeta.width || wmTargetWidth,
      wmMeta.height || 40,
      margin
    );
    return { input: resizedBuffer, left, top };
  }

  // Mode 2: Repeating diagonal tiled watermark
  if (type === 'tile') {
    const text = escapeXml(imgCfg.watermark_text || '© FileMaster');
    const color = imgCfg.watermark_color || '#ffffff';
    const fontSize = Math.max(16, Math.round(targetWidth * 0.025));
    const tileW = fontSize * 10;
    const tileH = fontSize * 6;
    const svgTile = `
      <svg width="${tileW}" height="${tileH}" xmlns="http://www.w3.org/2000/svg">
        <g transform="rotate(-28 ${tileW / 2} ${tileH / 2})" opacity="${opacity}">
          <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle"
                fill="${color}" font-family="sans-serif" font-weight="bold" font-size="${fontSize}"
                style="filter: drop-shadow(1px 1px 2px rgba(0,0,0,0.65));">${text}</text>
        </g>
      </svg>
    `;
    return { input: Buffer.from(svgTile), tile: true, top: 0, left: 0 };
  }

  // Mode 3: Corner text watermark
  const text = escapeXml(imgCfg.watermark_text || '© FileMaster');
  const color = imgCfg.watermark_color || '#ffffff';
  const wmTargetWidth = Math.max(100, Math.round(targetWidth * scale));
  const fontSize = Math.max(16, Math.round(wmTargetWidth / Math.max(4, text.length * 0.7)));
  const svgW = Math.min(targetWidth - margin * 2, Math.max(wmTargetWidth, fontSize * text.length));
  const svgH = Math.round(fontSize * 1.8);

  const svgText = `
    <svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">
      <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle"
            fill="${color}" fill-opacity="${opacity}"
            font-family="-apple-system, BlinkMacSystemFont, sans-serif"
            font-weight="700" font-size="${fontSize}"
            style="filter: drop-shadow(1px 2px 3px rgba(0,0,0,0.7));">${text}</text>
    </svg>
  `;
  const { left, top } = calcCoordinates(pos, targetWidth, targetHeight, svgW, svgH, margin);
  return { input: Buffer.from(svgText), left, top };
}

/**
 * Reads original image -> resizes -> applies watermark -> compresses to WebP -> atomically writes cache.
 */
async function processAndCacheImage(rawFilePath, cacheFilePath, imgCfg) {
  const ext = path.extname(rawFilePath).toLowerCase();
  let inputPathForSharp = rawFilePath;

  if (NEEDS_TRANSCODE_EXTS.has(ext)) {
    const parsed = path.parse(cacheFilePath);
    const previewJpegPath = path.join(parsed.dir, `${parsed.name}.raw_preview.jpg`);
    inputPathForSharp = await ensureTranscodedPreviewJpeg(rawFilePath, previewJpegPath);
  }

  const image = sharp(inputPathForSharp, { animated: true });
  const meta = await image.metadata();

  // Handle animated images (GIF/animated WebP) directly to preserve frame sequences
  if (meta.pages && meta.pages > 1) {
    fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
    const tmpPath = `${cacheFilePath}.tmp`;
    await image
      .webp({ quality: Number(imgCfg.webp_quality) || 82 })
      .toFile(tmpPath);
    fs.renameSync(tmpPath, cacheFilePath);
    return cacheFilePath;
  }

  let targetWidth = meta.width || 800;
  let targetHeight = meta.height || 600;
  const maxWidth = Number(imgCfg.max_width) || 0;

  let pipeline = sharp(inputPathForSharp).rotate(); // Auto-rotate based on EXIF
  if (maxWidth > 0 && targetWidth > maxWidth) {
    targetHeight = Math.round((targetHeight * maxWidth) / targetWidth);
    targetWidth = maxWidth;
    pipeline = pipeline.resize({ width: maxWidth, withoutEnlargement: true });
  }

  const minWidthForWm = Number(imgCfg.watermark_min_width) || 320;
  if (imgCfg.watermark_enable && targetWidth >= minWidthForWm) {
    const overlay = await buildWatermarkOverlay(imgCfg, targetWidth, targetHeight);
    pipeline = pipeline.composite([overlay]);
  }

  fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
  const tmpPath = `${cacheFilePath}.tmp`;
  await pipeline
    .webp({ quality: Math.min(100, Math.max(10, Number(imgCfg.webp_quality) || 82)) })
    .toFile(tmpPath);
  fs.renameSync(tmpPath, cacheFilePath);
  return cacheFilePath;
}

module.exports = {
  NEEDS_TRANSCODE_EXTS,
  ensureTranscodedPreviewJpeg,
  ensureDefaultWatermark,
  processAndCacheImage
};
