const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getConfig, TRASH_DIR } = require('../../../core/config');
const { requireApiOrAdmin, getClientIp } = require('../../../core/security');
const { appendAuditLog } = require('../../../core/audit');
const {
  isAllowedAttachmentFile,
  isPathWithin,
  sanitizeSegment,
  isValidYearSeg,
  isValidMonthSeg
} = require('../../../core/file-security');
const { hashFileSha256, verifyOriginalFiles } = require('../asset-files');
const {
  RAW_DIR,
  CACHE_DIR,
  getWebpCacheFilePath,
  getLegacyWebpCacheFilePath,
  getRawPreviewCacheFilePath,
  hasSiblingWithSameBasename
} = require('../asset-paths');
const { pathToShaMap, getShaIndex, removeShaIndex } = require('../sha-index');
const { isItemLocked, setItemLockState } = require('../protection');
const { scanAllImages, invalidateScanCache, clearCacheDir } = require('../catalog');
const { serializeMutation } = require('../mutation-queue');
const { moveFileToTrash } = require('../trash');
const { removeAssetStats } = require('../stats');

let integrityCheck = { state: 'idle', checked: 0, matched: 0, issues: [] };
let integrityController = null;

/** Console / plugin management API: listing, integrity check, lock, delete, cache clear. */
function registerManageRoutes(app) {
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
    removeAssetStats(year, month, filename);
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

module.exports = { registerManageRoutes };
