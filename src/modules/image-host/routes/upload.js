const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getConfig } = require('../../../core/config');
const { requireApiOrAdmin, createRateLimiter, getClientIp } = require('../../../core/security');
const { appendAuditLog } = require('../../../core/audit');
const {
  isAllowedAttachmentFile,
  sanitizeUploadFilename,
  buildAssetUrlsAndMeta,
  isValidYearSeg,
  isValidMonthSeg
} = require('../../../core/file-security');
const { hashFileSha256, persistUniqueUpload } = require('../asset-files');
const { inspectNameAvailability, inspectGlobalNameAvailability, resolveAlias } = require('../asset-names');
const { RAW_DIR, hasSiblingWithSameBasename } = require('../asset-paths');
const { updateShaIndex, findExistingBySha256 } = require('../sha-index');
const { isItemLocked } = require('../protection');
const { replaceAsset, buildConflictDetails } = require('../trash');
const { invalidateScanCache } = require('../catalog');
const { mutateAssets, serializeMutation } = require('../mutation-queue');
const { acceptSingleUpload } = require('../upload-middleware');
const { ensureTranscodedPreviewJpeg } = require('../processor');

/** Upload, instant-upload probe and pre-upload preview transcode endpoints. */
function registerUploadRoutes(app) {
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

      const conflictStrategy = String(
        req.headers['x-conflict-strategy'] || req.body?.conflictStrategy || req.query?.conflictStrategy || ''
      ).trim().toLowerCase();
      const expectedTargetYear = String(req.headers['x-conflict-target-year'] || req.body?.conflictTargetYear || '').trim();
      const expectedTargetMonth = String(req.headers['x-conflict-target-month'] || req.body?.conflictTargetMonth || '').trim();
      const rawTargetFilename = String(req.headers['x-conflict-target-filename'] || req.body?.conflictTargetFilename || '').trim();
      let expectedTargetFilename = rawTargetFilename;
      if (rawTargetFilename) {
        try {
          expectedTargetFilename = decodeURIComponent(rawTargetFilename);
        } catch {}
      }
      const expectedTargetSha256 = String(req.headers['x-conflict-target-sha256'] || req.body?.conflictTargetSha256 || '').trim().toLowerCase();

      const isReplace = conflictStrategy === 'replace' || conflictStrategy === 'overwrite';
      const fullSha256 = fileObj.buffer
        ? crypto.createHash('sha256').update(fileObj.buffer).digest('hex')
        : await hashFileSha256(fileObj.path);
      const { year, month, filename, destPath, deduplicated, replaced } = await mutateAssets(async () => {
        const now = new Date();
        const year = String(now.getFullYear());
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const desiredName = `${path.basename(safeOrigName, origExt)}${origExt}`;
        // Verify bytes first, including a same-name file not yet discovered by index warmup.
        const preferred = { year, month, filename: resolveAlias(year, month, desiredName, false) || desiredName };
        const existing = isReplace ? null : await findExistingBySha256(fullSha256, preferred);
        if (existing) {
          const destPath = path.join(RAW_DIR, existing.year, existing.month, existing.filename);
          const stat = fs.statSync(destPath);
          updateShaIndex(fullSha256, { ...existing, size: stat.size, mtimeMs: stat.mtimeMs });
          return { ...existing, destPath, deduplicated: true, replaced: false };
        }
        const match = inspectGlobalNameAvailability(RAW_DIR, year, month, desiredName);
        const completeTarget = isValidYearSeg(expectedTargetYear) && isValidMonthSeg(expectedTargetMonth) &&
          expectedTargetFilename && /^[a-f0-9]{64}$/.test(expectedTargetSha256);

        let publishYear = year;
        let publishMonth = month;
        let publishName = desiredName;
        let didReplace = false;
        let disambiguate = false;
        let replaceTarget = null;

        if (isReplace && (!completeTarget || !match)) {
          throw Object.assign(new Error('The target file has changed or was removed.'), {
            status: 409,
            code: 'CONFLICT_TARGET_CHANGED',
            ...(match ? { conflict: buildConflictDetails(getConfig(), match.year, match.month, match.issue) } : {})
          });
        }

        if (match) {
          const { year: conflictYear, month: conflictMonth, issue } = match;
          if (conflictStrategy === 'rename') {
            disambiguate = true;
          } else if (issue.code === 'NAME_CONFLICT' && isReplace) {
            const currentConflict = buildConflictDetails(getConfig(), conflictYear, conflictMonth, issue);
            if (conflictYear !== expectedTargetYear || conflictMonth !== expectedTargetMonth ||
                issue.existingFilename !== expectedTargetFilename || currentConflict.sha256 !== expectedTargetSha256) {
              throw Object.assign(new Error('The target file has changed; please review and confirm again.'), {
                status: 409, code: 'CONFLICT_TARGET_CHANGED', conflict: currentConflict
              });
            }
            if (isItemLocked(conflictYear, conflictMonth, issue.existingFilename)) {
              throw Object.assign(new Error('This remote file is locked and cannot be replaced.'), {
                status: 403,
                code: 'FILE_LOCKED'
              });
            }
            publishYear = conflictYear;
            publishMonth = conflictMonth;
            publishName = issue.existingFilename;
            replaceTarget = {
              year: conflictYear,
              month: conflictMonth,
              filename: issue.existingFilename,
              expectedSha256: expectedTargetSha256 || currentConflict.sha256 || null
            };
            didReplace = true;
          } else {
            throw Object.assign(new Error(issue.message), {
              status: 409,
              code: issue.code,
              conflict: buildConflictDetails(getConfig(), conflictYear, conflictMonth, issue)
            });
          }
        }
        const publishDir = path.join(RAW_DIR, publishYear, publishMonth);
        const saved = replaceTarget
          ? await replaceAsset(publishYear, publishMonth, publishName, fileObj, fullSha256, { expectedSha256: replaceTarget.expectedSha256 })
          : await persistUniqueUpload(fileObj, publishDir, publishName, fullSha256, disambiguate, {
              rejectOnConflict: !disambiguate,
              isNameAvailable: (candidate) => !inspectGlobalNameAvailability(RAW_DIR, publishYear, publishMonth, candidate)
            });
        updateShaIndex(fullSha256, {
          year: publishYear, month: publishMonth, filename: saved.filename,
          size: saved.stat.size, mtimeMs: saved.stat.mtimeMs
        });
        return { year: publishYear, month: publishMonth, ...saved, replaced: didReplace && saved.replaced, destPath: path.join(publishDir, saved.filename) };
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
        replaced: Boolean(replaced),
        locked,
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
      console.error('[File Master] Upload error:', err);
      return res.status(err.status || 500).json({
        error: 'Failed to save file: ' + err.message,
        code: err.code,
        ...(err.conflict ? { conflict: err.conflict } : {})
      });
    } finally {
      if (tmpPath && fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch { }
      }
    }
  };

  const uploadRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: () => {
      const cfg = getConfig();
      const val = cfg.image_host?.upload_rate_limit;
      if (val !== undefined) {
        const num = Number(val);
        return isNaN(num) ? 1200 : num;
      }
      return 1200;
    },
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
      console.error('[File Master] Probe error:', err);
      return res.status(500).json({ error: 'Probe check failed: ' + err.message });
    }
  };

  app.get('/api/image/probe', requireApiOrAdmin, serializeMutation(handleProbe));
  app.post('/api/image/probe', requireApiOrAdmin, serializeMutation(handleProbe));

  app.post('/api/image/upload-check', requireApiOrAdmin, serializeMutation(async (req, res) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 500) : [];
      const cfg = getConfig();
      const now = new Date();
      const year = String(now.getFullYear());
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const targetDir = path.join(RAW_DIR, year, month);
      const results = [];
      for (const item of items) {
        const rawName = String(item?.filename || '');
        const safeName = sanitizeUploadFilename(rawName) || 'file.png';
        const ext = path.extname(safeName).toLowerCase() || '.png';
        const desiredName = `${path.basename(safeName, ext)}${ext}`;
        const sha = String(item?.sha256 || '').trim().toLowerCase();
        if (/^[0-9a-f]{64}$/.test(sha)) {
          const preferred = { year, month, filename: resolveAlias(year, month, desiredName, false) || desiredName };
          const existing = await findExistingBySha256(sha, preferred);
          if (existing) {
            const hasCollision = hasSiblingWithSameBasename(existing.year, existing.month, existing.filename);
            const assetMeta = buildAssetUrlsAndMeta(cfg, {
              year: existing.year,
              month: existing.month,
              filename: existing.filename,
              originalName: existing.filename,
              hasBasenameCollision: hasCollision
            });
            results.push({ filename: rawName, status: 'instant', existing: { ...existing, ...assetMeta } });
            continue;
          }
        }
        if (!isAllowedAttachmentFile(safeName)) {
          results.push({ filename: rawName, status: 'invalid' });
          continue;
        }
        const hasExplicitBucket = isValidYearSeg(item?.year) && isValidMonthSeg(item?.month);
        const itemYear = hasExplicitBucket ? String(item.year) : year;
        const itemMonth = hasExplicitBucket ? String(item.month) : month;
        const itemDir = path.join(RAW_DIR, itemYear, itemMonth);
        const match = hasExplicitBucket
          ? (() => {
              const issue = inspectNameAvailability(itemDir, itemYear, itemMonth, desiredName);
              return issue ? { year: itemYear, month: itemMonth, issue } : null;
            })()
          : inspectGlobalNameAvailability(RAW_DIR, year, month, desiredName);
        if (match) {
          results.push({
            filename: rawName,
            status: 'conflict',
            code: match.issue.code,
            conflict: buildConflictDetails(cfg, match.year, match.month, match.issue)
          });
        } else {
          results.push({ filename: rawName, status: 'ok' });
        }
      }
      return res.json({ year, month, results });
    } catch (err) {
      console.error('[File Master] Upload check error:', err);
      return res.status(500).json({ error: 'Upload check failed: ' + err.message });
    }
  }));

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
        } catch { }
      }
      if (tmpOutput && fs.existsSync(tmpOutput)) {
        try {
          fs.unlinkSync(tmpOutput);
          fs.rmSync(tmpOutput + '.source', { force: true });
        } catch { }
      }
    }
  });
}

module.exports = { registerUploadRoutes };
