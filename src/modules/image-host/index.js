const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const {
  ROOT_DIR,
  STORAGE_DIR,
  TRASH_DIR,
  UPLOAD_TMP_DIR,
  getConfig,
  readJsonData,
  writeJsonData
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
  processAndCacheImage
} = require('./processor');

const RAW_DIR = path.join(STORAGE_DIR, 'raw');
const CACHE_DIR = path.join(STORAGE_DIR, 'cache');

function getProtectedMap() {
  const data = readJsonData('protected_files', {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function isItemLocked(year, month, filename, protectedMap = null) {
  const map = protectedMap || getProtectedMap();
  const key = `${year}/${month}/${filename}`;
  if (map[key] !== undefined) {
    return Boolean(map[key]);
  }
  if (year === 'protected') return true;
  return false;
}

function setItemLockState(year, month, filename, locked) {
  const map = getProtectedMap();
  const key = `${year}/${month}/${filename}`;
  if (locked) {
    map[key] = { lockedAt: Date.now() };
  } else {
    if (year === 'protected') {
      map[key] = false;
    } else {
      delete map[key];
    }
  }
  writeJsonData('protected_files', map);
  return Boolean(locked);
}

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

// Bounded LRU in-memory SHA-256 cache to avoid unbounded memory growth
const MAX_SHA_CACHE_ENTRIES = 2000;
const sha256Cache = new Map();
let shaIndex = null;
const pathToShaMap = new Map();

function setBoundedShaCache(key, hash) {
  if (sha256Cache.has(key)) {
    sha256Cache.delete(key);
  } else if (sha256Cache.size >= MAX_SHA_CACHE_ENTRIES) {
    const oldestKey = sha256Cache.keys().next().value;
    if (oldestKey !== undefined) {
      sha256Cache.delete(oldestKey);
    }
  }
  sha256Cache.set(key, hash);
}

function rebuildPathToShaMap(idx) {
  pathToShaMap.clear();
  for (const [sha, info] of Object.entries(idx || {})) {
    if (info && info.year && info.month && info.filename) {
      pathToShaMap.set(`${info.year}/${info.month}/${info.filename}`, {
        sha256: sha,
        size: info.size,
        mtimeMs: info.mtimeMs
      });
    }
  }
}

function getShaIndex() {
  if (!shaIndex) {
    shaIndex = readJsonData('sha_index', {});
    rebuildPathToShaMap(shaIndex);
  }
  return shaIndex;
}

function updateShaIndex(sha256, info, flush = true) {
  if (!sha256 || !info) return false;
  const idx = getShaIndex();
  const prev = idx[sha256];
  const sameEntry =
    prev &&
    prev.year === info.year &&
    prev.month === info.month &&
    prev.filename === info.filename &&
    prev.size === info.size &&
    prev.mtimeMs === info.mtimeMs;
  if (sameEntry) {
    return false;
  }
  idx[sha256] = info;
  pathToShaMap.set(`${info.year}/${info.month}/${info.filename}`, {
    sha256,
    size: info.size,
    mtimeMs: info.mtimeMs
  });
  if (flush) {
    writeJsonData('sha_index', idx);
  }
  return true;
}

let cachedScanData = null;
let cachedScanTime = 0;
let cachedScanCfgKey = '';
const SCAN_CACHE_TTL_MS = 30 * 1000;

function invalidateScanCache() {
  cachedScanData = null;
  cachedScanTime = 0;
}

function removeShaIndex(sha256, relKey = null) {
  const idx = getShaIndex();
  if (sha256 && idx[sha256]) {
    const entry = idx[sha256];
    if (entry && entry.year && entry.month && entry.filename) {
      pathToShaMap.delete(`${entry.year}/${entry.month}/${entry.filename}`);
    }
    delete idx[sha256];
    writeJsonData('sha_index', idx);
  }
  if (relKey) {
    pathToShaMap.delete(relKey);
  }
}

/**
 * Computes SHA-256 using a fixed 64KB chunk buffer rather than loading the entire file into RAM,
 * and consults the bounded LRU cache and persistent sha_index first.
 */
const SYNC_HASH_CHUNK_SIZE = 64 * 1024;
const sharedChunkBuf = Buffer.allocUnsafe(SYNC_HASH_CHUNK_SIZE);

function getFileSha256(fullPath, stat, relKey = null) {
  const cacheKey = `${fullPath}:${stat.size}:${stat.mtimeMs}`;
  if (sha256Cache.has(cacheKey)) {
    const hit = sha256Cache.get(cacheKey);
    setBoundedShaCache(cacheKey, hit);
    return hit;
  }

  if (relKey) {
    getShaIndex();
    const indexed = pathToShaMap.get(relKey);
    if (indexed && indexed.sha256) {
      if (
        (indexed.size === undefined || indexed.size === stat.size) &&
        (indexed.mtimeMs === undefined || indexed.mtimeMs === stat.mtimeMs)
      ) {
        setBoundedShaCache(cacheKey, indexed.sha256);
        return indexed.sha256;
      }
    }
  }

  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(fullPath, 'r');
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, sharedChunkBuf, 0, SYNC_HASH_CHUNK_SIZE, null);
      if (bytesRead > 0) {
        hash.update(sharedChunkBuf.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }

  const digest = hash.digest('hex');
  setBoundedShaCache(cacheKey, digest);
  return digest;
}

function hashFileSha256(fullPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(fullPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
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
 * Checks whether an existing remote file matches the target SHA-256 hash using index cache.
 */
function findExistingBySha256(targetSha256) {
  const idx = getShaIndex();
  const entry = idx[targetSha256];
  if (entry && entry.year && entry.month && entry.filename) {
    const fullPath = path.join(RAW_DIR, entry.year, entry.month, entry.filename);
    if (fs.existsSync(fullPath)) {
      return entry;
    } else {
      pathToShaMap.delete(`${entry.year}/${entry.month}/${entry.filename}`);
      delete idx[targetSha256];
      writeJsonData('sha_index', idx);
    }
  }
  return null;
}

/**
 * Resolves cache file paths keyed by full raw filename (e.g., photo.jpg.webp vs photo.png.webp)
 * so same-basename files with different extensions never collide in the cache.
 */
function getWebpCacheFilePath(year, month, rawFilename, wmVariant = null) {
  if (wmVariant && ['image', 'text', 'tile'].includes(wmVariant)) {
    return path.join(CACHE_DIR, year, month, `${rawFilename}.wm_${wmVariant}.webp`);
  }
  if (wmVariant === 'clean' || wmVariant === 'none') {
    return path.join(CACHE_DIR, year, month, `${rawFilename}.clean.webp`);
  }
  return path.join(CACHE_DIR, year, month, `${rawFilename}.webp`);
}

function getLegacyWebpCacheFilePath(year, month, rawFilename) {
  const baseName = path.parse(rawFilename).name;
  return path.join(CACHE_DIR, year, month, `${baseName}.webp`);
}

function getRawPreviewCacheFilePath(year, month, rawFilename) {
  return path.join(CACHE_DIR, year, month, `${rawFilename}.raw_preview.jpg`);
}

/**
 * Checks whether multiple allowed files in the given month directory share the same basename.
 */
function hasSiblingWithSameBasename(year, month, filename, filesList = null) {
  const monthDir = path.join(RAW_DIR, year, month);
  const files = filesList || (fs.existsSync(monthDir) ? fs.readdirSync(monthDir) : []);
  const targetBase = path.parse(filename).name.replace(/[\s_]+/g, '_');
  let count = 0;
  for (const f of files) {
    if (!isAllowedAttachmentFile(f)) continue;
    const fBase = path.parse(f).name.replace(/[\s_]+/g, '_');
    if (fBase === targetBase) {
      count += 1;
      if (count > 1 || f !== filename) return true;
    }
  }
  return false;
}

/**
 * Resolves raw file path from requested filename (supports exact name, <rawFilename>.webp, or <baseName>.webp).
 */
function findRawFile(year, month, requestedFilename, requireSameExt = false) {
  const monthDir = path.join(RAW_DIR, year, month);
  if (!fs.existsSync(monthDir)) return null;

  const exactPath = path.join(monthDir, requestedFilename);
  if (fs.existsSync(exactPath)) return exactPath;

  const files = fs.readdirSync(monthDir);

  // If requesting "<rawFilename>.webp" (e.g. "photo.png.webp"), check exact stripped name first
  if (!requireSameExt && requestedFilename.toLowerCase().endsWith('.webp')) {
    const strippedRawName = requestedFilename.slice(0, -5);
    const strippedExactPath = path.join(monthDir, strippedRawName);
    if (fs.existsSync(strippedExactPath) && isAllowedAttachmentFile(strippedRawName)) {
      return strippedExactPath;
    }
    const normStripped = strippedRawName.replace(/[\s_]+/g, '_');
    for (const f of files) {
      if (!isAllowedAttachmentFile(f)) continue;
      if (f.replace(/[\s_]+/g, '_') === normStripped) {
        return path.join(monthDir, f);
      }
    }
  }

  const parsed = path.parse(requestedFilename);
  const normReqBase = parsed.name.replace(/[\s_]+/g, '_');
  const reqExt = parsed.ext.toLowerCase();

  for (const f of files) {
    if (!isAllowedAttachmentFile(f)) continue;
    const fp = path.parse(f);
    if (requireSameExt && fp.ext.toLowerCase() !== reqExt) continue;
    if (fp.name === parsed.name || fp.name.replace(/[\s_]+/g, '_') === normReqBase) {
      return path.join(monthDir, f);
    }
  }
  return null;
}

/**
 * Scans all raw assets and compiles summary metrics.
 */
function scanAllImages(cfg, forceRefresh = false) {
  const cfgKey = `${cfg.base_url}|${cfg.image_host?.raw_secret_path}|${cfg.image_host?.pub_secret_path}|${cfg.image_host?.enable_optimization}`;
  const now = Date.now();
  if (!forceRefresh && cachedScanData && cfgKey === cachedScanCfgKey && now - cachedScanTime < SCAN_CACHE_TTL_MS) {
    return cachedScanData;
  }

  ensureDirs();
  const protectedMap = getProtectedMap();
  const list = [];
  let totalRawBytes = 0;
  let totalCacheBytes = 0;
  let shaIndexDirty = false;

  const years = fs
    .readdirSync(RAW_DIR)
    .filter((d) => isValidYearSeg(d))
    .sort((a, b) => {
      if (a === 'protected') return -1;
      if (b === 'protected') return 1;
      return b.localeCompare(a);
    });

  for (const year of years) {
    const yearPath = path.join(RAW_DIR, year);
    if (!fs.statSync(yearPath).isDirectory()) continue;

    const months = fs
      .readdirSync(yearPath)
      .filter((m) => isValidMonthSeg(m))
      .sort()
      .reverse();
    for (const month of months) {
      const monthPath = path.join(yearPath, month);
      if (!fs.statSync(monthPath).isDirectory()) continue;

      const files = fs.readdirSync(monthPath);
      for (const file of files) {
        if (!isAllowedAttachmentFile(file)) continue;

        const fullRawPath = path.join(monthPath, file);
        const stat = fs.statSync(fullRawPath);
        totalRawBytes += stat.size;

        const hasCollision = hasSiblingWithSameBasename(year, month, file, files);
        const assetMeta = buildAssetUrlsAndMeta(cfg, {
          year,
          month,
          filename: file,
          hasBasenameCollision: hasCollision
        });

        const primaryCacheFile = getWebpCacheFilePath(year, month, file);
        const legacyCacheFile = getLegacyWebpCacheFilePath(year, month, file);
        let activeCacheFile = null;
        if (assetMeta.isProcessableImage) {
          if (fs.existsSync(primaryCacheFile)) {
            activeCacheFile = primaryCacheFile;
          } else if (!hasCollision && fs.existsSync(legacyCacheFile)) {
            activeCacheFile = legacyCacheFile;
          }
        }
        const hasCache = Boolean(activeCacheFile);
        let cacheSize = 0;
        if (hasCache) {
          cacheSize = fs.statSync(activeCacheFile).size;
          totalCacheBytes += cacheSize;
        }

        const relKey = `${year}/${month}/${file}`;
        const sha256 = getFileSha256(fullRawPath, stat, relKey);
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
          pubPreviewPath: assetMeta.pubPreviewPath
        });
      }
    }
  }

  if (shaIndexDirty) {
    writeJsonData('sha_index', getShaIndex());
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
  cachedScanData = result;
  cachedScanTime = now;
  cachedScanCfgKey = cfgKey;
  return result;
}

/**
 * Recursively clears the image processing cache directory.
 */
function clearCacheDir() {
  if (fs.existsSync(CACHE_DIR)) {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  invalidateScanCache();
}

let isIndexWarming = false;

function warmShaIndexAsync() {
  if (isIndexWarming) return;
  isIndexWarming = true;
  const timer = setTimeout(async () => {
    try {
      ensureDirs();
      const idx = getShaIndex();
      let added = 0;
      const years = fs.readdirSync(RAW_DIR).filter((d) => isValidYearSeg(d));
      for (const year of years) {
        const yearPath = path.join(RAW_DIR, year);
        if (!fs.statSync(yearPath).isDirectory()) continue;
        const months = fs.readdirSync(yearPath).filter((m) => isValidMonthSeg(m));
        for (const month of months) {
          const monthPath = path.join(yearPath, month);
          if (!fs.statSync(monthPath).isDirectory()) continue;
          const files = fs.readdirSync(monthPath);
          for (const file of files) {
            if (!isAllowedAttachmentFile(file)) continue;
            const relKey = `${year}/${month}/${file}`;
            const fullPath = path.join(monthPath, file);
            const stat = fs.statSync(fullPath);
            const existing = pathToShaMap.get(relKey);
            if (
              existing &&
              existing.sha256 &&
              existing.size === stat.size &&
              existing.mtimeMs === stat.mtimeMs
            ) {
              continue;
            }
            const sha = await hashFileSha256(fullPath);
            setBoundedShaCache(`${fullPath}:${stat.size}:${stat.mtimeMs}`, sha);
            if (
              updateShaIndex(
                sha,
                { year, month, filename: file, size: stat.size, mtimeMs: stat.mtimeMs },
                false
              )
            ) {
              added++;
            }
            await new Promise((r) => setImmediate(r));
          }
        }
      }
      if (added > 0) {
        writeJsonData('sha_index', idx);
        console.log(`[ImageHost] Warm startup: indexed ${added} asset(s) into sha_index.json`);
      }
    } catch (err) {
      console.warn('[ImageHost] Warm index background error:', err.message);
    } finally {
      isIndexWarming = false;
    }
  }, 200);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

function registerImageHostModule(app) {
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
      const hash8 = fullSha256.slice(0, 8);

      const now = new Date();
      let year = String(now.getFullYear());
      let month = String(now.getMonth() + 1).padStart(2, '0');
      const targetDir = path.join(RAW_DIR, year, month);
      fs.mkdirSync(targetDir, { recursive: true });

      const desiredBase = path.basename(safeOrigName, origExt) || `${year}${month}`;
      let filename = `${desiredBase}${origExt}`;
      let destPath = path.join(targetDir, filename);
      let deduplicated = false;

      const persistUpload = (target) => {
        if (fileObj.buffer) {
          fs.writeFileSync(target, fileObj.buffer);
        } else if (fileObj.path && fs.existsSync(fileObj.path)) {
          fs.copyFileSync(fileObj.path, target);
        }
      };

      // 1. Cross-month global deduplication by content SHA-256
      const existingMatch = findExistingBySha256(fullSha256);
      if (existingMatch) {
        year = existingMatch.year;
        month = existingMatch.month;
        filename = existingMatch.filename;
        destPath = path.join(RAW_DIR, year, month, filename);
        deduplicated = true;
      } else if (fs.existsSync(destPath)) {
        const existSha = await hashFileSha256(destPath);
        if (existSha === fullSha256) {
          deduplicated = true;
        } else {
          filename = `${desiredBase}_${hash8}${origExt}`;
          destPath = path.join(targetDir, filename);
          if (!fs.existsSync(destPath)) {
            persistUpload(destPath);
          } else {
            deduplicated = true;
          }
        }
        const stat = fs.statSync(destPath);
        updateShaIndex(fullSha256, { year, month, filename, size: stat.size, mtimeMs: stat.mtimeMs });
      } else {
        // Also disambiguate if another file in the same month folder shares the basename with a different extension
        if (hasSiblingWithSameBasename(year, month, filename)) {
          filename = `${desiredBase}_${hash8}${origExt}`;
          destPath = path.join(targetDir, filename);
        }
        if (!fs.existsSync(destPath)) {
          persistUpload(destPath);
        } else {
          deduplicated = true;
        }
        const stat = fs.statSync(destPath);
        updateShaIndex(fullSha256, { year, month, filename, size: stat.size, mtimeMs: stat.mtimeMs });
      }

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
      return res.status(500).json({ error: 'Failed to save file: ' + err.message });
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
  const handleProbe = (req, res) => {
    try {
      const sha256 = String(req.query.sha256 || req.body?.sha256 || '')
        .trim()
        .toLowerCase();
      if (!sha256 || sha256.length !== 64 || !/^[0-9a-f]{64}$/.test(sha256)) {
        return res.status(400).json({ error: 'Valid 64-character sha256 is required' });
      }

      const match = findExistingBySha256(sha256);
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

  app.get('/api/image/probe', requireApiOrAdmin, handleProbe);
  app.post('/api/image/probe', requireApiOrAdmin, handleProbe);

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
      return res.status(500).send('File Processing Error');
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
      return res.status(500).send('Preview Error');
    }
  });

  // 4. Console & FileMaster Plugin Management API
  app.get('/api/modules/image-host/list', requireApiOrAdmin, (req, res) => {
    const cfg = getConfig();
    const data = scanAllImages(cfg);
    res.json(data);
  });

  // 4.1 Toggle "Protected Lock" state on remote asset
  app.post('/api/modules/image-host/lock', requireApiOrAdmin, (req, res) => {
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
  });

  app.delete('/api/modules/image-host/item/:year/:month/:filename', requireApiOrAdmin, async (req, res) => {
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
      try {
        removeShaIndex(deletedSha, `${year}/${month}/${filename}`);
      } catch (err) {
        console.warn('[FileMaster] Failed to update SHA index after deletion:', err);
      }
    }

    // Safely clean up associated cache files without failing the delete response if unlink throws
    const hasRemainingSibling = hasSiblingWithSameBasename(year, month, filename);
    const cacheTargets = [
      cacheFilePath,
      getWebpCacheFilePath(year, month, filename, 'clean'),
      getWebpCacheFilePath(year, month, filename, 'image'),
      getWebpCacheFilePath(year, month, filename, 'text'),
      getWebpCacheFilePath(year, month, filename, 'tile'),
      rawPreviewCachePath
    ];
    if (!hasRemainingSibling) {
      cacheTargets.push(legacyCacheFilePath, legacyPreviewCachePath);
    }
    for (const target of cacheTargets) {
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
  });

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
  findRawFile
};
