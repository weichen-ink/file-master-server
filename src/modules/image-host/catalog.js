const fs = require('node:fs');
const path = require('node:path');
const { getConfig } = require('../../core/config');
const { buildAssetUrlsAndMeta } = require('../../core/file-security');
const { walkOriginalFiles } = require('./asset-files');
const { invalidateProcessingCache } = require('./processor');
const { getProtectedMap, isItemLocked } = require('./protection');
const {
  RAW_DIR,
  CACHE_DIR,
  ensureDirs,
  getWebpCacheFilePath
} = require('./asset-paths');
const { updateShaIndex, writeShaIndex, getFileSha256 } = require('./sha-index');
const { assetCachePaths } = require('./asset-cache');
const { assetReferenceUrls } = require('./asset-names');
const { mutateAssets } = require('./mutation-queue');
const { getAssetStats } = require('./stats');

let cachedScanData = null;
let cachedScanTime = 0;
let cachedScanCfgKey = '';
const SCAN_CACHE_TTL_MS = 30 * 1000;
let scanGeneration = 0;
let pendingScan = null;

function invalidateScanCache() {
  scanGeneration++;
  cachedScanData = null;
  cachedScanTime = 0;
}

/**
 * Scans all raw assets and compiles summary metrics.
 */
function scanAllImages(cfg, forceRefresh = false) {
  try { require('./trash').recoverPendingTrash(); } catch (error) { return Promise.reject(error); }
  const cfgKey = `${cfg.base_url}|${cfg.image_host?.raw_secret_path}|${cfg.image_host?.pub_secret_path}|${cfg.image_host?.enable_optimization}`;
  const now = Date.now();
  if (!forceRefresh && cachedScanData && cfgKey === cachedScanCfgKey && now - cachedScanTime < SCAN_CACHE_TTL_MS) {
    return Promise.resolve(cachedScanData);
  }

  const generation = scanGeneration;
  const key = `${cfgKey}:${generation}`;
  if (pendingScan?.key === key) return pendingScan.promise;
  // Catalog scans also update the hash index, so share the mutation queue.
  const promise = mutateAssets(() => collectImages(cfg)).then((result) => {
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
  require('./trash').recoverPendingTrash();
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

    let assetCacheBytes = 0;
    if (assetMeta.isProcessableImage) {
      const candidateCacheFiles = assetCachePaths(year,month,file);
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

    const assetStats = getAssetStats(year, month, file);

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
      size: stat.size,
      cacheSize,
      webpSize: cacheSizes.get(expectedCacheFile) ?? null,
      hasCache,
      createdAt: stat.birthtimeMs || stat.mtimeMs,
      hits: assetStats.hits || 0,
      lastAccessedAt: assetStats.lastAccessedAt || null,
      referenceUrls: assetReferenceUrls(cfg, year, month, file, assetMeta),
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

function cachedCatalogSummary() {
  return cachedScanData && Date.now()-cachedScanTime<SCAN_CACHE_TTL_MS ? {...cachedScanData.stats} : null;
}
module.exports = { cachedCatalogSummary, scanAllImages, invalidateScanCache, clearCacheDir, warmShaIndexAsync };
