const path = require('node:path');
const fs = require('node:fs');
const { readCriticalJsonData, writeJsonData, isRecord, dataRevision } = require('../../core/config');
const { isValidYearSeg, isValidMonthSeg, isPathWithin } = require('../../core/file-security');
const { hashFileSha256 } = require('./asset-files');
const { RAW_DIR } = require('./asset-paths');

// Bounded LRU in-memory SHA-256 cache to avoid unbounded memory growth
const MAX_SHA_CACHE_ENTRIES = 2000;
const sha256Cache = new Map();
let shaIndex = null;
let loadedRevision;
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

const validHash = value => /^[a-f0-9]{64}$/.test(value);
function validateShaIndex(saved) {
  if (!isRecord(saved)) return false;
  const validInfo = info => isRecord(info) && (info.baselineSha256 == null || validHash(info.baselineSha256)) &&
    Number.isFinite(info.size) && Number.isFinite(info.mtimeMs);
  if (saved.version === 2) return isRecord(saved.files) && Object.entries(saved.files).every(([rel,info]) => {
    const [year,month,filename,...extra] = rel.split('/');
    return !extra.length && isValidYearSeg(year) && isValidMonthSeg(month) && filename && validInfo(info) && validHash(info.sha256);
  });
  return Object.entries(saved).every(([sha,info]) => validHash(sha) && validInfo(info) &&
    isValidYearSeg(info.year) && isValidMonthSeg(info.month) && typeof info.filename === 'string' && !/[\\/]/.test(info.filename));
}
function getShaIndex() {
  const revision = dataRevision('sha_index');
  if (!shaIndex || revision !== loadedRevision) {
    const saved = readCriticalJsonData('sha_index', {}, validateShaIndex);
    // Validate completely before replacing either cache, so a failed load cannot leave an empty index.
    const next = {}, paths = new Map();
    const entries = saved.version === 2 ? Object.entries(saved.files) : Object.entries(saved).map(([sha,info]) =>
      [`${info.year}/${info.month}/${info.filename}`, {...info,sha256:sha}]);
    for (const [rel,info] of entries) {
      const [year,month,filename] = rel.split('/');
      next[info.sha256] = {year,month,filename,size:info.size,mtimeMs:info.mtimeMs,baselineSha256:info.baselineSha256 || info.sha256};
      paths.set(rel,{sha256:info.sha256,baselineSha256:info.baselineSha256 || info.sha256,size:info.size,mtimeMs:info.mtimeMs});
    }
    shaIndex = next; pathToShaMap.clear(); for (const [rel,info] of paths) pathToShaMap.set(rel,info);
    loadedRevision = revision;
    sha256Cache.clear();
  }
  return shaIndex;
}

function writeShaIndex() {
  // Also check before flushing a long scan; do not overwrite state replaced during that scan.
  if (dataRevision('sha_index') !== loadedRevision) {
    readCriticalJsonData('sha_index', {}, validateShaIndex);
    throw Object.assign(new Error('SHA index changed on disk; retry after reloading'),{status:409});
  }
  writeJsonData('sha_index', { version: 2, files: Object.fromEntries(pathToShaMap) });
  loadedRevision = dataRevision('sha_index');
}

function updateShaIndex(sha256, info, flush = true) {
  if (!sha256 || !info) return false;
  const idx = getShaIndex();
  const rel = `${info.year}/${info.month}/${info.filename}`;
  const previousPath = pathToShaMap.get(rel);
  if (previousPath?.sha256 && previousPath.sha256 !== sha256) {
    removeShaIndex(previousPath.sha256, rel, false);
  }
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
  pathToShaMap.set(rel, {
    sha256,
    baselineSha256: previousPath?.baselineSha256 || previousPath?.sha256 || info.baselineSha256 || sha256,
    size: info.size,
    mtimeMs: info.mtimeMs
  });
  if (flush) {
    writeShaIndex();
  }
  return true;
}

function removeShaIndex(sha256, relKey = null, flush = true) {
  const idx = getShaIndex();
  const entry = idx[sha256];
  const canonical = entry ? `${entry.year}/${entry.month}/${entry.filename}` : null;
  pathToShaMap.delete(relKey || canonical);
  if (entry && (!relKey || canonical === relKey)) {
    delete idx[sha256];
    for (const [rel, info] of pathToShaMap) {
      if (info.sha256 !== sha256) continue;
      const [year, month, filename] = rel.split('/');
      idx[sha256] = { year, month, filename, size: info.size, mtimeMs: info.mtimeMs };
      break;
    }
  }
  if (flush) writeShaIndex();
}

/**
 * Computes SHA-256 with an asynchronous stream; consults validated metadata caches first.
 */
async function getFileSha256(fullPath, stat, relKey = null) {
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
        indexed.size === stat.size && indexed.mtimeMs === stat.mtimeMs
      ) {
        setBoundedShaCache(cacheKey, indexed.sha256);
        return indexed.sha256;
      }
    }
  }

  const digest = await hashFileSha256(fullPath);
  setBoundedShaCache(cacheKey, digest);
  return digest;
}

/**
 * Index entries are hints. Verify bytes without erasing missing/corrupt baselines.
 */
async function findExistingBySha256(targetSha256, preferred = null) {
  const idx = getShaIndex();
  const entry = idx[targetSha256];
  const candidates = new Set();
  if (entry) candidates.add(`${entry.year}/${entry.month}/${entry.filename}`);
  for (const [rel, info] of pathToShaMap) {
    if (info.sha256 === targetSha256) candidates.add(rel);
  }
  if (preferred) candidates.add(`${preferred.year}/${preferred.month}/${preferred.filename}`);
  for (const rel of candidates) {
    const fullPath = path.join(RAW_DIR, rel);
    const stat = await fs.promises.lstat(fullPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat?.isFile() || !isPathWithin(await fs.promises.realpath(fullPath), fs.realpathSync(RAW_DIR))) continue;
    const actual = await hashFileSha256(path.join(RAW_DIR, rel)).catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (actual === targetSha256) {
      const [year, month, filename] = rel.split('/');
      return { year, month, filename };
    }
  }
  return null;
}

module.exports = {
  pathToShaMap,
  getShaIndex,
  writeShaIndex,
  updateShaIndex,
  removeShaIndex,
  getFileSha256,
  findExistingBySha256
};
