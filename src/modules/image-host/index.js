const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { STORAGE_DIR, ROOT_DIR, TRASH_DIR, UPLOAD_TMP_DIR, getConfig, readJsonData, writeJsonData } = require('../../core/config');
const { requireAdmin, requireApiOrAdmin, getClientIp, createRateLimiter } = require('../../core/security');
const { appendAuditLog } = require('../../core/audit');
const {
  NEEDS_TRANSCODE_EXTS,
  ensureTranscodedPreviewJpeg,
  processAndCacheImage,
  ensureDefaultWatermark
} = require('./processor');

const RAW_DIR = path.join(STORAGE_DIR, 'raw');
const CACHE_DIR = path.join(STORAGE_DIR, 'cache');

// Processable bitmap image extensions for Sharp WebP transcoding and watermarking
const PROCESSABLE_IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
  '.heic',
  '.heif',
  '.tif',
  '.tiff',
  '.bmp',
  '.jfif',
  '.pjpeg',
  '.pjp'
]);

const IMAGE_EXTS = new Set([
  ...PROCESSABLE_IMAGE_EXTS,
  '.svg',
  '.ico',
  '.apng',
  '.raw',
  '.cr2',
  '.nef',
  '.arw',
  '.dng',
  '.orf',
  '.rw2'
]);

const VIDEO_EXTS = new Set([
  '.mp4',
  '.webm',
  '.mov',
  '.mkv',
  '.avi',
  '.flv',
  '.wmv',
  '.m4v',
  '.3gp',
  '.mpeg',
  '.mpg',
  '.ts',
  '.mts',
  '.m2ts',
  '.ogv',
  '.rm',
  '.rmvb'
]);

const AUDIO_EXTS = new Set([
  '.mp3',
  '.m4a',
  '.wav',
  '.ogg',
  '.oga',
  '.flac',
  '.aac',
  '.wma',
  '.opus',
  '.amr',
  '.mid',
  '.midi',
  '.aiff',
  '.aif',
  '.ape',
  '.alac',
  '.m4b',
  '.caf'
]);

const ARCHIVE_EXTS = new Set([
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.7z',
  '.rar',
  '.bz2',
  '.xz',
  '.zst',
  '.lz4',
  '.dmg',
  '.iso',
  '.pkg'
]);

const IGNORED_SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

const INLINE_SAFE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
  '.bmp',
  '.ico',
  '.mp4',
  '.webm',
  '.mov',
  '.mp3',
  '.m4a',
  '.wav',
  '.ogg',
  '.pdf'
]);

function setSecurityFileHeaders(res, filePath) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Sandbox isolates served assets and disallows script execution within origin
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");

  const ext = path.extname(filePath).toLowerCase();
  if (!INLINE_SAFE_EXTS.has(ext)) {
    const safeName = path.basename(filePath).replace(/["\r\n\0]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}"`);
  }
}

function isPathWithin(targetPath, baseDir) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedBase = path.resolve(baseDir);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
}

function isAllowedAttachmentFile(filename) {
  const base = path.basename(String(filename || '')).trim();
  if (!base || base.startsWith('.')) return false;
  if (IGNORED_SYSTEM_FILES.has(base.toLowerCase())) return false;
  const ext = path.extname(base).toLowerCase();
  return ext.length > 1;
}

function getFileCategory(ext) {
  const e = String(ext || '').toLowerCase();
  if (IMAGE_EXTS.has(e)) return 'image';
  if (e === '.pdf') return 'pdf';
  if (VIDEO_EXTS.has(e)) return 'video';
  if (AUDIO_EXTS.has(e)) return 'audio';
  if (ARCHIVE_EXTS.has(e)) return 'archive';
  return 'document';
}

/**
 * Formats a readable URL file segment while preserving Unicode/CJK characters.
 * Only encodes whitespace and parenthesis characters that interfere with Markdown syntax.
 */
function formatReadableUrlSegment(str) {
  return String(str || '').replace(/[ ()[\]<>#?%]/g, (ch) => encodeURIComponent(ch));
}

function isValidYearSeg(y) {
  return /^\d{4}$/.test(y) || y === 'protected';
}

function isValidMonthSeg(m) {
  return /^\d{2}$/.test(m) || m === 'keep';
}

function getProtectedMap() {
  const data = readJsonData('protected_files', {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function isItemLocked(year, month, filename, protectedMap = null) {
  if (year === 'protected') return true;
  const map = protectedMap || getProtectedMap();
  return Boolean(map[`${year}/${month}/${filename}`]);
}

function setItemLockState(year, month, filename, locked) {
  const map = getProtectedMap();
  const key = `${year}/${month}/${filename}`;
  if (locked) {
    map[key] = { lockedAt: Date.now() };
  } else {
    delete map[key];
  }
  writeJsonData('protected_files', map);
  return Boolean(locked);
}

function ensureDirs() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(path.join(RAW_DIR, 'protected', 'keep'), { recursive: true });
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
  limits: { fileSize: 100 * 1024 * 1024 }
});

function sanitizeSegment(seg) {
  let decoded = String(seg || '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}
  return path.basename(decoded).replace(/[\/\\?%*:|"<>#\0]/g, '_').trim();
}

/**
 * Sanitizes uploaded filenames: preserves CJK characters while replacing spaces
 * and brackets with underscores for clean Markdown readability.
 */
function sanitizeUploadFilename(seg) {
  const base = sanitizeSegment(seg);
  return base.replace(/[\s()[\]]+/g, '_').replace(/_+/g, '_');
}

// In-memory SHA-256 cache to avoid recalculating hashes on repeated list requests
const sha256Cache = new Map();
let shaIndex = null;

function getShaIndex() {
  if (!shaIndex) {
    shaIndex = readJsonData('sha_index', {});
  }
  return shaIndex;
}

function updateShaIndex(sha256, info, flush = true) {
  if (!sha256 || !info) return false;
  const idx = getShaIndex();
  const prev = idx[sha256];
  if (prev && prev.year === info.year && prev.month === info.month && prev.filename === info.filename) {
    return false;
  }
  idx[sha256] = info;
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

function removeShaIndex(sha256) {
  if (!sha256) return;
  const idx = getShaIndex();
  if (idx[sha256]) {
    delete idx[sha256];
    writeJsonData('sha_index', idx);
  }
}

function getFileSha256(fullPath, stat) {
  const cacheKey = `${fullPath}:${stat.size}:${stat.mtimeMs}`;
  if (sha256Cache.has(cacheKey)) {
    return sha256Cache.get(cacheKey);
  }
  const buf = fs.readFileSync(fullPath);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  sha256Cache.set(cacheKey, hash);
  return hash;
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
      delete idx[targetSha256];
      writeJsonData('sha_index', idx);
    }
  }
  return null;
}

/**
 * Resolves raw file path from requested filename (with original ext or .webp).
 */
function findRawFile(year, month, requestedFilename, requireSameExt = false) {
  const monthDir = path.join(RAW_DIR, year, month);
  if (!fs.existsSync(monthDir)) return null;

  const exactPath = path.join(monthDir, requestedFilename);
  if (fs.existsSync(exactPath)) return exactPath;

  const parsed = path.parse(requestedFilename);
  const normReqBase = parsed.name.replace(/[\s_]+/g, '_');
  const reqExt = parsed.ext.toLowerCase();
  const files = fs.readdirSync(monthDir);

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
  const cfgKey = `${cfg.base_url}|${cfg.image_host?.raw_secret_path}|${cfg.image_host?.enable_optimization}`;
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
        const ext = path.extname(file).toLowerCase();

        const fullRawPath = path.join(monthPath, file);
        const stat = fs.statSync(fullRawPath);
        totalRawBytes += stat.size;

        const isProcessableImage = PROCESSABLE_IMAGE_EXTS.has(ext);
        const category = getFileCategory(ext);
        const baseName = path.parse(file).name;
        const cacheFile = path.join(CACHE_DIR, year, month, `${baseName}.webp`);
        const hasCache = isProcessableImage && fs.existsSync(cacheFile);
        let cacheSize = 0;
        if (hasCache) {
          cacheSize = fs.statSync(cacheFile).size;
          totalCacheBytes += cacheSize;
        }

        const readableFileUrlSeg = formatReadableUrlSegment(file);
        const readableBaseUrlSeg = formatReadableUrlSegment(baseName);
        const relPath = `${year}/${month}/${readableFileUrlSeg}`;
        const pubRelPath = isProcessableImage
          ? `${year}/${month}/${readableBaseUrlSeg}.webp`
          : relPath;
        const rawSecret = cfg.image_host.raw_secret_path;
        const sha256 = getFileSha256(fullRawPath, stat);
        if (updateShaIndex(sha256, { year, month, filename: file }, false)) {
          shaIndexDirty = true;
        }
        const locked = isItemLocked(year, month, file, protectedMap);
        const inProtectedFolder = year === 'protected';

        list.push({
          filename: file,
          sha256,
          ext,
          category,
          isImage: category === 'image',
          isProcessableImage,
          year,
          month,
          locked,
          inProtectedFolder,
          size: stat.size,
          cacheSize,
          hasCache,
          createdAt: stat.birthtimeMs || stat.mtimeMs,
          rawUrl: `${cfg.base_url}/${rawSecret}/${relPath}`,
          pubUrl: `${cfg.base_url}/pub/${pubRelPath}`,
          rawPreviewPath: `/${rawSecret}/${relPath}`,
          pubPreviewPath: `/pub/${pubRelPath}`
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
  setTimeout(() => {
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
            const fullPath = path.join(monthPath, file);
            const stat = fs.statSync(fullPath);
            const sha = getFileSha256(fullPath, stat);
            if (!idx[sha]) {
              idx[sha] = { year, month, filename: file };
              added++;
            }
          }
        }
      }
      if (added > 0) {
        writeJsonData('sha_index', idx);
        console.log(`[ImageHost] Warm startup: indexed ${added} missing asset(s) into sha_index.json`);
      }
    } catch (err) {
      console.warn('[ImageHost] Warm index background error:', err.message);
    } finally {
      isIndexWarming = false;
    }
  }, 200).unref();
}

function registerImageHostModule(app) {
  ensureDirs();
  warmShaIndexAsync();
  const initCfg = getConfig();
  const wmPath = path.resolve(ROOT_DIR, initCfg.image_host.watermark_image || './watermark.png');
  ensureDefaultWatermark(wmPath, initCfg.image_host.watermark_text).catch(() => {});

  // 1. Unified attachment upload endpoint (supports custom naming, SHA-256 calculation, and protected/keep storage)
  const handleUpload = (req, res) => {
    let tmpPath = null;
    try {
      const fileObj = req.file || (req.files && req.files[0]);
      if (!fileObj || (!fileObj.buffer && !fileObj.path)) {
        return res.status(400).json({ error: 'No file detected in upload (field name must be "file")' });
      }
      tmpPath = fileObj.path || null;

      // Read filename from headers['x-file-name'] if provided; fix Multer latin1 encoding to utf8
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
        if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        return res.status(400).json({ error: `Invalid attachment filename: ${safeOrigName}` });
      }

      // Compute SHA-256 using streaming from disk or buffer
      let fullSha256;
      if (fileObj.buffer) {
        fullSha256 = crypto.createHash('sha256').update(fileObj.buffer).digest('hex');
      } else {
        const fileBytes = fs.readFileSync(fileObj.path);
        fullSha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');
      }
      const hash8 = fullSha256.slice(0, 8);

      const useProtectedFolder =
        req.headers['x-protected-folder'] === '1' ||
        req.body?.protected === '1' ||
        req.query?.protected === '1';

      const now = new Date();
      let year = useProtectedFolder ? 'protected' : String(now.getFullYear());
      let month = useProtectedFolder ? 'keep' : String(now.getMonth() + 1).padStart(2, '0');
      let targetDir = path.join(RAW_DIR, year, month);
      fs.mkdirSync(targetDir, { recursive: true });

      const desiredBase = path.basename(safeOrigName, origExt) || `${year}${month}`;
      let filename = `${desiredBase}${origExt}`;
      let destPath = path.join(targetDir, filename);
      let deduplicated = false;

      // Helper to persist file content from buffer or temp path
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
        const existStat = fs.statSync(destPath);
        const existSha = getFileSha256(destPath, existStat);
        if (existSha === fullSha256) {
          // Identical name and content: reuse existing file
          deduplicated = true;
          updateShaIndex(fullSha256, { year, month, filename });
        } else {
          // Same name but different content: append 8-char SHA to avoid overwriting
          filename = `${desiredBase}_${hash8}${origExt}`;
          destPath = path.join(targetDir, filename);
          if (!fs.existsSync(destPath)) {
            persistUpload(destPath);
          } else {
            deduplicated = true;
          }
          updateShaIndex(fullSha256, { year, month, filename });
        }
      } else {
        persistUpload(destPath);
        updateShaIndex(fullSha256, { year, month, filename });
      }

      // Clean up temporary upload file if disk storage was used
      if (tmpPath && fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }

      invalidateScanCache();

      const cfg = getConfig();
      const rawSecret = cfg.image_host.raw_secret_path;
      const isProcessableImage = PROCESSABLE_IMAGE_EXTS.has(origExt);
      const category = getFileCategory(origExt);
      const baseName = path.parse(filename).name;

      appendAuditLog({
        action: 'upload',
        ip: getClientIp(req),
        year,
        month,
        filename,
        size: fs.existsSync(destPath) ? fs.statSync(destPath).size : 0,
        deduplicated,
        sha256: fullSha256
      });

      // Preserve Unicode and CJK filename characters in readable URL format
      const readableFile = formatReadableUrlSegment(filename);
      const readableBase = formatReadableUrlSegment(baseName);
      const optimizationEnabled = cfg.image_host?.enable_optimization !== false;
      const rawUrl = `${cfg.base_url}/${rawSecret}/${year}/${month}/${readableFile}`;
      const pubUrl = isProcessableImage
        ? `${cfg.base_url}/pub/${year}/${month}/${readableBase}.webp`
        : `${cfg.base_url}/pub/${year}/${month}/${readableFile}`;

      const cleanTitle = path.basename(safeOrigName, origExt);
      const markdown =
        category === 'image' ? `![](${rawUrl})` : `[📎 ${cleanTitle}${origExt}](${rawUrl})`;
      const locked = isItemLocked(year, month, filename);

      return res.json({
        success: true,
        deduplicated,
        locked,
        inProtectedFolder: year === 'protected',
        optimizationEnabled,
        sha256: fullSha256,
        category,
        year,
        month,
        filename,
        originalName: safeOrigName,
        url: rawUrl,
        rawUrl,
        pubUrl,
        markdown
      });
    } catch (err) {
      console.error('[FileMaster] Upload error:', err);
      return res.status(500).json({ error: 'Failed to save file: ' + err.message });
    }
  };

  const uploadRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 120,
    message: 'Upload rate limit exceeded. Please wait before uploading more files.'
  });

  app.post('/api/image/upload', uploadRateLimiter, requireApiOrAdmin, upload.any(), handleUpload);
  app.post('/api/upload', uploadRateLimiter, requireApiOrAdmin, upload.any(), handleUpload);

  // 1.5 Server-side preview transcode endpoint (for Obsidian client local HEIC/HEIF/TIFF previewing via Linux server)
  app.post('/api/image/preview-transcode', uploadRateLimiter, requireApiOrAdmin, upload.any(), async (req, res) => {
    let tmpInput = null;
    let tmpOutput = null;
    try {
      const fileObj = req.file || (req.files && req.files[0]);
      if (!fileObj || !fileObj.path) {
        return res.status(400).json({ error: 'No image file provided' });
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
        try { fs.unlinkSync(tmpInput); } catch {}
      }
      if (tmpOutput && fs.existsSync(tmpOutput)) {
        try { fs.unlinkSync(tmpOutput); } catch {}
      }
    }
  });

  // 2. Public route: GET /pub/:year/:month/:filename
  // (Images processed with sharp WebP compression + watermark; documents/media streamed directly)
  app.get('/pub/:year/:month/:filename', async (req, res) => {
    try {
      const cfg = getConfig();
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

      const baseName = path.parse(rawFilePath).name;
      const cacheFilePath = path.join(CACHE_DIR, year, month, `${baseName}.webp`);

      if (!fs.existsSync(cacheFilePath)) {
        const cfg = getConfig();
        await processAndCacheImage(rawFilePath, cacheFilePath, cfg.image_host);
        invalidateScanCache();
      }

      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return res.sendFile(cacheFilePath);
    } catch (err) {
      console.error('[FileMaster] Failed to serve public file:', err);
      return res.status(500).send('File Processing Error');
    }
  });

  // 3. Raw file access via secret path: GET /:rawSecretPath/:year/:month/:filename
  // (Auto-transcodes .heic/.heif/.tiff to JPEG for <img> preview unless ?download=1 is set)
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
        const baseName = path.parse(rawFilePath).name;
        const previewCachePath = path.join(CACHE_DIR, year, month, `${baseName}.raw_preview.jpg`);
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
    if (year === 'protected' && !locked) {
      return res.status(400).json({ error: 'Files in protected/keep/ are permanently protected by default' });
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

  app.delete('/api/modules/image-host/item/:year/:month/:filename', requireApiOrAdmin, (req, res) => {
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
        error: `File "${filename}" is locked against deletion (or resides in protected directory). Unlock before deleting.`
      });
    }

    const baseName = path.parse(filename).name;
    const cacheFilePath = path.join(CACHE_DIR, year, month, `${baseName}.webp`);
    const rawPreviewCachePath = path.join(CACHE_DIR, year, month, `${baseName}.raw_preview.jpg`);

    let deletedSize = 0;
    let deletedSha = null;

    if (fs.existsSync(rawFilePath)) {
      try {
        const stat = fs.statSync(rawFilePath);
        deletedSize = stat.size;
        deletedSha = getFileSha256(rawFilePath, stat);
        removeShaIndex(deletedSha);

        // Move to storage/trash/ instead of permanent unrecoverable deletion
        const trashDay = new Date().toISOString().slice(0, 10);
        const trashTargetDir = path.join(TRASH_DIR, trashDay, year, month);
        fs.mkdirSync(trashTargetDir, { recursive: true });
        const trashTarget = path.join(trashTargetDir, filename);
        fs.renameSync(rawFilePath, trashTarget);
      } catch (err) {
        // Fallback to unlinkSync if rename failed across filesystem boundaries
        if (fs.existsSync(rawFilePath)) fs.unlinkSync(rawFilePath);
      }
    }
    if (isPathWithin(cacheFilePath, CACHE_DIR) && fs.existsSync(cacheFilePath)) fs.unlinkSync(cacheFilePath);
    if (isPathWithin(rawPreviewCachePath, CACHE_DIR) && fs.existsSync(rawPreviewCachePath)) fs.unlinkSync(rawPreviewCachePath);

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

    res.json({ success: true, movedToTrash: true });
  });

  app.post('/api/modules/image-host/cache/clear', requireApiOrAdmin, (req, res) => {
    clearCacheDir();
    res.json({ success: true, message: 'Watermark and WebP cache cleared successfully. Regenerates on next request.' });
  });
}

module.exports = {
  registerImageHostModule,
  scanAllImages,
  invalidateScanCache
};
