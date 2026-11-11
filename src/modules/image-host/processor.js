const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const sharp = require('sharp');
const { ROOT_DIR } = require('../../core/config');
const { NEEDS_TRANSCODE_EXTS, isPathWithin } = require('../../core/file-security');
const { createTaskQueue } = require('../../core/task-queue');

const execFileAsync = promisify(execFile);
const scheduleImage = createTaskQueue(2);
const imageJobs = new Map();
let cacheGeneration = 0;

function invalidateProcessingCache() {
  cacheGeneration++;
}

function runImageCacheJob(rawPath, cachePath, build, generation = cacheGeneration) {
  const key = `${generation}:${cachePath}`;
  if (imageJobs.has(key)) return imageJobs.get(key);
  const job = scheduleImage(async () => {
    const assertCurrent = () => {
      if (generation !== cacheGeneration) {
        throw Object.assign(new Error('Image settings changed; retry this request'), { status: 503 });
      }
    };
    assertCurrent();
    const rawStat = await fs.promises.stat(rawPath);
    const cached = await fs.promises.stat(cachePath).catch(() => null);
    assertCurrent();
    if (cached && cached.size > 0 && cached.mtimeMs >= rawStat.mtimeMs) return cachePath;
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    const temp = `${cachePath}.${crypto.randomUUID()}.tmp`;
    try {
      await build(temp);
      assertCurrent();
      fs.renameSync(temp, cachePath);
      return cachePath;
    } finally {
      await fs.promises.unlink(temp).catch(() => {});
    }
  }).finally(() => imageJobs.delete(key));
  imageJobs.set(key, job);
  return job;
}

/**
 * Transcodes HEIC/HEIF/TIFF originals into high-quality JPEG previews for browser rendering and sharp watermarking.
 * Linux-first pipeline:
 *   1. Native Sharp/libvips (handles TIFF natively on Linux and HEIC when libheif is linked)
 *   2. Linux CLI decoders: heif-convert (libheif-examples) -> ffmpeg
 *   3. macOS fallback: /usr/bin/sips (only attempted when process.platform === 'darwin')
 */
function ensureTranscodedPreviewJpeg(rawFilePath, previewCachePath) {
  return runImageCacheJob(rawFilePath, previewCachePath,
    (temp) => transcodePreviewJpeg(rawFilePath, temp));
}

async function transcodePreviewJpeg(rawFilePath, previewCachePath) {
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
async function ensureDefaultWatermark(watermarkFilePath, text = '© File Master', isDark = false) {
  if (fs.existsSync(watermarkFilePath)) return;
  const bgFill = isDark ? 'rgba(255, 255, 255, 0.55)' : 'rgba(0, 0, 0, 0.38)';
  const txtFill = isDark ? '#111827' : '#ffffff';
  const svg = `
    <svg width="360" height="80" xmlns="http://www.w3.org/2000/svg">
      <style>
        .bg { fill: ${bgFill}; rx: 14px; ry: 14px; }
        .txt { fill: ${txtFill}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", "WenQuanYi Micro Hei", sans-serif; font-size: 32px; font-weight: 700; }
      </style>
      <rect x="4" y="8" width="352" height="64" class="bg" />
      <text x="50%" y="40" dominant-baseline="central" text-anchor="middle" class="txt">${escapeXml(text)}</text>
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

const WEB_SAFE_FONTS = {
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', 'Source Han Sans SC', 'Noto Sans CJK SC', 'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei', 'Helvetica Neue', Arial, sans-serif",
  pingfang: "'PingFang SC', 'Microsoft YaHei', 'Source Han Sans SC', 'Noto Sans CJK SC', 'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei', 'Hiragino Sans GB', sans-serif",
  arial: "Arial, Helvetica, 'Nimbus Sans L', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif",
  impact: "Impact, 'Arial Black', Charcoal, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif",
  georgia: "Georgia, 'Times New Roman', Times, 'Songti SC', 'SimSun', 'Noto Serif CJK SC', serif",
  courier: "'Courier New', Courier, Monaco, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', monospace"
};

function resolveFontFamily(fontKey) {
  return escapeXml(WEB_SAFE_FONTS[fontKey] || WEB_SAFE_FONTS.system);
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
    left: Math.max(0, Math.min(Math.max(0, mainW - wmW), Math.round(left))),
    top: Math.max(0, Math.min(Math.max(0, mainH - wmH), Math.round(top)))
  };
}

/**
 * Computes resolution-aware and aspect-ratio-aware layout metrics so that
 * watermarks scale gracefully from standard 1080p up to 4K/8K images without
 * becoming microscopic on high-res photos or cramped against image borders.
 */
function calcSmartWatermarkMetrics(targetWidth, targetHeight, userMargin = 24) {
  const minDim = Math.min(targetWidth, targetHeight);
  const maxDim = Math.max(targetWidth, targetHeight);
  const isPortrait = targetHeight > targetWidth;

  // Normalized visual dimension: balances narrow-width portrait images and ultrawide shots
  const baseNorm = Math.max(minDim, Math.round(maxDim * 0.45));
  // Scale factor relative to standard 1080p canvas (1080p = 1.0, 4K = ~2.0 - 2.5)
  const resolutionScale = Math.max(0.65, Math.min(3.5, baseNorm / 1080));
  // Dynamic margin: scales proportionally with resolution so 4K images don't look cramped
  const dynamicMargin = Math.max(12, Math.round(userMargin * resolutionScale));
  // Portrait compensation: prevents narrow mobile/camera portrait photos from having tiny watermarks
  const portraitBoost = isPortrait ? Math.min(1.4, Math.pow(targetHeight / targetWidth, 0.4)) : 1.0;

  return { minDim, maxDim, baseNorm, resolutionScale, dynamicMargin, portraitBoost };
}

/**
 * Generates the watermark overlay buffer supporting image, text, and tiled modes.
 * For image mode, supports smart background luminance detection (light vs. dark watermark).
 */
async function buildWatermarkOverlay(imgCfg, targetWidth, targetHeight, basePipeline = null) {
  const opacity = Math.min(1, Math.max(0.05, Number(imgCfg.watermark_opacity) || 0.65));
  const scale = Math.min(0.8, Math.max(0.05, Number(imgCfg.watermark_scale) || 0.16));
  const margin = Number(imgCfg.watermark_margin ?? 24);
  const pos = imgCfg.watermark_pos || 'bottom-right';
  const type = imgCfg.watermark_type || 'image';

  const { minDim, baseNorm, resolutionScale, dynamicMargin, portraitBoost } = calcSmartWatermarkMetrics(
    targetWidth,
    targetHeight,
    margin
  );

  // Mode 1: PNG image watermark
  if (type === 'image') {
    const requestedWmPath = path.resolve(ROOT_DIR, imgCfg.watermark_image || './wm-light.png');
    const wmPathLight = isPathWithin(requestedWmPath, ROOT_DIR)
      ? requestedWmPath
      : path.resolve(ROOT_DIR, './wm-light.png');
    if (!imgCfg._previewReadOnly) await ensureDefaultWatermark(wmPathLight, imgCfg.watermark_text || '© File Master', false);

    const requestedDarkPath = path.resolve(ROOT_DIR, imgCfg.watermark_image_dark || './wm-dark.png');
    const wmPathDark = isPathWithin(requestedDarkPath, ROOT_DIR)
      ? requestedDarkPath
      : path.resolve(ROOT_DIR, './wm-dark.png');
    if (!imgCfg._previewReadOnly) await ensureDefaultWatermark(wmPathDark, imgCfg.watermark_text || '© File Master', true);

    const effectiveScale = Math.min(0.4, scale * portraitBoost);
    let wmTargetWidth = Math.round(targetWidth * effectiveScale);
    const minPresenceWidth = Math.round(minDim * Math.max(0.18, scale * 1.15));
    if (wmTargetWidth < minPresenceWidth) {
      wmTargetWidth = minPresenceWidth;
    }
    wmTargetWidth = Math.min(Math.round(targetWidth * 0.65), Math.max(60, wmTargetWidth));

    let selectedWmPath = wmPathLight;
    let wmAspect = 82 / 245; // default ratio based on custom logo
    try {
      const initialMeta = await sharp(wmPathLight).metadata();
      if (initialMeta.width && initialMeta.height) {
        wmAspect = initialMeta.height / initialMeta.width;
      }
    } catch {}

    if (imgCfg.watermark_auto_contrast !== false && basePipeline) {
      try {
        const approxH = Math.max(20, Math.round(wmTargetWidth * wmAspect));
        const { left: testLeft, top: testTop } = calcCoordinates(pos, targetWidth, targetHeight, wmTargetWidth, approxH, dynamicMargin);
        const wmRegionW = Math.min(targetWidth - testLeft, wmTargetWidth);
        const wmRegionH = Math.min(targetHeight - testTop, approxH);
        if (wmRegionW > 0 && wmRegionH > 0) {
          const { data: cornerData, info: cornerInfo } = await basePipeline.clone()
            .flatten({ background: '#ffffff' })
            .extract({ left: testLeft, top: testTop, width: wmRegionW, height: wmRegionH })
            .raw()
            .toBuffer({ resolveWithObject: true });

          let sumLuma = 0;
          const channels = cornerInfo.channels;
          const pixelCount = cornerData.length / channels;
          for (let i = 0; i < cornerData.length; i += channels) {
            sumLuma += 0.2126 * cornerData[i] + 0.7152 * cornerData[i + 1] + 0.0722 * cornerData[i + 2];
          }
          const cornerLuma = sumLuma / pixelCount;
          // Threshold 140 (same as weichen-astro): >140 bright background -> use dark watermark; <=140 -> use light watermark
          selectedWmPath = cornerLuma > 140 ? wmPathDark : wmPathLight;
        }
      } catch {
        selectedWmPath = wmPathLight;
      }
    }

    const resizedBuffer = await sharp(selectedWmPath)
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
      wmMeta.height || Math.round(wmTargetWidth * wmAspect),
      dynamicMargin
    );
    return { input: resizedBuffer, left, top };
  }

  // Mode 2: Repeating diagonal tiled watermark
  if (type === 'tile') {
    const text = escapeXml(imgCfg.watermark_text || '© File Master');
    let textColor = imgCfg.watermark_color || '#ffffff';
    let shadowColor = 'rgba(0,0,0,0.65)';

    const fontSize = Math.max(16, Math.round(baseNorm * 0.026));
    const tileW = Math.round(fontSize * Math.max(9, text.length * 0.85));
    const tileH = Math.round(fontSize * 5.6);
    const shadowOffset = Math.max(1, Math.round(resolutionScale * 1.2));
    const shadowBlur = Math.max(2, Math.round(resolutionScale * 2.5));

    if (imgCfg.watermark_auto_contrast !== false && basePipeline) {
      try {
        const stats = await basePipeline.clone().stats();
        const ch = stats.channels;
        if (ch && ch.length >= 3) {
          const meanLuma = 0.2126 * ch[0].mean + 0.7152 * ch[1].mean + 0.0722 * ch[2].mean;
          if (meanLuma > 140) {
            textColor = imgCfg.watermark_color_dark || '#111827';
            shadowColor = 'rgba(255,255,255,0.75)';
          }
        }
      } catch {
        // Fallback to default
      }
    }

    const fontFamily = resolveFontFamily(imgCfg.watermark_font);
    const svgTile = `
      <svg width="${tileW}" height="${tileH}" xmlns="http://www.w3.org/2000/svg">
        <g transform="rotate(-28 ${tileW / 2} ${tileH / 2})" opacity="${opacity}">
          <text x="50%" y="50%" dy="0.35em" dominant-baseline="central" text-anchor="middle"
                fill="${textColor}" font-family="${fontFamily}" font-weight="bold" font-size="${fontSize}"
                style="filter: drop-shadow(${shadowOffset}px ${shadowOffset}px ${shadowBlur}px ${shadowColor});">${text}</text>
        </g>
      </svg>
    `;
    return { input: Buffer.from(svgTile), tile: true, top: 0, left: 0 };
  }

  // Mode 3: Corner text watermark
  const text = escapeXml(imgCfg.watermark_text || '© File Master');
  const effectiveScale = Math.min(0.4, scale * portraitBoost);
  const wmTargetWidth = Math.max(100, Math.round(targetWidth * effectiveScale));

  // Minimum legible font size based on image resolution
  const minLegibleFontSize = Math.max(14, Math.round(baseNorm * 0.024));
  const calculatedFontSize = Math.round(wmTargetWidth / Math.max(4, text.length * 0.65));
  const fontSize = Math.max(minLegibleFontSize, calculatedFontSize);

  const charW = fontSize * 0.72;
  const svgW = Math.min(targetWidth - dynamicMargin * 2, Math.max(wmTargetWidth, Math.round(charW * text.length + fontSize * 1.2)));
  const svgH = Math.round(fontSize * 1.9);
  const { left, top } = calcCoordinates(pos, targetWidth, targetHeight, svgW, svgH, dynamicMargin);

  const shadowOffset = Math.max(1, Math.round(resolutionScale * 1.5));
  const shadowBlur = Math.max(2, Math.round(resolutionScale * 2.8));

  let textColor = imgCfg.watermark_color || '#ffffff';
  let shadowColor = 'rgba(0,0,0,0.7)';

  if (imgCfg.watermark_auto_contrast !== false && basePipeline) {
    try {
      const stats = await basePipeline
        .clone()
        .extract({
          left: Math.max(0, left),
          top: Math.max(0, top),
          width: Math.max(1, Math.min(targetWidth - left, svgW)),
          height: Math.max(1, Math.min(targetHeight - top, svgH))
        })
        .stats();
      const ch = stats.channels;
      if (ch && ch.length >= 3) {
        const cornerLuma = 0.2126 * ch[0].mean + 0.7152 * ch[1].mean + 0.0722 * ch[2].mean;
        if (cornerLuma > 140) {
          textColor = imgCfg.watermark_color_dark || '#111827';
          shadowColor = 'rgba(255,255,255,0.85)';
        }
      }
    } catch {
      // Fallback to default
    }
  }

  const fontFamily = resolveFontFamily(imgCfg.watermark_font);
  const svgText = `
    <svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">
      <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle"
            fill="${textColor}" fill-opacity="${opacity}"
            font-family="${fontFamily}"
            font-weight="700" font-size="${fontSize}"
            style="filter: drop-shadow(${shadowOffset}px ${shadowOffset}px ${shadowBlur}px ${shadowColor});">${text}</text>
    </svg>
  `;
  return { input: Buffer.from(svgText), left, top };
}

/**
 * Reads original image -> resizes -> applies watermark -> compresses to WebP -> atomically writes cache.
 */
async function processAndCacheImage(rawFilePath, cacheFilePath, imgCfg) {
  const generation = cacheGeneration;
  const ext = path.extname(rawFilePath).toLowerCase();
  let inputPathForSharp = rawFilePath;

  if (NEEDS_TRANSCODE_EXTS.has(ext)) {
    const parsed = path.parse(cacheFilePath);
    const previewJpegPath = path.join(parsed.dir, `${parsed.name}.raw_preview.jpg`);
    inputPathForSharp = await ensureTranscodedPreviewJpeg(rawFilePath, previewJpegPath);
  }

  return runImageCacheJob(rawFilePath, cacheFilePath,
    (temp) => processImage(inputPathForSharp, temp, imgCfg), generation);
}

async function processImage(inputPathForSharp, cacheFilePath, imgCfg) {
  const image = sharp(inputPathForSharp, { animated: true });
  const meta = await image.metadata();

  // Handle animated images (GIF/animated WebP) directly to preserve frame sequences
  if (meta.pages && meta.pages > 1) {
    fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
    await image
      .webp({ quality: Number(imgCfg.webp_quality) || 82 })
      .toFile(cacheFilePath);
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

  const minWidthForWm = Number(imgCfg.watermark_min_width ?? 320);
  const hasSufficientSize = Math.max(targetWidth, targetHeight) >= minWidthForWm && Math.min(targetWidth, targetHeight) >= 120;
  if (imgCfg.watermark_enable && hasSufficientSize) {
    const overlay = await buildWatermarkOverlay(imgCfg, targetWidth, targetHeight, pipeline);
    pipeline = pipeline.composite([overlay]);
  }

  fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
  await pipeline
    .webp({ quality: Math.min(100, Math.max(10, Number(imgCfg.webp_quality) || 82)) })
    .toFile(cacheFilePath);
  return cacheFilePath;
}

async function ensureThumbnail(rawPath, cachePath) {
  let input = rawPath;
  if (NEEDS_TRANSCODE_EXTS.has(path.extname(rawPath).toLowerCase())) {
    input = await ensureTranscodedPreviewJpeg(rawPath, `${cachePath}.preview.jpg`);
  }
  return runImageCacheJob(rawPath, cachePath, (temp) => sharp(input, { animated: false })
    .rotate().resize({ width: 320, height: 240, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72 }).toFile(temp));
}

// Private preview output: never writes public caches or configuration.
async function renderDraftPreview(rawPath, output, imageConfig) {
  let input = rawPath;
  if (NEEDS_TRANSCODE_EXTS.has(path.extname(rawPath).toLowerCase())) input = await ensureTranscodedPreviewJpeg(rawPath, output + '.jpg');
  const config = {...imageConfig, _previewReadOnly:true};
  if (!config.enable_optimization) {
    return sharp(input).rotate().resize({width:2048, withoutEnlargement:true}).webp({quality:90}).toFile(output);
  }
  return scheduleImage(() => processImage(input, output, config));
}

module.exports = {
  NEEDS_TRANSCODE_EXTS,
  ensureTranscodedPreviewJpeg,
  ensureDefaultWatermark,
  processAndCacheImage,
  ensureThumbnail,
  renderDraftPreview,
  invalidateProcessingCache
};
