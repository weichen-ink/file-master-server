const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getConfig, TRASH_DIR, UPLOAD_TMP_DIR, prepareConfigPatch } = require('../../../core/config');
const { requireApiOrAdmin, requireAdmin, getClientIp } = require('../../../core/security');
const { appendAuditLog } = require('../../../core/audit');
const {
  getFileCategory,
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
const { moveFileToTrash, trashMetadata, publicTrashEntries, findTrash, restoreTrash, deleteTrash } = require('../trash');
const { renderDraftPreview, ensureThumbnail } = require('../processor');
const { removeAssetStats } = require('../stats');

let integrityCheck = { state: 'idle', checked: 0, matched: 0, issues: [] };
let integrityController = null;

/** Console / plugin management API: listing, integrity check, lock, delete, cache clear. */
function registerManageRoutes(app) {
  app.get('/api/modules/image-host/trash', requireApiOrAdmin, (req,res) => {
    try { res.json({items:publicTrashEntries()}); } catch(error) { res.status(500).json({error:error.message}); }
  });
  // Deleted assets stay private. Temporary raster output cannot revive their public URLs.
  app.get('/api/modules/image-host/trash/:id/preview', requireApiOrAdmin, async (req,res) => {
    let dir;
    try {
      const item = findTrash(req.params.id);
      if (getFileCategory(path.extname(item.filename)) !== 'image') return res.status(415).json({error:'This file has no image preview'});
      fs.mkdirSync(UPLOAD_TMP_DIR,{recursive:true});
      dir = fs.mkdtempSync(path.join(UPLOAD_TMP_DIR,'trash-preview-'));
      const output = path.join(dir,'preview.webp');
      if (req.query.thumbnail === '1') await ensureThumbnail(item.fullPath,output);
      else await renderDraftPreview(item.fullPath,output,{enable_optimization:false});
      // Recheck after conversion: a concurrent restore/delete must invalidate the request.
      findTrash(req.params.id);
      res.set('Cache-Control','private, no-store').set('X-Content-Type-Options','nosniff').type('image/webp').send(fs.readFileSync(output));
    } catch(error) { res.status(error.status || (error.code === 'ENOENT' ? 404 : 422)).json({error: error.status ? error.message : 'Unable to preview this file'}); }
    finally { if (dir) fs.rmSync(dir,{recursive:true,force:true}); }
  });
  app.post('/api/modules/image-host/trash/:id/restore', requireApiOrAdmin, serializeMutation(async (req,res) => {
    try { const result=await restoreTrash(req.params.id); invalidateScanCache(); appendAuditLog({action:'restore_from_trash',ip:getClientIp(req),...result}); res.json(result); }
    catch(error) { res.status(error.status || 500).json({error:error.message}); }
  }));
  app.delete('/api/modules/image-host/trash/:id', requireApiOrAdmin, serializeMutation(async (req,res) => {
    try { const result=deleteTrash(req.params.id); appendAuditLog({action:'permanent_delete',ip:getClientIp(req),trashId:req.params.id}); res.json(result); }
    catch(error) { res.status(error.status || 500).json({error:error.message}); }
  }));
  let previewJobs = 0;
  app.post('/api/modules/image-host/preview', requireAdmin, async (req,res) => {
    if (previewJobs >= 2) return res.status(429).set('Retry-After','1').json({error:'Preview is busy. Try again shortly.'});
    let dir;
    previewJobs++;
    try {
      const {year,month,filename} = req.body || {};
      if (!isValidYearSeg(year) || !isValidMonthSeg(month) || sanitizeSegment(filename) !== filename || !isAllowedAttachmentFile(filename)) return res.status(400).json({error:'Invalid preview file'});
      const raw = path.join(RAW_DIR,year,month,filename);
      if (!isPathWithin(fs.realpathSync(raw),fs.realpathSync(RAW_DIR))) return res.status(403).json({error:'Invalid preview path'});
      const config = prepareConfigPatch({image_host:req.body.image_host || {}}).config;
      fs.mkdirSync(UPLOAD_TMP_DIR,{recursive:true});
      dir=fs.mkdtempSync(path.join(UPLOAD_TMP_DIR,'draft-preview-'));
      const output=path.join(dir,'preview.webp');
      await renderDraftPreview(raw,output,config.image_host);
      res.set('Cache-Control','no-store').type('image/webp').send(fs.readFileSync(output));
    } catch(error) { res.status(error.code==='ENOENT'?404:400).json({error:error.message}); }
    finally {previewJobs--;if(dir)fs.rmSync(dir,{recursive:true,force:true});}
  });

  // 4. Console & File Master Plugin Management API
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
        getShaIndex();
        const known = pathToShaMap.get(`${year}/${month}/${filename}`);
        trashMetadata(trashTarget,{year,month,filename,deletedAt:Date.now(),sha256:deletedSha,baselineSha256:known?.baselineSha256 || known?.sha256 || null});
        try { await moveFileToTrash(rawFilePath, trashTarget, deletedSha); }
        catch(error) { fs.rmSync(trashTarget+'.json',{force:true}); throw error; }
      } catch (err) {
        console.error('[File Master] Failed to move file to trash:', err);
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
      catch (err) { console.warn('[File Master] Failed to update SHA index after deletion:', err); }
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
        console.warn('[File Master] Failed to remove cache file after deletion:', target, err.message);
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
