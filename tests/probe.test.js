const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { registerImageHostModule } = require('../src/modules/image-host');

test('Instant Upload Probe: /api/image/probe checks existing SHA-256 without payload', () => {
  const app = express();
  registerImageHostModule(app);

  // Find the registered GET /api/image/probe route layer
  const routeLayer = app._router.stack.find(
    (layer) => layer.route && layer.route.path === '/api/image/probe' && layer.route.methods.get
  );
  assert.ok(routeLayer, 'Route GET /api/image/probe must be registered');

  // The last handler in stack is handleProbe
  const handleProbe = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;

  // 1. Invalid SHA-256 returns 400
  let statusCode = 200;
  let jsonResult = null;
  const mockRes1 = {
    status(c) {
      statusCode = c;
      return this;
    },
    json(data) {
      jsonResult = data;
      return this;
    }
  };
  handleProbe({ query: { sha256: 'invalid' } }, mockRes1);
  assert.strictEqual(statusCode, 400, 'Invalid sha256 parameter should return 400');

  // 2. Non-existent valid 64-char hex SHA-256 returns exists: false
  const fakeSha = crypto.createHash('sha256').update('non-existent-content-12345').digest('hex');
  let mockRes2Code = 200;
  let mockRes2Json = null;
  const mockRes2 = {
    status(c) {
      mockRes2Code = c;
      return this;
    },
    json(data) {
      mockRes2Json = data;
      return this;
    }
  };
  handleProbe({ query: { sha256: fakeSha } }, mockRes2);
  assert.strictEqual(mockRes2Code, 200);
  assert.strictEqual(mockRes2Json?.exists, false, 'Non-existent sha256 should return exists: false');
});
