const fs = require('node:fs');
const path = require('node:path');
const { STORAGE_DIR, TRASH_DIR, UPLOAD_TMP_DIR } = require('../../core/config');
const { isAllowedAttachmentFile } = require('../../core/file-security');

const RAW_DIR = path.join(STORAGE_DIR, 'raw');
const CACHE_DIR = path.join(STORAGE_DIR, 'cache');

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

function ensureDirs() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
}

module.exports = {
  RAW_DIR,
  ensureDirs,
  CACHE_DIR,
  getWebpCacheFilePath,
  getLegacyWebpCacheFilePath,
  getRawPreviewCacheFilePath,
  hasSiblingWithSameBasename,
  findRawFile
};
