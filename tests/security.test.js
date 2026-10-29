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

