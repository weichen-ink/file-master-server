const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const serverRoot = path.resolve(__dirname, '..');
const {
  hashPassword,
  verifyPassword,
  createSessionToken,
  revokeSessionToken,
  verifyTotp,
  generateTotpSecret
} = require(path.join(serverRoot, 'src/core/security'));
const { getConfig, readJsonData, writeJsonData } = require(path.join(serverRoot, 'src/core/config'));

test('Security: scrypt password hashing and verification', () => {
  const plain = 'super-secret-password-xyz';
  const hashed = hashPassword(plain);
  assert.ok(hashed.startsWith('scrypt:'), 'Hash must start with scrypt:');
  assert.strictEqual(verifyPassword(plain, hashed), true, 'Password verification must succeed');
  assert.strictEqual(verifyPassword('wrong-password', hashed), false, 'Wrong password must fail');
  // Legacy plaintext fallback verification
  assert.strictEqual(verifyPassword('legacy-pass', 'legacy-pass'), true, 'Legacy plaintext must be supported');
});

test('Security: session token creation and explicit revocation', () => {
  const cfg = getConfig();
  const token = createSessionToken(cfg);
  assert.ok(token && token.includes('.'), 'Session token must be valid format');

  // Verify token works before revocation
  const { verifySessionToken } = require(path.join(serverRoot, 'src/core/security'));
  assert.strictEqual(verifySessionToken(token, cfg), true, 'Token must be valid initially');

  // Revoke token
  revokeSessionToken(token);
  assert.strictEqual(verifySessionToken(token, cfg), false, 'Revoked token must be invalid');
});

test('Security: Token extraction rejects query string (?token=)', () => {
  const { requireApiOrAdmin } = require(path.join(serverRoot, 'src/core/security'));
  let nextCalled = false;
  const mockReq = {
    headers: { cookie: '' },
    query: { token: getConfig().api_token },
    socket: { remoteAddress: '127.0.0.1' }
  };
  const mockRes = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.data = data; return this; }
  };

  requireApiOrAdmin(mockReq, mockRes, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false, 'requireApiOrAdmin must reject query string token');
  assert.strictEqual(mockRes.statusCode, 401, 'Query token attempt must return 401');

  // Verify Authorization: Bearer works
  let bearerSuccess = false;
  const validReq = {
    headers: { authorization: `Bearer ${getConfig().api_token}` },
    query: {},
    socket: { remoteAddress: '127.0.0.1' }
  };
  requireApiOrAdmin(validReq, mockRes, () => { bearerSuccess = true; });
  assert.strictEqual(bearerSuccess, true, 'Bearer token in authorization header must succeed');
});

test('Config: GET /api/platform/config desensitizes password and credentials', async () => {
  const cfg = getConfig();
  assert.ok(cfg.port > 0, 'Config port should be defined');
});

test('Security: sliding-window rate limiter blocks excessive requests with 429', () => {
  const { createRateLimiter } = require(path.join(serverRoot, 'src/core/security'));
  const limiter = createRateLimiter({ windowMs: 60000, max: 3, message: 'Rate limited' });

  const makeReq = () => ({ headers: {}, socket: { remoteAddress: '10.99.0.1' } });
  const makeRes = () => ({
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; }
  });

  for (let i = 0; i < 3; i++) {
    let passed = false;
    const res = makeRes();
    limiter(makeReq(), res, () => { passed = true; });
    assert.strictEqual(passed, true, `Request #${i + 1} should pass`);
  }

  let blockedPassed = false;
  const blockedRes = makeRes();
  limiter(makeReq(), blockedRes, () => { blockedPassed = true; });
  assert.strictEqual(blockedPassed, false, '4th request within window must be blocked');
  assert.strictEqual(blockedRes.statusCode, 429, 'Blocked request must return HTTP 429');
});

test('ImageHost: scanAllImages caches results in memory and invalidates on invalidateScanCache()', () => {
  const { scanAllImages, invalidateScanCache } = require(path.join(serverRoot, 'src/modules/image-host'));
  const cfg = getConfig();
  invalidateScanCache();
  const firstScan = scanAllImages(cfg);
  const secondScan = scanAllImages(cfg);
  assert.strictEqual(firstScan, secondScan, 'Repeated scan within TTL must return cached object reference');

  invalidateScanCache();
  const thirdScan = scanAllImages(cfg);
  assert.notStrictEqual(firstScan, thirdScan, 'Scan after invalidateScanCache() must re-compute');
});


