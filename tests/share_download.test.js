const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');

assert.equal(process.env.FILE_MASTER_TEST_ROOT, fs.realpathSync(path.resolve(__dirname, '..')),
  'Run npm test: download tests require an isolated project');

test('Share downloads enforce quotas and finish HTTP error responses', async (t) => {
  const config = require('../src/core/config');
  config.initializeConfigFromSetup({ username: 'test', password: 'test-only-password' });
  const shares = require('../src/modules/share');
  const dir = path.join(config.STORAGE_DIR, 'raw', '2026', '11');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'quota.txt'), '0123456789');
  const app = express();
  shares.registerShareModule(app);
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status || 500).end(error.message);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    shares.flushSharesMap();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const create = (maxDownloads = 1, filename = 'quota.txt') => shares.createShareRecord({
    year: '2026', month: '11', filename, maxDownloads
  });
  const count = s => shares.getSharesMap()[s.id].downloads;
  const get = async (s, options = {}) => {
    const res = await fetch(`${base}/s/${s.id}`, { signal: AbortSignal.timeout(3000), ...options });
    return { status: res.status, headers: res.headers, body: await res.text() };
  };
  // Native HTTP leaves cache validators intact; fetch adds Cache-Control: no-cache.
  const conditionalGet = (s, headers) => new Promise((resolve, reject) => {
    const req = http.get(`${base}/s/${s.id}`, { headers }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
      res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('Conditional response did not finish')));
    req.on('error', reject);
  });

  await t.test('Every limited Range request returns one full file; HEAD is free', async () => {
    for (const range of ['bytes=-10', 'bytes=1-3', 'bytes=0-3', 'bytes=999-']) {
      const s = create();
      assert.equal((await get(s, { method: 'HEAD' })).status, 200);
      assert.equal(count(s), 0);
      const res = await get(s, { headers: { Range: range } });
      assert.equal(res.status, 200, range);
      assert.equal(res.body, '0123456789');
      assert.equal(res.headers.get('accept-ranges'), null);
      assert.equal(res.headers.get('cache-control'), 'private, no-store');
      assert.equal(count(s), 1);
      assert.equal((await get(s)).status, 410);
    }
  });

  await t.test('Unlimited shares preserve Range, and 416/412 complete without charging', async () => {
    const s = create(0);
    const partial = await get(s, { headers: { Range: 'bytes=4-9' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.body, '456789');
    assert.equal(count(s), 1);
    assert.equal((await get(s, { headers: { Range: 'bytes=999-' } })).status, 416);
    assert.equal((await get(s, { headers: { 'If-Unmodified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' } })).status, 412);
    assert.equal(count(s), 1);
    assert.equal((await get(s)).status, 200);
    assert.equal(count(s), 2);
  });

  await t.test('Limited conditional 304 and 412 release the reserved download', async () => {
    const s = create();
    const head = await get(s, { method: 'HEAD' });
    assert.ok(head.headers.get('etag'));
    assert.equal(await conditionalGet(s, { 'If-None-Match': head.headers.get('etag') }), 304);
    assert.equal(count(s), 0);
    assert.equal((await get(s, { headers: { 'If-Unmodified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' } })).status, 412);
    assert.equal(count(s), 0);
    assert.equal((await get(s)).status, 200);
  });

  await t.test('Concurrent requests cannot overspend the final download', async () => {
    const s = create();
    const results = await Promise.all(Array.from({ length: 6 }, () => get(s)));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 410, 410, 410, 410, 410]);
    assert.equal(count(s), 1);
  });

  await t.test('Aborting a real transfer refunds quota and allows retry', async () => {
    fs.writeFileSync(path.join(dir, 'large.txt'), Buffer.alloc(32 * 1024 * 1024, 65));
    const s = create(1, 'large.txt');
    await new Promise((resolve, reject) => {
      const req = http.get(`${base}/s/${s.id}`, res => {
        res.once('data', () => { res.destroy(); resolve(); });
        res.on('error', () => {});
      });
      req.setTimeout(3000, () => req.destroy(new Error('Transfer did not start')));
      req.on('error', reject);
    });
    const deadline = Date.now() + 3000;
    while (count(s) !== 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(count(s), 0);
    const retry = await get(s);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.length, 32 * 1024 * 1024);
    assert.equal(count(s), 1);
  });

  await t.test('Failed quota persistence fails closed and permits a later retry', async () => {
    const s = create();
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === path.join(config.DATA_DIR, 'shares.json')) throw new Error('simulated write failure');
      return rename(from, to);
    };
    try { assert.equal((await get(s)).status, 500); }
    finally { fs.renameSync = rename; }
    assert.equal(count(s), 0);
    assert.equal((await get(s)).status, 200);
  });
});
