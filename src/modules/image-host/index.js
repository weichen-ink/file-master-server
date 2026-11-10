const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { hashFileSha256, persistUniqueUpload, walkOriginalFiles, verifyOriginalFiles } = require('./asset-files');
const { createTaskQueue } = require('../../core/task-queue');
const { getProtectedMap, isItemLocked, setItemLockState } = require('./protection');
const {
  RAW_DIR,
  CACHE_DIR,
  getWebpCacheFilePath,
  getLegacyWebpCacheFilePath,
  getRawPreviewCacheFilePath,
  hasSiblingWithSameBasename,
  findRawFile
} = require('./asset-paths');
const {
  pathToShaMap,
  getShaIndex,
  writeShaIndex,
  updateShaIndex,
  removeShaIndex,
  getFileSha256,
  findExistingBySha256
} = require('./sha-index');
const {
  ROOT_DIR,
  TRASH_DIR,
  UPLOAD_TMP_DIR,
  getConfig
} = require('../../core/config');
const { requireApiOrAdmin, createRateLimiter, getClientIp } = require('../../core/security');
const { appendAuditLog } = require('../../core/audit');
const {
  PROCESSABLE_IMAGE_EXTS,
  NEEDS_TRANSCODE_EXTS,
  isAllowedAttachmentFile,
  isPathWithin,
  setSecurityFileHeaders,
  sanitizeSegment,
  sanitizeUploadFilename,
  isValidYearSeg,
  isValidMonthSeg,
  buildAssetUrlsAndMeta
} = require('../../core/file-security');
const {
  ensureDefaultWatermark,
  ensureTranscodedPreviewJpeg,
  processAndCacheImage,
  ensureThumbnail,
  invalidateProcessingCache
} = require('./processor');

const mutateAssets = createTaskQueue(1);

function ensureDirs() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
}

// Multer disk-backed streaming upload handler (avoids memory exhaustion on large files)
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDirs();
    cb(null, UPLOAD_TMP_DIR);
  },
  filename: (req, file, cb) => {
    const rand = crypto.randomBytes(12).toString('hex');
    cb(null, `upload_${Date.now()}_${rand}.tmp`);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 10, parts: 11 }
});

const acceptSingleUpload = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message });
    }
    return next(err);
  });
};

let cachedScanData = null;
let cachedScanTime = 0;
let cachedScanCfgKey = '';
const SCAN_CACHE_TTL_MS = 30 * 1000;
let scanGeneration = 0;
let pendingScan = null;
let integrityCheck = { state: 'idle', checked: 0, matched: 0, issues: [] };
let integrityController = null;

function invalidateScanCache() {
  scanGeneration++;
  cachedScanData = null;
  cachedScanTime = 0;
}

async function moveFileToTrash(source, target, expectedSha256) {
  try {
    fs.renameSync(source, target);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    try {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if ((await hashFileSha256(target)) !== expectedSha256) {
        throw new Error('Trash copy failed integrity check');
      }
      fs.unlinkSync(source);
    } catch (copyErr) {
      if (fs.existsSync(source) && fs.existsSync(target)) {
        try {
          fs.unlinkSync(target);
        } catch {}
      }
      throw copyErr;
    }
  }
}

/**
 * Scans all raw assets and compiles summary metrics.
 */
function scanAllImages(cfg, forceRefresh = false) {
  const cfgKey = `${cfg.base_url}|${cfg.image_host?.raw_secret_path}|${cfg.image_host?.pub_secret_path}|${cfg.image_host?.enable_optimization}`;
  const now = Date.now();
  if (!forceRefresh && cachedScanData && cfgKey === cachedScanCfgKey && now - cachedScanTime < SCAN_CACHE_TTL_MS) {
    return Promise.resolve(cachedScanData);
  }

  const generation = scanGeneration;
  const key = `${cfgKey}:${generation}`;
  if (pendingScan?.key === key) return pendingScan.promise;
  const promise = collectImages(cfg).then((result) => {
    if (generation === scanGeneration) {
      cachedScanData = result;
      cachedScanTime = Date.now();
      cachedScanCfgKey = cfgKey;
    }
    return result;
  }).finally(() => {
    if (pendingScan?.promise === promise) pendingScan = null;
  });
  pendingScan = { key, promise };
  return promise;
}

async function collectImages(cfg) {
  ensureDirs();
  const protectedMap = getProtectedMap();
  const list = [];
  let totalRawBytes = 0;
  let totalCacheBytes = 0;
  let shaIndexDirty = false;
  let cacheMonth = '';
  let cacheSizes = new Map();

  for await (const fileEntry of walkOriginalFiles(RAW_DIR)) {
    const { year, month, filename: file, fullPath: fullRawPath, stat,
      hasBasenameCollision: hasCollision } = fileEntry;
    if (cacheMonth !== `${year}/${month}`) {
      cacheMonth = `${year}/${month}`;
      cacheSizes = new Map();
      const directory = path.join(CACHE_DIR, year, month);
      const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch((err) => {
        if (err.code === 'ENOENT') return [];
        throw err;
      });
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
        const filename = path.join(directory, entry.name);
        const cached = await fs.promises.stat(filename).catch((err) => {
          if (err.code === 'ENOENT') return null;
          throw err;
        });
        if (cached) cacheSizes.set(filename, cached.size);
      }
    }
    totalRawBytes += stat.size;
    const assetMeta = buildAssetUrlsAndMeta(cfg, {
      year,
      month,
      filename: file,
      hasBasenameCollision: hasCollision
    });

    const globalWmEnabled = cfg.image_host?.watermark_enable !== false;
    const activeWmType = cfg.image_host?.watermark_type || 'image';
    const effectiveVariant = globalWmEnabled ? activeWmType : 'clean';
    const expectedCacheFile = getWebpCacheFilePath(year, month, file, effectiveVariant);

    const primaryCacheFile = getWebpCacheFilePath(year, month, file);
    const legacyCacheFile = getLegacyWebpCacheFilePath(year, month, file);
    let assetCacheBytes = 0;
    if (assetMeta.isProcessableImage) {
      const processedCacheFiles = [
        primaryCacheFile,
        getWebpCacheFilePath(year, month, file, 'clean'),
        getWebpCacheFilePath(year, month, file, 'image'),
        getWebpCacheFilePath(year, month, file, 'text'),
        getWebpCacheFilePath(year, month, file, 'tile'),
        ...(!hasCollision ? [legacyCacheFile] : [])
      ];
      const candidateCacheFiles = new Set([
        ...processedCacheFiles,
        ...processedCacheFiles.map((filePath) => path.join(path.dirname(filePath), `${path.parse(filePath).name}.raw_preview.jpg`)),
        getRawPreviewCacheFilePath(year, month, file),
        path.join(CACHE_DIR, year, month, `${file}.thumb.webp`),
        path.join(CACHE_DIR, year, month, `${file}.thumb.webp.preview.jpg`)
      ]);
      for (const cPath of candidateCacheFiles) {
        assetCacheBytes += cacheSizes.get(cPath) || 0;
      }
    }
    const hasCache = cacheSizes.has(expectedCacheFile);
    const cacheSize = assetCacheBytes;
    if (assetCacheBytes > 0) {
      totalCacheBytes += assetCacheBytes;
    }

    const relKey = `${year}/${month}/${file}`;
    let sha256;
    try {
      sha256 = await getFileSha256(fullRawPath, stat, relKey);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (
      updateShaIndex(
        sha256,
        { year, month, filename: file, size: stat.size, mtimeMs: stat.mtimeMs },
        false
      )
    ) {
      shaIndexDirty = true;
    }
    const locked = isItemLocked(year, month, file, protectedMap);
    const inProtectedFolder = year === 'protected';

    list.push({
      filename: file,
      sha256,
      ext: assetMeta.ext,
      category: assetMeta.category,
      isImage: assetMeta.isImage,
      isProcessableImage: assetMeta.isProcessableImage,
      year,
      month,
      locked,
      inProtectedFolder,
      size: stat.size,
      cacheSize,
      hasCache,
      createdAt: stat.birthtimeMs || stat.mtimeMs,
      rawUrl: assetMeta.rawUrl,
      pubUrl: assetMeta.pubUrl,
      rawPreviewPath: assetMeta.rawPreviewPath,
      pubPreviewPath: assetMeta.pubPreviewPath,
      thumbnailUrl: assetMeta.isProcessableImage ? `${assetMeta.rawUrl}?thumbnail=1` : null
    });
  }

  if (shaIndexDirty) {
    writeShaIndex();
  }

  list.sort((a, b) => b.createdAt - a.createdAt);
  const optimizationEnabled = cfg.image_host?.enable_optimization !== false;
  const result = {
    images: list,
    optimizationEnabled,
    stats: {
      totalCount: list.length,
      totalRawBytes,
      totalCacheBytes
    }
  };
  return result;
}

/**
 * Recursively clears the image processing cache directory.
 */
function clearCacheDir() {
  invalidateProcessingCache();
  if (fs.existsSync(CACHE_DIR)) {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  invalidateScanCache();
}

function warmShaIndexAsync() {
  const timer = setTimeout(() => {
    scanAllImages(getConfig()).catch((err) => console.warn('[ImageHost] Index warmup:', err.message));
  }, 200);
  timer.unref?.();
}

function registerImageHostModule(app) {
  const serializeMutation = (handler) => (req, res) => mutateAssets(() => handler(req, res))
    .catch((err) => res.status(err.status || 500).json({ error: err.message }));
  ensureDirs();
  warmShaIndexAsync();
  const initCfg = getConfig();
  const requestedWmPath = path.resolve(ROOT_DIR, initCfg.image_host.watermark_image || './watermark.png');
  const wmPath = isPathWithin(requestedWmPath, ROOT_DIR)
    ? requestedWmPath
    : path.resolve(ROOT_DIR, './watermark.png');
  ensureDefaultWatermark(wmPath, initCfg.image_host.watermark_text).catch(() => {});

  // 1. Unified attachment upload endpoint
  const handleUpload = async (req, res) => {
    let tmpPath = null;
    try {
      const fileObj = req.file;
      if (!fileObj || (!fileObj.buffer && !fileObj.path)) {
        return res.status(400).json({ error: 'No file detected in upload (field name must be "file")' });
      }
      tmpPath = fileObj.path || null;

      let rawOrigName = 'file.png';
      if (req.headers['x-file-name']) {
        try {
          rawOrigName = decodeURIComponent(String(req.headers['x-file-name']));
        } catch {
          rawOrigName = String(req.headers['x-file-name']);
        }
      } else if (fileObj.originalname) {
        try {
          rawOrigName = Buffer.from(fileObj.originalname, 'latin1').toString('utf8');
        } catch {
          rawOrigName = fileObj.originalname;
        }
      }

      const safeOrigName = sanitizeUploadFilename(rawOrigName) || 'file.png';
      const origExt = path.extname(safeOrigName).toLowerCase() || '.png';
      if (!isAllowedAttachmentFile(safeOrigName)) {
        return res.status(400).json({ error: `Invalid attachment filename: ${safeOrigName}` });
      }

      const fullSha256 = fileObj.buffer
        ? crypto.createHash('sha256').update(fileObj.buffer).digest('hex')
        : await hashFileSha256(fileObj.path);
      const { year, month, filename, destPath, deduplicated } = await mutateAssets(async () => {
        // Index hits are hints: verify content before acknowledging an upload.
        const existing = await findExistingBySha256(fullSha256);
        if (existing) {
          const existingPath = path.join(RAW_DIR, existing.year, existing.month, existing.filename);
          return { ...existing, destPath: existingPath, deduplicated: true };
        }
        const now = new Date();
        const year = String(now.getFullYear());
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const targetDir = path.join(RAW_DIR, year, month);
        const desiredName = `${path.basename(safeOrigName, origExt)}${origExt}`;
        const saved = await persistUniqueUpload(fileObj, targetDir, desiredName, fullSha256,
          hasSiblingWithSameBasename(year, month, desiredName));
        updateShaIndex(fullSha256, { year, month, filename: saved.filename,
          size: saved.stat.size, mtimeMs: saved.stat.mtimeMs });
        return { year, month, ...saved, destPath: path.join(targetDir, saved.filename) };
      });

      invalidateScanCache();

      const cfg = getConfig();
      const stat = fs.existsSync(destPath) ? fs.statSync(destPath) : { size: 0 };

      appendAuditLog({
        action: 'upload',
        ip: getClientIp(req),
        year,
        month,
        filename,
        size: stat.size,
        deduplicated,
        sha256: fullSha256
      });

      const hasCollision = hasSiblingWithSameBasename(year, month, filename);
      const assetMeta = buildAssetUrlsAndMeta(cfg, {
        year,
        month,
        filename,
        originalName: safeOrigName,
        hasBasenameCollision: hasCollision
      });
      const locked = isItemLocked(year, month, filename);

      return res.json({
        success: true,
        deduplicated,
        locked,
        inProtectedFolder: year === 'protected',
        optimizationEnabled: assetMeta.optimizationEnabled,
        sha256: fullSha256,
        category: assetMeta.category,
        year,
        month,
        filename,
        originalName: safeOrigName,
        url: assetMeta.rawUrl,
        rawUrl: assetMeta.rawUrl,
        pubUrl: assetMeta.pubUrl,
        markdown: assetMeta.markdown
      });
    } catch (err) {
      console.error('[FileMaster] Upload error:', err);
      return res.status(err.status || 500).json({ error: 'Failed to save file: ' + err.message });
    } finally {
      if (tmpPath && fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
      }
    }
  };

  const uploadRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 120,
    message: 'Upload rate limit exceeded. Please wait before uploading more files.'
  });

  // 1.1 Fast SHA-256 Probe Endpoint for Instant Upload (0-payload client deduplication)
  const handleProbe = async (req, res) => {
    try {
      const sha256 = String(req.query.sha256 || req.body?.sha256 || '')
        .trim()
        .toLowerCase();
      if (!sha256 || sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(sha256)) {
        return res.status(400).json({ error: 'Valid 64-character sha256 is required' });
      }

      const match = await findExistingBySha256(sha256);
      if (!match) {
        return res.json({ exists: false });
      }
      const cfg = getConfig();
      const hasCollision = hasSiblingWithSameBasename(match.year, match.month, match.filename);
      const assetMeta = buildAssetUrlsAndMeta(cfg, {
        year: match.year,
        month: match.month,
        filename: match.filename,
        originalName: match.filename,
        hasBasenameCollision: hasCollision
      });
      const locked = isItemLocked(match.year, match.month, match.filename);

      return res.json({
        exists: true,
        success: true,
        deduplicated: true,
        locked,
        inProtectedFolder: match.year === 'protected',
        optimizationEnabled: assetMeta.optimizationEnabled,
        sha256,
        category: assetMeta.category,
        year: match.year,
        month: match.month,
        filename: match.filename,
        originalName: match.filename,
        url: assetMeta.rawUrl,
        rawUrl: assetMeta.rawUrl,
        pubUrl: assetMeta.pubUrl,
        markdown: assetMeta.markdown
      });
    } catch (err) {
      console.error('[FileMaster] Probe error:', err);
      return res.status(500).json({ error: 'Probe check failed: ' + err.message });
    }
  };

  app.get('/api/image/probe', requireApiOrAdmin, serializeMutation(handleProbe));
  app.post('/api/image/probe', requireApiOrAdmin, serializeMutation(handleProbe));

  app.post('/api/image/upload', uploadRateLimiter, requireApiOrAdmin, acceptSingleUpload, handleUpload);
  app.post(
    '/api/modules/image-host/upload',
    uploadRateLimiter,
    requireApiOrAdmin,
    acceptSingleUpload,
    handleUpload
  );

  // 1.5 Local Pre-Upload Preview Transcode Endpoint (for .heic/.heif/.tiff in Obsidian Modal)
  app.post('/api/image/preview-transcode', uploadRateLimiter, requireApiOrAdmin, acceptSingleUpload, async (req, res) => {
    let tmpInput = null;
    let tmpOutput = null;
    try {
      const fileObj = req.file;
      if (!fileObj || !fileObj.path) {
        return res.status(400).json({ error: 'No file provided for preview transcoding' });
      }
      tmpInput = fileObj.path;
      tmpOutput = `${tmpInput}.preview.jpg`;
      await ensureTranscodedPreviewJpeg(tmpInput, tmpOutput);
      const jpegBuf = fs.readFileSync(tmpOutput);
      res.setHeader('Content-Type', 'image/jpeg');
      return res.send(jpegBuf);
    } catch (err) {
      return res.status(500).json({ error: 'Preview transcode failed: ' + err.message });
    } finally {
      if (tmpInput && fs.existsSync(tmpInput)) {
        try {
          fs.unlinkSync(tmpInput);
        } catch {}
      }
      if (tmpOutput && fs.existsSync(tmpOutput)) {
        try {
          fs.unlinkSync(tmpOutput);
        } catch {}
      }
    }
  });

  // 2. Public / Optimized route: GET /:pubSecretPath/:year/:month/:filename
  const handleOptimizedPublicRequest = async (req, res, next) => {
    try {
      const cfg = getConfig();
      const pubSecret = cfg.image_host?.pub_secret_path || 'pub';
      if (req.params.pubSecretPath && req.params.pubSecretPath !== pubSecret && req.params.pubSecretPath !== 'pub') {
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
      if (!rawFilePath || !isPathWithin(rawFilePath, RAW_DIR)) {
        return res.status(404).send('Not Found');
      }

      setSecurityFileHeaders(res, rawFilePath);

      const rawExt = path.extname(rawFilePath).toLowerCase();
      if (req.method === 'HEAD' && PROCESSABLE_IMAGE_EXTS.has(rawExt)) {
        res.setHeader('Content-Type', 'image/webp');
        return res.status(200).end();
      }
      if (!PROCESSABLE_IMAGE_EXTS.has(rawExt)) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
        return res.sendFile(rawFilePath);
      }

      const rawBasenameWithExt = path.basename(rawFilePath);
      const rawWmParam = String(req.query.wm || req.query.watermark || '').toLowerCase().trim();
      const validWmTypes = ['image', 'text', 'tile'];
      const isCustomVariant = validWmTypes.includes(rawWmParam);

      const globalWmEnabled = cfg.image_host?.watermark_enable !== false;
      const shouldWatermark = isCustomVariant ? true : globalWmEnabled;
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

      if (!fs.existsSync(cacheFilePath)) {
        const effectiveImgCfg = {
          ...cfg.image_host,
          watermark_enable: shouldWatermark,
          watermark_type: activeWmType
        };
        await processAndCacheImage(rawFilePath, cacheFilePath, effectiveImgCfg);
        invalidateScanCache();
      }

      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return res.sendFile(cacheFilePath);
    } catch (err) {
      console.error('[FileMaster] Failed to serve public file:', err);
      if (err.status === 503) res.setHeader('Retry-After', '2');
      return res.status(err.status || 500).send('File Processing Error');
    }
  };

  app.get('/pub/:year/:month/:filename', handleOptimizedPublicRequest);
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
      if (!rawFilePath || !isPathWithin(rawFilePath, RAW_DIR)) {
        return res.status(404).send('Not Found');
      }

      setSecurityFileHeaders(res, rawFilePath);

      const ext = path.extname(rawFilePath).toLowerCase();
      if (req.query.thumbnail === '1' && PROCESSABLE_IMAGE_EXTS.has(ext)) {
        const thumbnailPath = path.join(CACHE_DIR, year, month, `${path.basename(rawFilePath)}.thumb.webp`);
        const hadThumbnail = fs.existsSync(thumbnailPath);
        await ensureThumbnail(rawFilePath, thumbnailPath);
        if (!hadThumbnail) invalidateScanCache();
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'private, max-age=2592000');
        return res.sendFile(thumbnailPath);
      }
      if (NEEDS_TRANSCODE_EXTS.has(ext) && req.query.download !== '1' && req.query.raw !== '1') {
        const rawBasenameWithExt = path.basename(rawFilePath);
        const previewCachePath = getRawPreviewCacheFilePath(year, month, rawBasenameWithExt);
        await ensureTranscodedPreviewJpeg(rawFilePath, previewCachePath);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=2592000');
        return res.sendFile(previewCachePath);
      }

      res.setHeader('Cache-Control', 'private, max-age=2592000');
      return res.sendFile(rawFilePath);
    } catch (err) {
      console.error('[FileMaster] Failed to read raw preview:', err);
      if (err.status === 503) res.setHeader('Retry-After', '2');
      return res.status(err.status || 500).send('Preview Error');
    }
  });

  // 4. Console & FileMaster Plugin Management API
  app.get('/api/modules/image-host/list', requireApiOrAdmin, async (req, res) => {
    try {
      res.json(await scanAllImages(getConfig()));
    } catch (err) {
      res.status(500).json({ error: 'Unable to list assets: ' + err.message });
    }
  });

  // One read-only integrity job per process; restarting the server requires rerunning it.
  app.post('/api/modules/image-host/integrity', requireApiOrAdmin, (req, res) => {
    if (integrityCheck.state === 'running') return res.status(202).json(integrityCheck);
    getShaIndex();
    const expected = new Map(pathToShaMap);
    integrityController = new AbortController();
    integrityCheck = { state: 'running', checked: 0, matched: 0, issues: [], startedAt: Date.now() };
    const job = integrityCheck;
    verifyOriginalFiles(RAW_DIR, expected, {
      signal: integrityController.signal,
      onProgress: (progress) => Object.assign(job, progress)
    }).then((result) => Object.assign(job, result, { state: 'completed' }))
      .catch((err) => Object.assign(job, { state: err.name === 'AbortError' ? 'cancelled' : 'failed',
        error: err.name === 'AbortError' ? undefined : err.message }))
      .finally(() => { job.finishedAt = Date.now(); });
    return res.status(202).json(job);
  });
  app.get('/api/modules/image-host/integrity', requireApiOrAdmin, (req, res) => res.json(integrityCheck));
  app.delete('/api/modules/image-host/integrity', requireApiOrAdmin, (req, res) => {
    integrityController?.abort();
    res.json({ success: true });
  });

  // 4.1 Toggle "Protected Lock" state on remote asset
  app.post('/api/modules/image-host/lock', requireApiOrAdmin, serializeMutation(async (req, res) => {
    const year = sanitizeSegment(req.body?.year);
    const month = sanitizeSegment(req.body?.month);
    const filename = sanitizeSegment(req.body?.filename);
    const locked = Boolean(req.body?.locked);

    if (!isValidYearSeg(year) || !isValidMonthSeg(month) || !filename || !isAllowedAttachmentFile(filename)) {
      return res.status(400).json({ error: 'Invalid file path parameters' });
    }
    const rawFilePath = path.join(RAW_DIR, year, month, filename);
    if (!isPathWithin(rawFilePath, RAW_DIR)) {
      return res.status(403).json({ error: 'Access denied: path traversal attempt detected' });
    }
    const finalLocked = setItemLockState(year, month, filename, locked);
    invalidateScanCache();
    appendAuditLog({
      action: locked ? 'lock' : 'unlock',
      ip: getClientIp(req),
      year,
      month,
      filename
    });
    return res.json({
      success: true,
      year,
      month,
      filename,
      locked: finalLocked
    });
  }));

  app.delete('/api/modules/image-host/item/:year/:month/:filename', requireApiOrAdmin, serializeMutation(async (req, res) => {
    const year = sanitizeSegment(req.params.year);
    const month = sanitizeSegment(req.params.month);
    const filename = sanitizeSegment(req.params.filename);

    if (!isValidYearSeg(year) || !isValidMonthSeg(month) || !filename || !isAllowedAttachmentFile(filename)) {
      return res.status(400).json({ error: 'Invalid file path parameters' });
    }

    const rawFilePath = path.join(RAW_DIR, year, month, filename);
    if (!isPathWithin(rawFilePath, RAW_DIR)) {
      return res.status(403).json({ error: 'Access denied: path traversal attempt detected' });
    }

    if (isItemLocked(year, month, filename)) {
      return res.status(403).json({
        error: `File "${filename}" is locked against deletion. Unlock before deleting.`
      });
    }

    const cacheFilePath = getWebpCacheFilePath(year, month, filename);
    const legacyCacheFilePath = getLegacyWebpCacheFilePath(year, month, filename);
    const rawPreviewCachePath = getRawPreviewCacheFilePath(year, month, filename);
    const legacyPreviewCachePath = path.join(CACHE_DIR, year, month, `${path.parse(filename).name}.raw_preview.jpg`);

    let deletedSize = 0;
    let deletedSha = null;

    if (fs.existsSync(rawFilePath)) {
      try {
        const stat = fs.statSync(rawFilePath);
        deletedSize = stat.size;
        deletedSha = await hashFileSha256(rawFilePath);
        const trashDay = new Date().toISOString().slice(0, 10);
        const trashTargetDir = path.join(TRASH_DIR, trashDay, year, month);
        fs.mkdirSync(trashTargetDir, { recursive: true });
        const parsed = path.parse(filename);
        const trashName = `${parsed.name}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${parsed.ext}`;
        const trashTarget = path.join(trashTargetDir, trashName);
        await moveFileToTrash(rawFilePath, trashTarget, deletedSha);
      } catch (err) {
        console.error('[FileMaster] Failed to move file to trash:', err);
        return res.status(500).json({ error: 'Failed to move file to trash; original file was preserved' });
      }
    }

    // Explicit deletion retires the path even if its bytes changed or were already missing.
    getShaIndex();
    const relKey = `${year}/${month}/${filename}`;
    const indexedSha = pathToShaMap.get(relKey)?.sha256;
    if (indexedSha) {
      try { removeShaIndex(indexedSha, relKey); }
      catch (err) { console.warn('[FileMaster] Failed to update SHA index after deletion:', err); }
    }

    // Safely clean up associated cache files without failing the delete response if unlink throws
    const hasRemainingSibling = hasSiblingWithSameBasename(year, month, filename);
    const cacheTargets = [
      cacheFilePath,
      getWebpCacheFilePath(year, month, filename, 'clean'),
      getWebpCacheFilePath(year, month, filename, 'image'),
      getWebpCacheFilePath(year, month, filename, 'text'),
      getWebpCacheFilePath(year, month, filename, 'tile'),
      path.join(CACHE_DIR, year, month, `${filename}.thumb.webp`),
      path.join(CACHE_DIR, year, month, `${filename}.thumb.webp.preview.jpg`),
      rawPreviewCachePath
    ];
    if (!hasRemainingSibling) {
      cacheTargets.push(legacyCacheFilePath, legacyPreviewCachePath);
    }
    for (const cache of [...cacheTargets]) {
      if (cache.endsWith('.webp')) cacheTargets.push(path.join(path.dirname(cache), `${path.parse(cache).name}.raw_preview.jpg`));
    }
    for (const target of new Set(cacheTargets)) {
      try {
        if (isPathWithin(target, CACHE_DIR) && fs.existsSync(target)) {
          fs.unlinkSync(target);
        }
      } catch (err) {
        console.warn('[FileMaster] Failed to remove cache file after deletion:', target, err.message);
      }
    }

    invalidateScanCache();

    appendAuditLog({
      action: 'delete_to_trash',
      ip: getClientIp(req),
      year,
      month,
      filename,
      size: deletedSize,
      sha256: deletedSha
    });

    return res.json({ success: true, movedToTrash: true });
  }));

  app.post('/api/modules/image-host/cache/clear', requireApiOrAdmin, (req, res) => {
    clearCacheDir();
    res.json({
      success: true,
      message: 'Watermark and WebP cache cleared successfully. Regenerates on next request.'
    });
  });
}

module.exports = {
  acceptSingleUpload,
  moveFileToTrash,
  registerImageHostModule,
  scanAllImages,
  invalidateScanCache,
  getWebpCacheFilePath,
  findRawFile,
  clearCacheDir
};
