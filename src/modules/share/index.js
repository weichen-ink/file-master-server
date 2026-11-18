const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { STORAGE_DIR, getConfig, readCriticalJsonData, writeJsonData, isRecord, dataRevision } = require('../../core/config');
const { requireApiOrAdmin, getClientIp, createRateLimiter } = require('../../core/security');
const { appendAuditLog } = require('../../core/audit');
const {
  isPathWithin,
  setSecurityFileHeaders,
  sanitizeSegment,
  isValidYearSeg,
  isValidMonthSeg,
  isAllowedAttachmentFile,
  buildAssetUrlsAndMeta
} = require('../../core/file-security');

const RAW_DIR = path.join(STORAGE_DIR, 'raw');
const MAX_HASH_CONCURRENCY = 4;

let activeHashStreams = 0;
const hashWaitQueue = [];

function runWithHashConcurrency(taskFn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      activeHashStreams += 1;
      Promise.resolve()
        .then(taskFn)
        .then(resolve, reject)
        .finally(() => {
          activeHashStreams -= 1;
          const next = hashWaitQueue.shift();
          if (next) next();
        });
    };
    if (activeHashStreams < MAX_HASH_CONCURRENCY) start();
    else hashWaitQueue.push(start);
  });
}

function isValidSharedFilePath(fullPath) {
  try {
    if (!isPathWithin(fullPath, RAW_DIR) || !fs.existsSync(fullPath)) return false;
    const realTarget = fs.realpathSync(fullPath);
    const realRoot = fs.realpathSync(RAW_DIR);
    return isPathWithin(realTarget, realRoot) && fs.statSync(realTarget).isFile();
  } catch {
    return false;
  }
}

async function resolveSharedTargetAsync(fullPath) {
  try {
    if (!isPathWithin(fullPath, RAW_DIR)) return { valid: false };
    const [realTarget, realRoot] = await Promise.all([
      fs.promises.realpath(fullPath),
      fs.promises.realpath(RAW_DIR)
    ]);
    if (!isPathWithin(realTarget, realRoot)) return { valid: false };
    const stat = await fs.promises.stat(realTarget);
    if (!stat.isFile()) return { valid: false };
    const sig = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    return { valid: true, realTarget, stat, sig };
  } catch {
    return { valid: false };
  }
}

const fileHashMemo = new Map();
const inFlightHashes = new Map();

function rememberFileHash(realTarget, sig, digest) {
  if (fileHashMemo.size > 2000) fileHashMemo.clear();
  fileHashMemo.set(realTarget, { sig, sha256: digest });
}

function computeFileSha256Sync(fullPath, force = false) {
  const realTarget = fs.realpathSync(fullPath);
  const stat = fs.statSync(realTarget);
  const sig = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  if (!force) {
    const cached = fileHashMemo.get(realTarget);
    if (cached && cached.sig === sig) return cached.sha256;
  }
  const fd = fs.openSync(realTarget, 'r');
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(64 * 1024);
  try {
    let readBytes = 0;
    while ((readBytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, readBytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  const digest = hash.digest('hex');
  rememberFileHash(realTarget, sig, digest);
  return digest;
}

function streamFileSha256(realTarget) {
  return runWithHashConcurrency(
    () =>
      new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(realTarget, { highWaterMark: 64 * 1024 });
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
      })
  );
}

function computeVerifiedSha256ForTarget(realTarget, sig, { force = false, batchMemo = null } = {}) {
  const identityKey = `${realTarget}:${sig}`;
  if (batchMemo && batchMemo.has(identityKey)) {
    return batchMemo.get(identityKey);
  }
  if (!force) {
    const cached = fileHashMemo.get(realTarget);
    if (cached && cached.sig === sig) {
      const hit = Promise.resolve(cached.sha256);
      if (batchMemo) batchMemo.set(identityKey, hit);
      return hit;
    }
  }
  let inFlight = inFlightHashes.get(identityKey);
  if (!inFlight) {
    inFlight = streamFileSha256(realTarget)
      .then((digest) => {
        rememberFileHash(realTarget, sig, digest);
        return digest;
      })
      .finally(() => {
        if (inFlightHashes.get(identityKey) === inFlight) {
          inFlightHashes.delete(identityKey);
        }
      });
    inFlightHashes.set(identityKey, inFlight);
  }
  if (batchMemo) batchMemo.set(identityKey, inFlight);
  return inFlight;
}

let cachedSharesMap = null;
let cachedSharesMtimeMs = 0;
let flushTimer = null;

function validateShares(value) {
  return isRecord(value) && Object.values(value).every(item => isRecord(item) &&
    typeof item.id === 'string' && isValidYearSeg(item.year) && isValidMonthSeg(item.month) &&
    isAllowedAttachmentFile(item.filename) && Number.isFinite(item.expiresAt) && Number.isFinite(item.downloads) && Number.isFinite(item.maxDownloads) &&
    (item.sha256 == null || /^[a-f0-9]{64}$/.test(item.sha256)));
}
function getSharesMap() {
  const revision = dataRevision('shares');
  if (!cachedSharesMap || revision !== cachedSharesMtimeMs) {
    const data = readCriticalJsonData('shares', {}, validateShares);
    cachedSharesMap = data; cachedSharesMtimeMs = revision;
  }
  return cachedSharesMap;
}

function saveSharesMap(map) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  readCriticalJsonData('shares', {}, validateShares);
  writeJsonData('shares', map);
  cachedSharesMap = map;
  cachedSharesMtimeMs = dataRevision('shares');
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

function validateAndResolveShareInput({ year, month, filename }) {
  const y = sanitizeSegment(year);
  const m = sanitizeSegment(month);
  const f = sanitizeSegment(filename);
  if (!y || !m || !f || !isValidYearSeg(y) || !isValidMonthSeg(m) || !isAllowedAttachmentFile(f)) {
    throw new Error('Missing or invalid year, month, or filename');
  }
  return { y, m, f, fullPath: path.join(RAW_DIR, y, m, f) };
}

function commitShareRecord({ y, m, f, size, sha256, expiresInHours = 24, maxDownloads = 0 }) {
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
    size,
    sha256,
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

function createShareRecord({ year, month, filename, expiresInHours = 24, maxDownloads = 0 }) {
  const { y, m, f, fullPath } = validateAndResolveShareInput({ year, month, filename });
  if (!isValidSharedFilePath(fullPath)) {
    throw new Error('Target asset does not exist');
  }
  const stat = fs.statSync(fullPath);
  const sha256 = computeFileSha256Sync(fullPath);
  return commitShareRecord({ y, m, f, size: stat.size, sha256, expiresInHours, maxDownloads });
}

async function createShareRecordAsync({ year, month, filename, expiresInHours = 24, maxDownloads = 0 }) {
  const { y, m, f, fullPath } = validateAndResolveShareInput({ year, month, filename });
  const targetInfo = await resolveSharedTargetAsync(fullPath);
  if (!targetInfo.valid) {
    throw new Error('Target asset does not exist');
  }
  const sha256 = await computeVerifiedSha256ForTarget(targetInfo.realTarget, targetInfo.sig, { force: false });
  return commitShareRecord({ y, m, f, size: targetInfo.stat.size, sha256, expiresInHours, maxDownloads });
}

/**
 * Inspect a batch of share records while deduplicating stat/realpath and SHA-256
 * streaming by real file identity + version `(realTarget, dev, ino, size, mtimeMs)`.
 */
async function inspectShareRecordsBatch(items, { now = Date.now(), forceHash = false } = {}) {
  const targetInfoPromises = new Map();
  const batchHashPromises = new Map();

  const getTargetInfo = (targetPath) => {
    let p = targetInfoPromises.get(targetPath);
    if (!p) {
      p = resolveSharedTargetAsync(targetPath);
      targetInfoPromises.set(targetPath, p);
    }
    return p;
  };

  return Promise.all(
    items.map(async (item) => {
      const expiredByTime = item.expiresAt > 0 && now >= item.expiresAt;
      const expiredByCount = item.maxDownloads > 0 && item.downloads >= item.maxDownloads;
      const target = path.resolve(RAW_DIR, String(item.year), String(item.month), String(item.filename));
      const info = await getTargetInfo(target);
      const fileExists = info.valid;
      let fileChanged = false;

      if (fileExists && item.sha256) {
        try {
          const currentSha = await computeVerifiedSha256ForTarget(info.realTarget, info.sig, {
            force: forceHash,
            batchMemo: batchHashPromises
          });
          fileChanged = currentSha !== item.sha256;
        } catch {
          return {
            fileExists: false,
            fileChanged: false,
            expiredByTime,
            expiredByCount,
            state: 'fileMissing',
            invalid: true,
            fullPath: target
          };
        }
      }

      const state = !fileExists
        ? 'fileMissing'
        : fileChanged
          ? 'fileChanged'
          : expiredByTime
            ? 'expired'
            : expiredByCount
              ? 'quotaUsed'
              : 'active';

      return {
        fileExists,
        fileChanged,
        expiredByTime,
        expiredByCount,
        state,
        invalid: state !== 'active',
        fullPath: info.realTarget || target
      };
    })
  );
}

async function inspectShareRecord(item, options = {}) {
  const [result] = await inspectShareRecordsBatch([item], options);
  return result;
}

function summarizeShares(shares) {
  const summary = { total: 0, active: 0, invalid: 0, fileMissing: 0, fileChanged: 0, expired: 0, quotaUsed: 0 };
  for (const s of shares) {
    summary.total += 1;
    summary[s.state] = (summary[s.state] || 0) + 1;
    if (s.invalid) summary.invalid += 1;
  }
  return summary;
}

async function buildShareListResponse(cfg, map, { now = Date.now(), forceHash = false } = {}) {
  const items = Object.values(map);
  const checks = await inspectShareRecordsBatch(items, { now, forceHash });
  const shares = items
    .map((item, idx) => {
      const check = checks[idx];
      const meta = buildAssetUrlsAndMeta(cfg, { year: item.year, month: item.month, filename: item.filename });
      return {
        ...item,
        isImage: Boolean(meta.isImage),
        thumbnailUrl: check.fileExists && !check.fileChanged && meta.isImage ? (meta.thumbnailUrl || meta.rawPreviewPath) : '',
        fileExists: check.fileExists,
        fileChanged: check.fileChanged,
        invalid: check.invalid,
        state: check.state,
        expired: check.expiredByTime || check.expiredByCount,
        shareUrl: `${cfg.base_url}/s/${item.id}`
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  return { shares, summary: summarizeShares(shares), checkedAt: now };
}

function sendShareError(req, res, statusCode, title, message) {
  if (req.method !== 'HEAD' && String(req.headers.accept || '').includes('text/html')) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(statusCode).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · File Master</title><style>:root{color-scheme:light dark;--bg:#f6f7fb;--card:#fff;--text:#181b25;--muted:#646b7d;--border:#e3e6ef;--brand:#7132f5}@media(prefers-color-scheme:dark){:root{--bg:#121318;--card:#1b1d24;--text:#eef0f7;--muted:#9ca3b5;--border:#2c303d;--brand:#9b6dff}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font:15px/1.6 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text)}.card{max-width:440px;width:100%;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px;box-shadow:0 12px 36px rgba(0,0,0,.08)}.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;color:var(--brand);background:color-mix(in srgb,var(--brand) 12%,transparent);margin-bottom:12px}h1{margin:0 0 8px;font-size:20px}p{margin:0;color:var(--muted)}</style></head><body><main class="card"><span class="badge">HTTP ${statusCode}</span><h1>${title}</h1><p>${message}</p></main></body></html>`);
  }
  return res.status(statusCode).send(message);
}

function registerShareModule(app) {
  const shareDownloadLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 120,
    message: 'Too many share download requests from this IP. Please try again later.'
  });

  // 1. Create a new expiring share link
  app.post('/api/modules/share/create', requireApiOrAdmin, async (req, res) => {
    try {
      const { year, month, filename, expiresInHours = 24, maxDownloads = 0 } = req.body || {};
      const record = await createShareRecordAsync({ year, month, filename, expiresInHours, maxDownloads });
      const cfg = getConfig();
      const shareUrl = `${cfg.base_url}/s/${record.id}`;

      appendAuditLog({
        action: 'share_create',
        ip: getClientIp(req),
        shareId: record.id,
        year: record.year,
        month: record.month,
        filename: record.filename,
        sha256: record.sha256,
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

  // 2. List all share links (with live path & SHA-256 status check)
  app.get('/api/modules/share/list', requireApiOrAdmin, async (req, res, next) => {
    try {
      const forceHash = req.query.verify === '1' || req.query.verify === 'true';
      const payload = await buildShareListResponse(getConfig(), getSharesMap(), { forceHash });
      return res.json(payload);
    } catch (err) {
      return next(err);
    }
  });

  // 2b. Explicit deep self-check endpoint for #/shares
  app.post('/api/modules/share/verify', requireApiOrAdmin, async (_req, res, next) => {
    try {
      const payload = await buildShareListResponse(getConfig(), getSharesMap(), { forceHash: true });
      return res.json(payload);
    } catch (err) {
      return next(err);
    }
  });

  // 2c. Batch revoke all invalid / expired shares (reuses single deduplicated inspection pass)
  app.post('/api/modules/share/cleanup-invalid', requireApiOrAdmin, async (req, res, next) => {
    try {
      const map = getSharesMap();
      const cfg = getConfig();
      const now = Date.now();
      const inspected = await buildShareListResponse(cfg, map, { now, forceHash: true });

      let removed = 0;
      const remainingShares = [];
      for (const share of inspected.shares) {
        if (share.invalid) {
          if (share.id in map) {
            delete map[share.id];
            removed += 1;
          }
        } else {
          remainingShares.push(share);
        }
      }

      if (removed > 0) {
        saveSharesMap(map);
        appendAuditLog({ action: 'share_cleanup_invalid', ip: getClientIp(req), count: removed });
      }

      return res.json({
        success: true,
        removed,
        shares: remainingShares,
        summary: summarizeShares(remainingShares),
        checkedAt: now
      });
    } catch (err) {
      return next(err);
    }
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
  app.get('/s/:shareId', shareDownloadLimiter, async (req, res, next) => {
    try {
      const shareId = String(req.params.shareId || '').trim();
      const initialMap = getSharesMap();
      const initialItem = initialMap[shareId];
      if (!initialItem) {
        return sendShareError(req, res, 404, 'Share Not Found', 'Share link not found or has been revoked.');
      }

      const now = Date.now();
      if (initialItem.expiresAt > 0 && now >= initialItem.expiresAt) {
        return sendShareError(req, res, 410, 'Share Link Expired', 'This share link has expired.');
      }
      if (initialItem.maxDownloads > 0 && initialItem.downloads >= initialItem.maxDownloads) {
        return sendShareError(req, res, 410, 'Download Limit Reached', 'This share link has reached its maximum download limit.');
      }

      const check = await inspectShareRecord(initialItem, { now });
      if (!check.fileExists) {
        return sendShareError(req, res, 404, 'Shared File Missing', 'Underlying shared file no longer exists.');
      }
      if (check.fileChanged) {
        return sendShareError(req, res, 410, 'Share Link Invalidated', 'This share link is no longer valid because the original file was replaced.');
      }

      // Re-validate live share state & quota synchronously after awaiting async file verification
      const map = getSharesMap();
      const item = map[shareId];
      if (!item) {
        return sendShareError(req, res, 404, 'Share Not Found', 'Share link not found or has been revoked.');
      }
      const postCheckNow = Date.now();
      if (item.expiresAt > 0 && postCheckNow >= item.expiresAt) {
        return sendShareError(req, res, 410, 'Share Link Expired', 'This share link has expired.');
      }
      if (item.maxDownloads > 0 && item.downloads >= item.maxDownloads) {
        return sendShareError(req, res, 410, 'Download Limit Reached', 'This share link has reached its maximum download limit.');
      }

      const fullPath = check.fullPath;

      // Limited shares deliver whole files: Range cannot grant an uncounted download.
      // Unlimited shares retain normal HTTP range support. HEAD never reserves quota.
      const limited = item.maxDownloads > 0;
      const shouldCountDownload = req.method !== 'HEAD';
      if (shouldCountDownload) {
        item.downloads = (item.downloads || 0) + 1;
        map[shareId] = item;
        if (limited) {
          try { saveSharesMap(map); }
          catch (error) { item.downloads -= 1; throw error; }
        } else {
          scheduleSharesFlush();
        }
      }

      const forceDownloadName = req.query.download === '1' ? path.basename(fullPath) : null;
      setSecurityFileHeaders(res, fullPath, forceDownloadName);

      return res.sendFile(fullPath, { acceptRanges: !limited, cacheControl: !limited,
        ...(limited ? { headers: { 'Cache-Control': 'private, no-store' } } : {}) }, (err) => {
        // Reservations prevent concurrent requests from exceeding the limit, but
        // failed transfers and bodyless 304 responses do not consume a download.
        if (shouldCountDownload && (err || res.statusCode < 200 || res.statusCode >= 300)) {
          try {
            const currentMap = getSharesMap();
            const currentItem = currentMap[shareId];
            if (currentItem === item && currentItem.downloads > 0) {
              currentItem.downloads -= 1;
              if (limited) saveSharesMap(currentMap);
              else scheduleSharesFlush();
            }
          } catch (error) {
            console.error('[Share] Failed to release download quota:', error.message);
          }
        }
        if (err && !res.destroyed && !['ECONNABORTED', 'ECONNRESET', 'EPIPE'].includes(err.code)) next(err);
      });
    } catch (err) {
      return next(err);
    }
  });
}

function flushSharesMap() {
  if (!flushTimer || !cachedSharesMap) return;
  clearTimeout(flushTimer);
  flushTimer = null;
  try {
    saveSharesMap(cachedSharesMap);
  } catch (err) {
    console.warn('[Share] Failed to flush shares.json:', err.message);
  }
}

module.exports = {
  saveSharesMap,
  flushSharesMap,
  registerShareModule,
  createShareRecord,
  createShareRecordAsync,
  inspectShareRecord,
  inspectShareRecordsBatch,
  getSharesMap
};
