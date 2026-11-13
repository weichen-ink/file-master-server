const fs = require('node:fs');
const path = require('node:path');
const { getConfig } = require('../../../core/config');
const {
  PROCESSABLE_IMAGE_EXTS,
  NEEDS_TRANSCODE_EXTS,
  isAllowedAttachmentFile,
  isPathWithin,
  setSecurityFileHeaders,
  sanitizeSegment,
  isValidYearSeg,
  isValidMonthSeg
} = require('../../../core/file-security');
const {
  RAW_DIR,
  CACHE_DIR,
  findRawFile,
  getWebpCacheFilePath,
  getRawPreviewCacheFilePath
} = require('../asset-paths');
const { invalidateScanCache } = require('../catalog');
const { processAndCacheImage, ensureThumbnail, ensureTranscodedPreviewJpeg } = require('../processor');
const { recordHit } = require('../stats');

function isRealPathWithin(filePath, rootDir) {
  try {
    const realFile = fs.realpathSync(filePath);
    const realRoot = fs.realpathSync(rootDir);
    return isPathWithin(realFile, realRoot);
  } catch {
    return false;
  }
}

/** Public optimized-image route and secret-path raw file route. */
function registerPublicRoutes(app) {
  // 2. Public / Optimized route: GET /:pubSecretPath/:year/:month/:filename
  const handleOptimizedPublicRequest = async (req, res, next) => {
    try {
      const cfg = getConfig();
      const pubSecret = cfg.image_host?.pub_secret_path || 'pub';
      if (req.params.pubSecretPath && req.params.pubSecretPath !== pubSecret) {
        if (typeof next === 'function') return next();
        return res.status(404).send('Not Found');
      }
      if (cfg.image_host?.enable_optimization === false) {
        return res.status(404).send('Image optimization is disabled');
      }
      const year = sanitizeSegment(req.params.year);
      const month = sanitizeSegment(req.params.month);
      const filename = sanitizeSegment(req.params.filename);
      if (!isValidYearSeg(year) || !isValidMonthSeg(month) || !filename || !isAllowedAttachmentFile(filename)) {
        return res.status(404).send('Not Found');
      }

      const rawFilePath = findRawFile(year, month, filename);
      if (!rawFilePath || !isPathWithin(rawFilePath, RAW_DIR) || !isRealPathWithin(rawFilePath, RAW_DIR)) {
        return res.status(404).send('Not Found');
      }

      setSecurityFileHeaders(res, rawFilePath);
      res.setHeader('Cache-Control', 'public, no-cache');

      const rawExt = path.extname(rawFilePath).toLowerCase();
      if (req.method === 'HEAD' && PROCESSABLE_IMAGE_EXTS.has(rawExt)) {
        res.setHeader('Content-Type', 'image/webp');
        return res.status(200).end();
      }
      if (!PROCESSABLE_IMAGE_EXTS.has(rawExt)) {
        res.setHeader('Cache-Control', 'public, no-cache');
        if (req.method !== 'HEAD') recordHit(year, month, path.basename(rawFilePath));
        return res.sendFile(rawFilePath);
      }

      const rawBasenameWithExt = path.basename(rawFilePath);
      const rawWmParam = String(req.query.wm || req.query.watermark || '').toLowerCase().trim();
      const validWmTypes = ['image', 'text', 'tile'];
      const isCustomVariant = validWmTypes.includes(rawWmParam);
      const isForceDefaultWm = rawWmParam === '1' || rawWmParam === 'true';
      const isForceClean = rawWmParam === '0' || rawWmParam === 'false' || rawWmParam === 'clean' || rawWmParam === 'none';

      const globalWmEnabled = cfg.image_host?.watermark_enable !== false;
      const shouldWatermark = isForceClean ? false : (isCustomVariant || isForceDefaultWm ? true : globalWmEnabled);
      const activeWmType = isCustomVariant
        ? rawWmParam
        : (cfg.image_host?.watermark_type || 'image');

      const effectiveVariant = shouldWatermark ? activeWmType : 'clean';

      const cacheFilePath = getWebpCacheFilePath(
        year,
        month,
        rawBasenameWithExt,
        effectiveVariant
      );

      const hadCache = fs.existsSync(cacheFilePath);
      {
        const effectiveImgCfg = {
          ...cfg.image_host,
          watermark_enable: shouldWatermark,
          watermark_type: activeWmType
        };
        await processAndCacheImage(rawFilePath, cacheFilePath, effectiveImgCfg);
        if (!hadCache) invalidateScanCache();
      }

      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, no-cache');
      if (req.method !== 'HEAD') recordHit(year, month, rawBasenameWithExt);
      return res.sendFile(cacheFilePath);
    } catch (err) {
      console.error('[File Master] Failed to serve public file:', err);
      if (err.status === 503) res.setHeader('Retry-After', '2');
      return res.status(err.status || 500).send('File Processing Error');
    }
  };

  app.get('/:pubSecretPath/:year/:month/:filename', handleOptimizedPublicRequest);

  // 3. Raw file access via secret path: GET /:rawSecretPath/:year/:month/:filename
  app.get('/:rawSecretPath/:year/:month/:filename', async (req, res, next) => {
    try {
      const cfg = getConfig();
      if (req.params.rawSecretPath !== cfg.image_host.raw_secret_path) {
        return next();
      }

      const year = sanitizeSegment(req.params.year);
      const month = sanitizeSegment(req.params.month);
      const filename = sanitizeSegment(req.params.filename);
      if (!isValidYearSeg(year) || !isValidMonthSeg(month) || !filename || !isAllowedAttachmentFile(filename)) {
        return res.status(404).send('Not Found');
      }

      const rawFilePath = findRawFile(year, month, filename, true);
      if (!rawFilePath || !isPathWithin(rawFilePath, RAW_DIR) || !isRealPathWithin(rawFilePath, RAW_DIR)) {
        return res.status(404).send('Not Found');
      }

      setSecurityFileHeaders(res, rawFilePath);

      const ext = path.extname(rawFilePath).toLowerCase();

      // If ?wm=... is requested and file is a processable image, serve watermarked WebP variant
      const rawWmParam = String(req.query.wm || req.query.watermark || '').toLowerCase().trim();
      if (rawWmParam && req.query.download !== '1' && req.query.raw !== '1' && PROCESSABLE_IMAGE_EXTS.has(ext)) {
        return handleOptimizedPublicRequest(req, res, next);
      }

      if (req.query.thumbnail === '1' && PROCESSABLE_IMAGE_EXTS.has(ext)) {
        const thumbnailPath = path.join(CACHE_DIR, year, month, `${path.basename(rawFilePath)}.thumb.webp`);
        const hadThumbnail = fs.existsSync(thumbnailPath);
        await ensureThumbnail(rawFilePath, thumbnailPath);
        if (!hadThumbnail) invalidateScanCache();
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'private, no-cache');
        return res.sendFile(thumbnailPath);
      }
      if (NEEDS_TRANSCODE_EXTS.has(ext) && req.query.download !== '1' && req.query.raw !== '1') {
        const rawBasenameWithExt = path.basename(rawFilePath);
        const previewCachePath = getRawPreviewCacheFilePath(year, month, rawBasenameWithExt);
        await ensureTranscodedPreviewJpeg(rawFilePath, previewCachePath);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'private, no-cache');
        if (req.method !== 'HEAD') recordHit(year, month, rawBasenameWithExt);
        return res.sendFile(previewCachePath);
      }

      res.setHeader('Cache-Control', 'private, no-cache');
      if (req.method !== 'HEAD') recordHit(year, month, path.basename(rawFilePath));
      return res.sendFile(rawFilePath);
    } catch (err) {
      console.error('[File Master] Failed to read raw preview:', err);
      if (err.status === 503) res.setHeader('Retry-After', '2');
      return res.status(err.status || 500).send('Preview Error');
    }
  });
}

module.exports = { registerPublicRoutes };
