const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, getConfig, readCriticalJsonData, writeJsonData, isRecord, dataRevision } = require('./config');

// In-memory IP brute-force protection map: ip -> { count, bannedUntil, lastAttempt }
const ipFailures = new Map();
const BAN_DURATION_MS = 24 * 60 * 60 * 1000; // 24-hour lockout
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30-day session retention
const MAX_IP_FAILURES = 2000;

function createSessionCookie(req, token, maxAge = '') {
  return `filemaster_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}${maxAge}`;
}

// Load persisted bans from data/ip_bans.json on server boot and hot-reload when modified on disk
const IP_BANS_PATH = path.join(DATA_DIR, 'ip_bans.json');
let lastBansMtimeMs = -1;
const validIpBans = value => isRecord(value) && Object.values(value).every(item =>
  isRecord(item) && Number.isFinite(item.bannedUntil) && Number.isFinite(item.count));

function loadPersistedBans() {
  try {
    if (!fs.existsSync(IP_BANS_PATH)) {
      if (lastBansMtimeMs !== 0) {
        ipFailures.clear();
        lastBansMtimeMs = 0;
      }
      return;
    }
    const stat = fs.statSync(IP_BANS_PATH);
    if (stat.mtimeMs === lastBansMtimeMs) return;
    const data = readCriticalJsonData('ip_bans', {}, validIpBans);
    lastBansMtimeMs = stat.mtimeMs;
    const now = Date.now();
    // Remove bans that were deleted from disk while preserving non-banned in-memory attempt counters
    for (const [ip, item] of ipFailures.entries()) {
      if (item && item.bannedUntil && !data[ip]) {
        ipFailures.delete(ip);
      }
    }
    for (const [ip, item] of Object.entries(data)) {
      if (item && item.bannedUntil && item.bannedUntil > now) {
        ipFailures.set(ip, item);
      }
    }
  } catch (error) { throw error; }
}

function syncPersistedBans() {
  try {
    const data = {};
    const now = Date.now();
    for (const [ip, item] of ipFailures.entries()) {
      if (item && item.bannedUntil && item.bannedUntil > now) {
        data[ip] = item;
      }
    }
    readCriticalJsonData('ip_bans', {}, validIpBans);
    writeJsonData('ip_bans', data);
    if (fs.existsSync(IP_BANS_PATH)) {
      lastBansMtimeMs = fs.statSync(IP_BANS_PATH).mtimeMs;
    }
  } catch (error) { throw error; }
}

loadPersistedBans();

// Persist instance salt in data/security_meta.json so hot updates & restarts keep active sessions alive,
// while changing username, password, or admin_path still immediately invalidates older cookies.
function loadOrCreateInstanceSalt() {
  const meta = readCriticalJsonData('security_meta', null,
    value => isRecord(value) && typeof value.instanceSalt === 'string' && value.instanceSalt.length >= 16);
  if (meta) return meta.instanceSalt;
  const instanceSalt = crypto.randomBytes(32).toString('hex');
  writeJsonData('security_meta', {instanceSalt,createdAt:Date.now()});
  return instanceSalt;
}

const SERVER_BOOT_SALT = loadOrCreateInstanceSalt();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password, storedHashOrPlain) {
  if (!storedHashOrPlain) return false;
  const str = String(storedHashOrPlain);
  if (str.startsWith('scrypt:')) {
    const parts = str.split(':');
    if (parts.length !== 3) return false;
    const [, salt, expectedDerived] = parts;
    const actualDerived = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
    if (actualDerived.length !== expectedDerived.length) return false;
    return crypto.timingSafeEqual(Buffer.from(actualDerived), Buffer.from(expectedDerived));
  }
  // Fallback for legacy plaintext password with constant time comparison
  const inputBuf = Buffer.from(String(password || ''));
  const storedBuf = Buffer.from(str);
  if (inputBuf.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(inputBuf, storedBuf);
}

function getSigningSecret(cfg) {
  return crypto
    .createHash('sha256')
    .update(`${cfg.username}:${cfg.password}:${cfg.admin_path}:${SERVER_BOOT_SALT}`)
    .digest();
}

function getClientIp(req) {
  if (req && typeof req.ip === 'string' && req.ip.trim()) {
    return req.ip.trim();
  }
  return req?.socket?.remoteAddress || 'unknown';
}

/**
 * Checks whether an IP address is currently banned.
 */
function checkIpBan(ip) {
  loadPersistedBans();
  const record = ipFailures.get(ip);
  if (!record) return { banned: false, remainingAttempts: getConfig().max_login_attempts };

  if (record.bannedUntil && Date.now() < record.bannedUntil) {
    const hoursLeft = Math.ceil((record.bannedUntil - Date.now()) / (3600 * 1000));
    return { banned: true, hoursLeft };
  }

  // Auto unban if ban window has elapsed
  if (record.bannedUntil && Date.now() >= record.bannedUntil) {
    ipFailures.delete(ip);
    syncPersistedBans();
    return { banned: false, remainingAttempts: getConfig().max_login_attempts };
  }

  const max = getConfig().max_login_attempts;
  return { banned: false, remainingAttempts: Math.max(0, max - record.count) };
}

function pruneIpFailures(now = Date.now()) {
  if (ipFailures.size <= 1000) return;
  for (const [k, v] of ipFailures.entries()) {
    const expiredBan = v.bannedUntil && v.bannedUntil <= now;
    const staleFailure = !v.bannedUntil && v.lastAttempt && (now - v.lastAttempt > BAN_DURATION_MS);
    if (expiredBan || staleFailure) ipFailures.delete(k);
  }
  while (ipFailures.size > MAX_IP_FAILURES) {
    const oldestKey = ipFailures.keys().next().value;
    if (oldestKey === undefined) break;
    ipFailures.delete(oldestKey);
  }
}

/**
 * Records a failed authentication attempt; triggers a 24h ban if threshold is exceeded.
 */
function recordLoginFailure(ip) {
  const max = getConfig().max_login_attempts;
  const now = Date.now();
  const record = ipFailures.get(ip) || { count: 0, bannedUntil: 0 };
  record.count += 1;
  record.lastAttempt = now;

  if (record.count >= max) {
    record.bannedUntil = now + BAN_DURATION_MS;
    console.warn(`[Security] IP ${ip} failed ${record.count} consecutive attempts; banned for 24 hours`);
    ipFailures.set(ip, record);
    syncPersistedBans();
  } else {
    ipFailures.set(ip, record);
  }
  pruneIpFailures(now);
  return Math.max(0, max - record.count);
}

function clearLoginFailures(ip) {
  if (ipFailures.has(ip)) {
    ipFailures.delete(ip);
    syncPersistedBans();
  }
}

function getSecurityStats() {
  let activeBans = 0;
  const now = Date.now();
  for (const [, v] of ipFailures.entries()) {
    if (v.bannedUntil && v.bannedUntil > now) activeBans++;
  }
  return { trackedIps: ipFailures.size, activeBans };
}

/**
 * Issues and validates stateless HMAC session tokens.
 */
function createSessionToken(cfg) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ u: cfg.username, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', getSigningSecret(cfg)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Session revocation tracking (dataRevision-cached Set + expiration pruning)
let lastRevokedRevision = null;
let cachedRevokedSet = new Set();
const validRevocations = value => Array.isArray(value) && value.every(token => typeof token === 'string');

function isRevokedTokenExpired(token, now = Date.now()) {
  try {
    const [payload] = String(token || '').split('.');
    if (!payload) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(data?.exp) && data.exp <= now;
  } catch {
    return false;
  }
}

function getRevokedSessionSet() {
  const revision = dataRevision('revoked_sessions');
  if (revision === lastRevokedRevision) return cachedRevokedSet;
  const list = readCriticalJsonData('revoked_sessions', [], validRevocations);
  cachedRevokedSet = new Set(list);
  lastRevokedRevision = revision;
  return cachedRevokedSet;
}

function isSessionRevoked(token) {
  return getRevokedSessionSet().has(token);
}

function revokeSessionToken(token) {
  if (!token) return;
  const now = Date.now();
  const list = readCriticalJsonData('revoked_sessions', [], validRevocations)
    .filter((t) => !isRevokedTokenExpired(t, now));
  if (!list.includes(token)) {
    list.push(token);
  }
  writeJsonData('revoked_sessions', list);
  cachedRevokedSet = new Set(list);
  lastRevokedRevision = dataRevision('revoked_sessions');
}

function verifySessionToken(token, cfg) {
  if (!token || !token.includes('.')) return false;
  if (isSessionRevoked(token)) return false;
  const [payload, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', getSigningSecret(cfg)).update(payload).digest('base64url');
  if (sig.length !== expectedSig.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.u === cfg.username && data.exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx > -1) {
      const k = pair.slice(0, idx).trim();
      const v = decodeURIComponent(pair.slice(idx + 1).trim());
      cookies[k] = v;
    }
  });
  return cookies;
}

function isAdminAuthenticated(req) {
  const cfg = getConfig();
  const cookies = parseCookies(req);
  return verifySessionToken(cookies.filemaster_session, cfg);
}

/**
 * Unified security middleware:
 * 1. requireAdmin: Restricts access to authenticated administrators only
 * 2. requireApiOrAdmin: Allows authenticated admins OR requests with valid api_token
 */
function requireAdmin(req, res, next) {
  if (isAdminAuthenticated(req)) return next();
  const ban = checkIpBan(getClientIp(req));
  if (ban.banned) return res.status(403).json({error:`Your IP is banned. Try again in ${ban.hoursLeft} hours.`});
  return res.status(401).json({error:'Unauthorized: invalid or expired session'});
}

function requireApiOrAdmin(req, res, next) {
  if (isAdminAuthenticated(req)) return next();
  const ip = getClientIp(req);
  const ban = checkIpBan(ip);
  if (ban.banned) {
    return res.status(403).json({ error: `Your IP is currently banned.` });
  }
  const cfg = getConfig();
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
  // Only accept token via Authorization header or X-API-Token header (reject query params to prevent token leakage in access logs)
  const token = bearerToken || req.headers['x-api-token'];

  if (cfg.api_token && typeof token === 'string' && token.length === cfg.api_token.length) {
    if (crypto.timingSafeEqual(Buffer.from(token), Buffer.from(cfg.api_token))) {
      return next();
    }
  }

  if (typeof token === 'string' && token.length > 0) recordLoginFailure(ip);
  return res.status(401).json({ error: 'Unauthorized: invalid API token or credentials' });
}

/**
 * Sliding-window per-IP rate limiter middleware.
 */
function createRateLimiter({ windowMs = 60 * 1000, max = 30, message = 'Too many requests, please slow down.' } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const effectiveMax = typeof max === 'function' ? max(req) : max;
    if (typeof effectiveMax === 'number' && effectiveMax <= 0) return next();
    const ip = getClientIp(req);
    const now = Date.now();
    const record = hits.get(ip) || [];
    const recent = record.filter((ts) => now - ts < windowMs);
    if (recent.length >= effectiveMax) {
      hits.set(ip, recent);
      const retryAfter = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
      res.setHeader?.('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message, retryAfter });
    }
    recent.push(now);
    hits.set(ip, recent);
    // Periodic map cleanup
    if (hits.size > 1000) {
      for (const [k, v] of hits.entries()) {
        if (v.every((ts) => now - ts >= windowMs)) hits.delete(k);
      }
    }
    next();
  };
}

module.exports = {
  createSessionCookie,
  hashPassword,
  verifyPassword,
  getClientIp,
  checkIpBan,
  recordLoginFailure,
  clearLoginFailures,
  getSecurityStats,
  createSessionToken,
  verifySessionToken,
  revokeSessionToken,
  isAdminAuthenticated,
  requireAdmin,
  requireApiOrAdmin,
  createRateLimiter
};
