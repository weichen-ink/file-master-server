const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR, STORAGE_DIR, getConfig, readJsonData, writeJsonData } = require('../../core/config');
const { requireApiOrAdmin, getClientIp, createRateLimiter } = require('../../core/security');
const { appendAuditLog } = require('../../core/audit');
const {
  isPathWithin,
  setSecurityFileHeaders,
  sanitizeSegment,
  isValidYearSeg,
  isValidMonthSeg,
  isAllowedAttachmentFile
} = require('../../core/file-security');

const RAW_DIR = path.join(STORAGE_DIR, 'raw');
const SHARES_FILE_PATH = path.join(DATA_DIR, 'shares.json');

let cachedSharesMap = null;
let cachedSharesMtimeMs = 0;
let flushTimer = null;

function getSharesMap() {
  try {
    if (fs.existsSync(SHARES_FILE_PATH)) {
      const mtimeMs = fs.statSync(SHARES_FILE_PATH).mtimeMs;
      if (!cachedSharesMap || mtimeMs !== cachedSharesMtimeMs) {
        const data = readJsonData('shares', {});
        cachedSharesMap = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
        cachedSharesMtimeMs = mtimeMs;
      }
      return cachedSharesMap;
    }
  } catch {}
  if (!cachedSharesMap) {
    const data = readJsonData('shares', {});
    cachedSharesMap = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }
  return cachedSharesMap;
}

function saveSharesMap(map) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  cachedSharesMap = map;
  writeJsonData('shares', map);
  try {
    if (fs.existsSync(SHARES_FILE_PATH)) {
      cachedSharesMtimeMs = fs.statSync(SHARES_FILE_PATH).mtimeMs;
    }
  } catch {}
}

function scheduleSharesFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (cachedSharesMap) {
      try {
        saveSharesMap(cachedSharesMap);
      } catch (err) {
        console.warn('[Share] Failed to flush shares.json:', err.message);
      }
    }
  }, 1500);
  if (typeof flushTimer.unref === 'function') {
    flushTimer.unref();
  }
}

function createShareRecord({ year, month, filename, expiresInHours = 24, maxDownloads = 0 }) {
  const y = sanitizeSegment(year);
  const m = sanitizeSegment(month);
  const f = sanitizeSegment(filename);

  if (!y || !m || !f || !isValidYearSeg(y) || !isValidMonthSeg(m) || !isAllowedAttachmentFile(f)) {
    throw new Error('Missing or invalid year, month, or filename');
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
  const shareDownloadLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 120,
    message: 'Too many share download requests from this IP. Please try again later.'
  });

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
        const target = path.resolve(RAW_DIR, String(item.year), String(item.month), String(item.filename));
        let fileExists = false;
        try { fileExists = isPathWithin(target, RAW_DIR) && isPathWithin(fs.realpathSync(target), RAW_DIR) && fs.statSync(target).isFile(); } catch {}
        const state = !fileExists ? 'fileMissing' : expiredByTime ? 'expired' : expiredByCount ? 'quotaUsed' : 'active';
        return {
          ...item,
          fileExists,
          state,
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
  app.get('/s/:shareId', shareDownloadLimiter, (req, res) => {
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

    // Express also routes HEAD through this handler; metadata checks must not
    // consume a limited share before a client actually requests its body.
    if (req.method !== 'HEAD') {
      item.downloads = (item.downloads || 0) + 1;
      map[shareId] = item;
      if (item.maxDownloads > 0 && item.downloads >= item.maxDownloads) {
        saveSharesMap(map);
      } else {
        scheduleSharesFlush();
      }
    }

    const forceDownloadName = req.query.download === '1' ? path.basename(fullPath) : null;
    setSecurityFileHeaders(res, fullPath, forceDownloadName);

    return res.sendFile(fullPath);
  });
}

module.exports = {
  registerShareModule,
  createShareRecord,
  getSharesMap
};
