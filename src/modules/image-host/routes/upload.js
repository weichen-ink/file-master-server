const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getConfig } = require('../../../core/config');
const { requireApiOrAdmin, createRateLimiter, getClientIp } = require('../../../core/security');
const { appendAuditLog } = require('../../../core/audit');
const {
  isAllowedAttachmentFile,
  sanitizeUploadFilename,
  buildAssetUrlsAndMeta
} = require('../../../core/file-security');
const { hashFileSha256, persistUniqueUpload } = require('../asset-files');
const { RAW_DIR, hasSiblingWithSameBasename } = require('../asset-paths');
const { updateShaIndex, findExistingBySha256 } = require('../sha-index');
const { isItemLocked } = require('../protection');
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
}

module.exports = { registerUploadRoutes };
