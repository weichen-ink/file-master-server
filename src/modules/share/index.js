const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { STORAGE_DIR, getConfig, readJsonData, writeJsonData } = require('../../core/config');
const { requireApiOrAdmin, getClientIp } = require('../../core/security');
const { appendAuditLog } = require('../../core/audit');

const RAW_DIR = path.join(STORAGE_DIR, 'raw');

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

function isPathWithin(targetPath, baseDir) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedBase = path.resolve(baseDir);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
}

function getSharesMap() {
  const data = readJsonData('shares', {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function saveSharesMap(map) {
  writeJsonData('shares', map);
}

function createShareRecord({ year, month, filename, expiresInHours = 24, maxDownloads = 0 }) {
  const y = path.basename(String(year || '')).trim();
  const m = path.basename(String(month || '')).trim();
  const f = path.basename(String(filename || '')).trim();

  if (!y || !m || !f) {
    throw new Error('Missing year, month, or filename');
  }
  const fullPath = path.join(RAW_DIR, y, m, f);
  if (!isPathWithin(fullPath, RAW_DIR) || !fs.existsSync(fullPath)) {
    throw new Error('Target asset does not exist');
  }

  const shareId = crypto.randomBytes(8).toString('base64url');
  const now = Date.now();
  const hours = Number(expiresInHours);
  const expiresAt = hours > 0 ? now + Math.round(hours * 3600 * 1000) : 0;
  const maxDl = Math.max(0, parseInt(maxDownloads, 10) || 0);

  const record = {
    id: shareId,
    year: y,
    month: m,
    filename: f,
    size: fs.statSync(fullPath).size,
    createdAt: now,
    expiresAt,
    maxDownloads: maxDl,
    downloads: 0
  };

  const map = getSharesMap();
  map[shareId] = record;
  saveSharesMap(map);
  return record;
}

function registerShareModule(app) {
  // 1. Create a new expiring share link
  app.post('/api/modules/share/create', requireApiOrAdmin, (req, res) => {
    try {
      const { year, month, filename, expiresInHours = 24, maxDownloads = 0 } = req.body || {};
      const record = createShareRecord({ year, month, filename, expiresInHours, maxDownloads });
      const cfg = getConfig();
      const shareUrl = `${cfg.base_url}/s/${record.id}`;

      appendAuditLog({
        action: 'share_create',
        ip: getClientIp(req),
        shareId: record.id,
        year: record.year,
        month: record.month,
        filename: record.filename,
        expiresAt: record.expiresAt,
        maxDownloads: record.maxDownloads
      });

      return res.json({
        success: true,
        share: {
          ...record,
          shareUrl
        }
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  // 2. List all share links
  app.get('/api/modules/share/list', requireApiOrAdmin, (req, res) => {
    const cfg = getConfig();
    const map = getSharesMap();
    const now = Date.now();
    const list = Object.values(map)
      .map((item) => {
        const expiredByTime = item.expiresAt > 0 && now >= item.expiresAt;
        const expiredByCount = item.maxDownloads > 0 && item.downloads >= item.maxDownloads;
        return {
          ...item,
          expired: expiredByTime || expiredByCount,
          shareUrl: `${cfg.base_url}/s/${item.id}`
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    return res.json({ shares: list });
  });

  // 3. Revoke / delete a share link
  app.delete('/api/modules/share/:shareId', requireApiOrAdmin, (req, res) => {
    const shareId = String(req.params.shareId || '').trim();
    const map = getSharesMap();
    if (map[shareId]) {
      delete map[shareId];
      saveSharesMap(map);
      appendAuditLog({
        action: 'share_revoke',
        ip: getClientIp(req),
        shareId
      });
    }
    return res.json({ success: true });
  });

  // 4. Public access route: GET /s/:shareId
  app.get('/s/:shareId', (req, res) => {
    const shareId = String(req.params.shareId || '').trim();
    const map = getSharesMap();
    const item = map[shareId];
    if (!item) {
      return res.status(404).send('Share link not found or has been revoked.');
    }

    const now = Date.now();
    if (item.expiresAt > 0 && now >= item.expiresAt) {
      return res.status(410).send('This share link has expired.');
    }
    if (item.maxDownloads > 0 && item.downloads >= item.maxDownloads) {
      return res.status(410).send('This share link has reached its maximum download limit.');
    }

    const fullPath = path.join(RAW_DIR, item.year, item.month, item.filename);
    if (!isPathWithin(fullPath, RAW_DIR) || !fs.existsSync(fullPath)) {
      return res.status(404).send('Underlying shared file no longer exists.');
    }

    item.downloads = (item.downloads || 0) + 1;
    map[shareId] = item;
    saveSharesMap(map);

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    const ext = path.extname(fullPath).toLowerCase();
    const forceDownload = req.query.download === '1' || !INLINE_SAFE_EXTS.has(ext);
    if (forceDownload) {
      const safeName = path.basename(fullPath).replace(/["\r\n\0]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}"`);
    }

    return res.sendFile(fullPath);
  });
}

module.exports = {
  registerShareModule,
  createShareRecord,
  getSharesMap
};
