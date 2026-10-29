const crypto = require('node:crypto');
const { getConfig, readJsonData, writeJsonData } = require('./config');

// In-memory IP brute-force protection map: ip -> { count, bannedUntil, lastAttempt }
const ipFailures = new Map();
const BAN_DURATION_MS = 24 * 60 * 60 * 1000; // 24-hour lockout
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30-day session retention

// Load persisted bans from data/ip_bans.json on server boot
function loadPersistedBans() {
  try {
    const data = readJsonData('ip_bans', {});
    const now = Date.now();
    for (const [ip, item] of Object.entries(data)) {
      if (item && item.bannedUntil && item.bannedUntil > now) {
        ipFailures.set(ip, item);
      }
    }
  } catch {}
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
    writeJsonData('ip_bans', data);
  } catch {}
}

loadPersistedBans();

// Persist instance salt in data/security_meta.json so hot updates & restarts keep active sessions alive,
// while changing username, password, or admin_path still immediately invalidates older cookies.
function loadOrCreateInstanceSalt() {
  try {
    const meta = readJsonData('security_meta', null);
    if (meta && typeof meta.instanceSalt === 'string' && meta.instanceSalt.length >= 16) {
      return meta.instanceSalt;
    }
    const newSalt = crypto.randomBytes(16).toString('hex');
    writeJsonData('security_meta', { instanceSalt: newSalt, createdAt: Date.now() });
    return newSalt;
  } catch {
    return 'filemaster-default-instance-salt';
  }
}

const SERVER_BOOT_SALT = loadOrCreateInstanceSalt();

function getSigningSecret(cfg) {
  return crypto
    .createHash('sha256')
    .update(`${cfg.username}:${cfg.password}:${cfg.admin_path}:${SERVER_BOOT_SALT}`)
    .digest();
}

function getClientIp(req) {
  if (req.ip) return req.ip;
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  const realIp = req.headers['x-real-ip'];
  if (realIp) return String(realIp).trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Checks whether an IP address is currently banned.
 */
function checkIpBan(ip) {
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

/**
 * Records a failed authentication attempt; triggers a 24h ban if threshold is exceeded.
 */
function recordLoginFailure(ip) {
  const max = getConfig().max_login_attempts;
  const record = ipFailures.get(ip) || { count: 0, bannedUntil: 0 };
  record.count += 1;
  record.lastAttempt = Date.now();

  if (record.count >= max) {
    record.bannedUntil = Date.now() + BAN_DURATION_MS;
    console.warn(`[Security] IP ${ip} failed ${record.count} consecutive attempts; banned for 24 hours`);
    ipFailures.set(ip, record);
    syncPersistedBans();
  } else {
    ipFailures.set(ip, record);
  }
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
 * Base32 encoding/decoding and standard RFC 6238 TOTP (6-digit Authenticator code).
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateTotpSecret(length = 16) {
  const bytes = crypto.randomBytes(length);
  let secret = '';
  for (let i = 0; i < length; i++) {
    secret += BASE32_ALPHABET[bytes[i] % 32];
  }
  return secret;
}

function base32Decode(base32Str) {
  const clean = String(base32Str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const output = [];
  for (let i = 0; i < clean.length; i++) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(clean[i]);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateTotpCode(secret, stepOffset = 0) {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30) + stepOffset;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    1000000;
  return String(code).padStart(6, '0');
}

function verifyTotp(secret, inputCode) {
  if (!secret) return true; // Skip 2FA if totp_secret is empty
  const cleanCode = String(inputCode || '').trim();
  if (!/^\d{6}$/.test(cleanCode)) return false;
  // Allow a +/- 1 step window (+/- 30s) to account for slight clock drift
  for (const offset of [-1, 0, 1]) {
    if (generateTotpCode(secret, offset) === cleanCode) return true;
  }
  return false;
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

function verifySessionToken(token, cfg) {
  if (!token || !token.includes('.')) return false;
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
  const ip = getClientIp(req);
  const ban = checkIpBan(ip);
  if (ban.banned) {
    return res.status(403).json({ error: `Your IP is banned. Try again in ${ban.hoursLeft} hours.` });
  }
  if (!isAdminAuthenticated(req)) {
    return res.status(401).json({ error: 'Unauthorized: invalid or expired session' });
  }
  next();
}

function requireApiOrAdmin(req, res, next) {
  const ip = getClientIp(req);
  const ban = checkIpBan(ip);
  if (ban.banned) {
    return res.status(403).json({ error: `Your IP is currently banned.` });
  }
  if (isAdminAuthenticated(req)) {
    return next();
  }

  const cfg = getConfig();
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
  const token = bearerToken || req.headers['x-api-token'] || req.query.token;

  if (cfg.api_token && typeof token === 'string' && token.length === cfg.api_token.length) {
    if (crypto.timingSafeEqual(Buffer.from(token), Buffer.from(cfg.api_token))) {
      return next();
    }
  }

  recordLoginFailure(ip);
  return res.status(401).json({ error: 'Unauthorized: invalid API token or credentials' });
}

module.exports = {
  getClientIp,
  checkIpBan,
  recordLoginFailure,
  clearLoginFailures,
  getSecurityStats,
  generateTotpSecret,
  verifyTotp,
  createSessionToken,
  isAdminAuthenticated,
  requireAdmin,
  requireApiOrAdmin
};
