const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const root = fs.realpathSync(path.resolve(__dirname, '..'));
assert.equal(process.env.FILE_MASTER_TEST_ROOT, root, 'Run npm test with isolated storage');
const config = require('../src/core/config');
const { RAW_DIR } = require('../src/modules/image-host/asset-paths');
const { updateShaIndex } = require('../src/modules/image-host/sha-index');
const { trashAsset, listTrashEntries } = require('../src/modules/image-host/trash');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('HTTP replacement binds identity and fresh bytes; Web restore forwards its confirmed plan', async t => {
  config.initializeConfigFromSetup({ username: 'audit', password: 'test-only-password', api_token: 'test-token', base_url: 'http://127.0.0.1', watermark_enable: false });
  const { app } = require('../src/server');
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`, authorization = { Authorization: 'Bearer test-token' };
  const now = new Date(), year = String(now.getFullYear()), month = String(now.getMonth() + 1).padStart(2, '0');
  const request = async (url, options = {}) => {
    const { json, ...fetchOptions } = options;
    const res = await fetch(base + url, { ...fetchOptions, headers: { ...authorization, ...options.headers,
      ...(json ? { 'Content-Type': 'application/json' } : {}) }, ...(json ? { body: JSON.stringify(json) } : {}) });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status, details: data });
    return data;
  };
  const { createApi } = await import('../src/public/assets/admin/api/index.mjs');
  const api = createApi(request);
  function seed(y, m, filename, value) {
    const file = path.join(RAW_DIR, y, m, filename);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
    const stat = fs.statSync(file);
    updateShaIndex(hash(value), { year: y, month: m, filename, size: stat.size, mtimeMs: stat.mtimeMs });
    return file;
  }
  const check = async filename => (await api.uploadCheck([{ filename }])).results[0].conflict;
  async function upload(filename, value, target) {
    const body = new FormData(); body.append('file', new Blob([value]), filename);
    const res = await fetch(base + '/api/image/upload', { method: 'POST', body, headers: {
      ...authorization, 'X-File-Name': encodeURIComponent(filename), 'X-Conflict-Strategy': 'replace',
      ...(target ? { 'X-Conflict-Target-Year': target.year, 'X-Conflict-Target-Month': target.month,
        'X-Conflict-Target-Filename': encodeURIComponent(target.filename), 'X-Conflict-Target-Sha256': target.sha256 } : {})
    } });
    return { status: res.status, data: await res.json() };
  }
  await t.test('Missing targets and targets deleted after confirmation never replace another bucket', async () => {
    seed(year, month, 'stale.txt', 'shown');
    const older = seed('2020', '01', 'stale.txt', 'not-shown');
    assert.equal((await upload('stale.txt', 'incoming')).status, 409);
    const target = await check('stale.txt');
    await trashAsset(year, month, 'stale.txt');
    const result = await upload('stale.txt', 'incoming', target);
    assert.equal(result.status, 409);
    assert.equal(result.data.code, 'CONFLICT_TARGET_CHANGED');
    assert.equal(fs.readFileSync(older, 'utf8'), 'not-shown');
  });
  await t.test('External changes are detected even with unchanged cached stat metadata', async () => {
    const file = seed(year, month, 'changed.txt', 'before');
    const target = await check('changed.txt'), stat = fs.statSync(file);
    fs.writeFileSync(file, 'after!'); fs.utimesSync(file, stat.atime, stat.mtime);
    const result = await upload('changed.txt', 'incoming', target);
    assert.equal(result.status, 409);
    assert.equal(result.data.conflict.sha256, hash('after!'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'after!');
  });
  await t.test('Identical incoming bytes elsewhere do not redirect an explicitly confirmed replacement', async () => {
    const targetFile = seed('2020', '02', 'confirmed.txt', 'original');
    seed(year, month, 'other-name.txt', 'already-stored');
    const result = await upload('confirmed.txt', 'already-stored', await check('confirmed.txt'));
    assert.equal(result.status, 200);
    assert.equal(result.data.rawUrl.includes('/2020/02/confirmed.txt'), true);
    assert.equal(fs.readFileSync(targetFile, 'utf8'), 'already-stored');
    const raw = await fetch(`${base}/raw/2020/02/confirmed.txt?raw=1`);
    assert.equal(raw.status, 200); assert.equal(await raw.text(), 'already-stored');
  });
  await t.test('Restore rename never grants overwrite permission for another filename', async () => {
    seed(year, month, 'restoring.txt', 'trash-content');
    await trashAsset(year, month, 'restoring.txt');
    const item = listTrashEntries().find(i => i.filename === 'restoring.txt');
    const original = seed(year, month, 'restoring.txt', 'original-online');
    const other = seed(year, month, 'different.txt', 'other-online');
    const target = (await api.uploadCheck([{ filename: 'different.txt', year, month }])).results[0].conflict;
    await assert.rejects(api.restoreTrash(item.id, { conflictStrategy: 'replace', filename: 'different.txt', conflictTarget: target }), error => {
      assert.equal(error.status, 409);
      assert.equal(error.details.code, 'CONFLICT_TARGET_CHANGED');
      assert.equal(error.details.conflict.filename, 'restoring.txt');
      return true;
    });
    await assert.rejects(api.restoreTrash(item.id, { conflictStrategy: 'rename', filename: 'different.txt' }), error => error.status === 409);
    assert.equal(fs.readFileSync(original, 'utf8'), 'original-online');
    assert.equal(fs.readFileSync(other, 'utf8'), 'other-online');
    const confirmed = (await api.uploadCheck([{ filename: 'restoring.txt', year, month }])).results[0].conflict;
    const restored = await api.restoreTrash(item.id, { conflictStrategy: 'replace', filename: 'restoring.txt', conflictTarget: confirmed });
    assert.equal(restored.filename, 'restoring.txt');
    assert.equal(fs.readFileSync(original, 'utf8'), 'trash-content');
    assert.equal(fs.readFileSync(other, 'utf8'), 'other-online');
    const backup = listTrashEntries().find(i => i.filename === 'restoring.txt');
    const renamed = await api.restoreTrash(backup.id, { conflictStrategy: 'rename', filename: 'renamed.txt' });
    assert.equal(renamed.filename, 'renamed.txt');
    assert.equal(fs.readFileSync(path.join(RAW_DIR, year, month, 'renamed.txt'), 'utf8'), 'original-online');
  });
  await t.test('Web upload API sends the complete confirmed target to the real HTTP endpoint', async () => {
    const file = seed('2020', '04', '网页.txt', 'web-original');
    const target = await check('网页.txt');
    const result = await api.upload(new File(['web-replacement'], '网页.txt'), new AbortController().signal, {
      conflictStrategy: 'replace', conflictTargetYear: target.year, conflictTargetMonth: target.month,
      conflictTargetFilename: target.filename, conflictTargetSha256: target.sha256,
    });
    assert.equal(result.replaced, true);
    assert.equal(result.year, '2020'); assert.equal(result.month, '04');
    assert.equal(result.filename, '网页.txt');
    assert.equal(fs.readFileSync(file, 'utf8'), 'web-replacement');
  });
});
