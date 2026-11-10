const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const sharp = require('sharp');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
assert.equal(process.env.FILE_MASTER_TEST_ROOT, root, 'Run npm test: HTTP tests require an isolated project');

// Exercise real router order, middleware, multipart parsing, cookies and response bytes.
test('HTTP functional regression across platform, assets, shares and recovery', async (t) => {
  const { app } = require('../src/server');
  const { SETUP_TOKEN } = require('../src/core/security');
  const { CONFIG_PATH, STORAGE_DIR, getConfig } = require('../src/core/config');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = 'functional-test-api-token';
  const credentials = { username: 'tester', password: 'test-only-password' };
  let cookie, asset, original, tiffAsset;
  const api = { Authorization: `Bearer ${token}` };
  // Independent RFC 6238 code generator; do not reuse the implementation under test.
  const totp = (secret) => {
    const bits = [...secret].map((ch) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch).toString(2).padStart(5, '0')).join('');
    const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const hash = crypto.createHmac('sha1', key).update(counter).digest();
    return String((hash.readUInt32BE(hash.at(-1) & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
  };
  const admin = () => ({ Cookie: cookie, Origin: base });
  const call = async (url, { json, headers, ...options } = {}) => {
    const res = await fetch(new URL(url, base), { redirect: 'manual', signal: AbortSignal.timeout(10000),
      ...options, headers: { ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buffer, text: buffer.toString(),
      data: res.headers.get('content-type')?.includes('application/json') && buffer.length ? JSON.parse(buffer) : null };
  };
  const saveCookie = (result) => { cookie = result.headers.get('set-cookie')?.split(';')[0] || cookie; };
  const patch = async (value) => {
    const result = await call('/api/platform/config', { method: 'PUT', headers: admin(), json: { mode: 'form', patch: value } });
    assert.equal(result.status, 200, result.text); saveCookie(result); return result;
  };
  const upload = async (name, bytes, route = '/api/image/upload') => {
    const form = new FormData(); form.append('file', new Blob([bytes]), name);
    return call(route, { method: 'POST', headers: { ...api, 'X-File-Name': encodeURIComponent(name) }, body: form });
  };
  const assetPath = (item) => path.join(STORAGE_DIR, 'raw', item.year, item.month, item.filename);

  await t.test('First-run wizard initializes credentials and locks after setup', async () => {
    assert.equal((await call('/')).headers.get('location'), '/setup');
    assert.equal((await call('/setup')).status, 200);
    const status = (await call('/api/platform/status')).data;
    assert.equal(status.needsSetup, true); assert.equal(status.endpoints, null);
    assert.equal((await call('/api/platform/setup-defaults')).status, 200);
    assert.equal((await call('/api/platform/setup', { method: 'POST', json: { ...credentials, password: '' } })).status, 500);
    const created = await call('/api/platform/setup', { method: 'POST',
      json: { ...credentials, base_url: base, admin_path: 'test-admin', api_token: token, watermark_enable: false } });
    assert.equal(created.status, 200, created.text); saveCookie(created);
    assert.match(getConfig().password, /^scrypt:/);
    assert.equal((await call('/api/platform/setup-defaults')).status, 403);
    assert.equal((await call('/setup')).headers.get('location'), '/test-admin');
    await patch({ max_login_attempts: 100, image_host: { max_width: 256, watermark_min_width: 10 } });
  });

  await t.test('Login, session cookies, API-token boundaries and CSRF reject invalid access', async () => {
    assert.equal((await call('/api/platform/config')).status, 401);
    assert.equal((await call('/api/modules/image-host/list')).status, 401);
    assert.equal((await call(`/api/modules/image-host/list?token=${token}`)).status, 401);
    assert.equal((await call('/api/platform/config', { headers: api })).status, 401, 'API tokens do not grant administrator access');
    const badLogin = await call('/api/platform/login', { method: 'POST', json: { ...credentials, password: 'wrong' } });
    assert.equal(badLogin.status, 401);
    const loggedIn = await call('/api/platform/login', { method: 'POST', json: credentials });
    assert.equal(loggedIn.status, 200); assert.match(loggedIn.headers.get('set-cookie'), /HttpOnly/); saveCookie(loggedIn);
    const status = await call('/api/platform/status', { headers: admin() });
    assert.equal(status.data.storageHealth.atomicUploads, true);
    assert.equal((await call('/api/platform/config', { method: 'PUT', headers: { Cookie: cookie }, json: { patch: {} } })).status, 403);
    assert.equal((await call('/api/platform/config', { method: 'PUT', headers: { ...admin(), Origin: 'https://other.invalid' }, json: { patch: {} } })).status, 403);
    assert.equal((await call('/test-admin')).status, 200);
    assert.equal((await call('/assets/console.js')).status, 200);
  });

  await t.test('Form/raw configuration preserves secrets and rejects malformed input without writes', async () => {
    const redacted = await call('/api/platform/config', { headers: admin() });
    assert.ok(!redacted.text.includes(token)); assert.ok(!redacted.text.includes('scrypt:'));
    const revealed = await call('/api/platform/config?reveal=1', { headers: admin() });
    assert.equal(revealed.data.config.api_token, token);
    const before = fs.readFileSync(CONFIG_PATH, 'utf8');
    const bad = await call('/api/platform/config', { method: 'PUT', headers: admin(), json: { mode: 'raw', rawYaml: 'image_host: []' } });
    assert.equal(bad.status, 400); assert.equal(fs.readFileSync(CONFIG_PATH, 'utf8'), before);
    const raw = await call('/api/platform/config', { method: 'PUT', headers: admin(),
      json: { mode: 'raw', rawYaml: redacted.data.rawYaml.replace('FileMaster Server', 'Functional Test') } });
    assert.equal(raw.status, 200, raw.text); saveCookie(raw);
    assert.equal(getConfig().api_token, token);
    assert.equal((await call('/api/platform/login', { method: 'POST', json: credentials })).status, 200);
  });

  await t.test('Real multipart uploads validate, preserve Unicode, deduplicate and disambiguate collisions', async () => {
    original = await sharp({ create: { width: 512, height: 384, channels: 3, background: '#345678' } }).png().toBuffer();
    assert.equal((await upload('danger.exe', original)).status, 400);
    assert.equal((await call('/api/image/upload', { method: 'POST', headers: api })).status, 400);
    const saved = await upload('中文 图片.png', original); assert.equal(saved.status, 200, saved.text); asset = saved.data;
    assert.equal(asset.sha256, crypto.createHash('sha256').update(original).digest('hex'));
    assert.match(asset.filename, /中文/);
    const repeated = await upload('copy.png', original, '/api/modules/image-host/upload');
    assert.equal(repeated.data.deduplicated, true); assert.equal(repeated.data.filename, asset.filename);
    const different = await sharp({ create: { width: 512, height: 384, channels: 3, background: '#987654' } }).png().toBuffer();
    const collision = await upload('中文 图片.png', different);
    assert.equal(collision.status, 200); assert.notEqual(collision.data.filename, asset.filename);
    assert.deepEqual(fs.readFileSync(assetPath(asset)), original);
    const hits = await Promise.all(Array.from({ length: 6 }, () => upload('parallel.png', original)));
    assert.ok(hits.every((hit) => hit.data.deduplicated));
    const probe = await call(`/api/image/probe?sha256=${asset.sha256}`, { headers: api });
    assert.equal(probe.data.exists, true); assert.equal(probe.data.rawUrl, asset.rawUrl);
    assert.equal((await call('/api/image/probe?sha256=bad', { headers: api })).status, 400);
  });

  await t.test('Original bytes, HEAD, thumbnails, WebP variants and TIFF previews are valid', async () => {
    const raw = await call(asset.rawUrl); assert.equal(raw.status, 200); assert.deepEqual(raw.buffer, original);
    const download = await call(asset.rawUrl + '?download=1'); assert.deepEqual(download.buffer, original);
    const thumb = await call(asset.rawUrl + '?thumbnail=1');
    assert.equal(thumb.status, 200, thumb.text); assert.equal((await sharp(thumb.buffer).metadata()).format, 'webp');
    const head = await call(asset.pubUrl, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.buffer.length, 0);
    for (const wm of ['', '?wm=image', '?wm=text', '?wm=tile']) {
      const response = await call(asset.pubUrl + wm); assert.equal(response.status, 200, response.text);
      const info = await sharp(response.buffer).metadata(); assert.equal(info.format, 'webp'); assert.equal(info.width, 256);
    }
    const tiff = await sharp(original).tiff().toBuffer();
    tiffAsset = (await upload('camera.tiff', tiff)).data;
    const preview = await call(tiffAsset.rawUrl); assert.equal(preview.status, 200);
    assert.equal((await sharp(preview.buffer).metadata()).format, 'jpeg');
    assert.deepEqual((await call(tiffAsset.rawUrl + '?raw=1')).buffer, tiff);
    const form = new FormData(); form.append('file', new Blob([tiff]), 'camera.tiff');
    const localPreview = await call('/api/image/preview-transcode', { method: 'POST', headers: api, body: form });
    assert.equal(localPreview.status, 200); assert.equal((await sharp(localPreview.buffer).metadata()).format, 'jpeg');
  });

  await t.test('Shares serve exact bytes, enforce quotas/expiry and can be revoked', async () => {
    const create = async (options) => {
      const result = await call('/api/modules/share/create', { method: 'POST', headers: api, json: { ...asset, ...options } });
      assert.equal(result.status, 200, result.text); return result.data.share;
    };
    const share = await create({ maxDownloads: 1 });
    assert.equal((await call(share.shareUrl, { method: 'HEAD' })).status, 200);
    const listing = (await call('/api/modules/share/list', { headers: api })).data.shares;
    assert.equal(listing.find((item) => item.id === share.id).downloads, 0, 'HEAD is metadata inspection, not a file download');
    assert.deepEqual((await call(share.shareUrl)).buffer, original);
    assert.equal((await call(share.shareUrl)).status, 410);
    const expiring = await create({ expiresInHours: 0.0000001 });
    assert.equal((await call(expiring.shareUrl)).status, 410);
    const revoked = await create({ maxDownloads: 0 });
    assert.equal((await call(`/api/modules/share/${revoked.id}`, { method: 'DELETE', headers: api })).status, 200);
    assert.equal((await call(revoked.shareUrl)).status, 404);
  });

  await t.test('Config changes invalidate cache, toggle optimization and update live paths', async () => {
    const cacheRoot = path.join(STORAGE_DIR, 'cache', asset.year, asset.month);
    assert.ok(fs.readdirSync(cacheRoot).length > 0);
    await patch({ image_host: { webp_quality: 70 } });
    assert.equal(fs.existsSync(cacheRoot), false);
    await patch({ image_host: { enable_optimization: false } });
    assert.equal((await call(asset.pubUrl)).status, 404); assert.equal((await call(asset.rawUrl)).status, 200);
    await patch({ image_host: { enable_optimization: true, pub_secret_path: 'published', raw_secret_path: 'originals' } });
    const latest = (await call(`/api/image/probe?sha256=${asset.sha256}`, { headers: api })).data;
    assert.match(latest.rawUrl, /\/originals\//); assert.match(latest.pubUrl, /\/published\//);
    assert.equal((await call(latest.rawUrl)).status, 200); assert.equal((await call(latest.pubUrl)).status, 200);
    await patch({ image_host: { pub_secret_path: 'pub', raw_secret_path: 'raw' } });
  });

  await t.test('Integrity jobs detect tampering and locks protect originals before trash deletion', async () => {
    const runIntegrity = async () => {
      let result = await call('/api/modules/image-host/integrity', { method: 'POST', headers: api });
      assert.equal(result.status, 202);
      for (let i = 0; i < 300 && result.data.state === 'running'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        result = await call('/api/modules/image-host/integrity', { headers: api });
      }
      assert.equal(result.data.state, 'completed'); return result.data;
    };
    const clean = await runIntegrity(); assert.equal(clean.issues.length, 0);
    fs.writeFileSync(assetPath(asset), 'tampered');
    assert.ok((await runIntegrity()).issues.some((issue) => issue.type === 'mismatch'));
    fs.writeFileSync(assetPath(asset), original);
    const lock = (locked) => call('/api/modules/image-host/lock', { method: 'POST', headers: api, json: { ...asset, locked } });
    assert.equal((await lock(true)).status, 200);
    const route = `/api/modules/image-host/item/${asset.year}/${asset.month}/${encodeURIComponent(asset.filename)}`;
    assert.equal((await call(route, { method: 'DELETE', headers: api })).status, 403);
    assert.ok(fs.existsSync(assetPath(asset)));
    assert.equal((await lock(false)).status, 200);
    assert.equal((await call(route, { method: 'DELETE', headers: api })).status, 200);
    assert.equal(fs.existsSync(assetPath(asset)), false);
    const findFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? findFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    assert.ok(findFiles(path.join(STORAGE_DIR, 'trash')).some((file) => fs.readFileSync(file).equals(original)));
    assert.equal((await call(`/api/image/probe?sha256=${asset.sha256}`, { headers: api })).data.exists, false);
  });

  await t.test('Config/full backups include config, index and originals, then remove temporary archives', async () => {
    for (const scope of ['config', 'full']) {
      const backup = await call(`/api/platform/backup/download?scope=${scope}`, { headers: admin() });
      assert.equal(backup.status, 200, backup.text.slice(0, 200));
      const archive = path.join(root, `${scope}-test.tar.gz`); fs.writeFileSync(archive, backup.buffer);
      const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
      assert.match(names, /config.yaml/); assert.match(names, /data\/sha_index.json/);
      assert.equal(names.includes('storage/raw/'), scope === 'full');
      if (scope === 'full') assert.ok(names.includes(tiffAsset.filename));
      fs.unlinkSync(archive);
    }
  });

  await t.test('2FA config survives redacted editing and rejects passwords without a valid TOTP', async () => {
    const generated = await call('/api/platform/totp-generate', { method: 'POST', headers: admin() });
    assert.equal(generated.status, 200); assert.match(generated.data.otpauthUri, /^otpauth:/);
    const secret = generated.data.secret;
    await patch({ totp_secret: secret });
    const redacted = (await call('/api/platform/config', { headers: admin() })).data;
    const saved = await call('/api/platform/config', { method: 'PUT', headers: admin(), json: { mode: 'raw', rawYaml: redacted.rawYaml } });
    assert.equal(saved.status, 200); saveCookie(saved); assert.equal(getConfig().totp_secret, secret);
    assert.equal((await call('/api/platform/login', { method: 'POST', json: credentials })).status, 401);
    const valid = await call('/api/platform/login', { method: 'POST', json: { ...credentials, totpCode: totp(secret) } });
    assert.equal(valid.status, 200); saveCookie(valid);
    await patch({ clear_totp: true }); assert.equal(getConfig().totp_secret, '');
  });

  await t.test('Metrics/update status are authenticated and logout revokes its session', async () => {
    const metrics = await call('/api/platform/metrics', { headers: admin() });
    assert.equal(metrics.status, 200, metrics.text); assert.equal(metrics.data.site.endpoints.apiToken, '');
    assert.ok(metrics.data.site.storage.imageCount > 0);
    const status = await call('/api/platform/update/status', { headers: admin() });
    assert.equal(status.status, 200); assert.equal(status.data.dependenciesPending, false);
    await patch({ hot_update: false });
    assert.equal((await call('/api/platform/update/pull', { method: 'POST', headers: admin(), json: {} })).status, 403);
    const exited = await call('/api/platform/logout', { method: 'POST', headers: admin(), json: {} });
    assert.equal(exited.status, 200);
    assert.equal((await call('/api/platform/config', { headers: admin() })).status, 401);
    const actions = fs.readFileSync(path.join(root, 'data/audit.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).action);
    for (const action of ['initial_setup', 'upload', 'share_create', 'backup_export', 'lock', 'delete_to_trash']) assert.ok(actions.includes(action), action);
    assert.equal(fs.readdirSync(path.join(STORAGE_DIR, 'tmp')).length, 0);
  });
});
