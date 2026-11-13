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
  const { CONFIG_PATH, STORAGE_DIR, getConfig } = require('../src/core/config');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = 'functional-test-api-token';
  const credentials = { username: 'tester', password: 'test-only-password' };
  let cookie, asset, original, tiffAsset;
  const api = { Authorization: `Bearer ${token}` };
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
    const contract = (await call('/api/platform/version')).data;
    assert.equal(contract.version, require('../package.json').version);
    assert.equal(contract.minPluginVersion, '1.1.0');
    assert.equal((await call('/')).headers.get('location'), '/setup');
    assert.equal((await call('/setup')).status, 200);
    const status = (await call('/api/platform/status')).data;
    assert.equal(status.needsSetup, true); assert.equal(status.endpoints, null);
    assert.equal((await call('/api/platform/setup-defaults')).status, 200);
    const badSetup = await call('/api/platform/setup', { method: 'POST', json: { ...credentials, password: '' } });
    assert.ok(badSetup.status === 400 || badSetup.status === 500, `Expected 400 or 500, got ${badSetup.status}`);
    const created = await call('/api/platform/setup', { method: 'POST',
      json: { ...credentials, base_url: base, admin_path: 'test-admin', api_token: token, watermark_enable: false } });
    assert.equal(created.status, 200, created.text); saveCookie(created);
    assert.match(getConfig().password, /^scrypt:/);
    assert.equal((await call('/api/platform/setup-defaults')).status, 403);
    assert.equal((await call('/setup')).headers.get('location'), '/');
    const landing = await call('/');
    assert.equal(landing.status, 200);
    assert.match(landing.text, /File Master/);
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
    const entry = await call('/assets/admin/app.mjs');
    assert.equal(entry.status, 200);
    assert.match(entry.headers.get('content-type'), /javascript/);
    assert.match(entry.headers.get('cache-control'), /max-age=0/);
    // Validate the actual transitive ESM graph, including relative imports and MIME.
    const visited = new Set();
    async function verifyModule(url) {
      if (visited.has(url)) return;
      visited.add(url);
      const response = await call(url);
      assert.equal(response.status, 200, url);
      assert.match(response.headers.get('content-type'), /javascript/, url);
      assert.match(response.headers.get('cache-control'), /max-age=0/, url);
      for (const [, specifier] of response.text.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
        if (specifier.startsWith('.')) await verifyModule(new URL(specifier, 'http://fixture' + url).pathname);
      }
    }
    await verifyModule('/assets/console.js');
    assert.ok(visited.size >= 10);
    assert.equal((await call('/api/platform/config/preview', {method:'POST', json:{rawYaml:''}})).status, 401);


  });

  await t.test('Anonymous probes never lock out a valid administrator; real failed tokens still lock out guesses',async()=>{
    const security=require('../src/core/security');
    await patch({max_login_attempts:3});
    try {
      for(let i=0;i<6;i++) assert.equal((await call('/api/modules/image-host/list')).status,401);
      assert.equal(security.checkIpBan('127.0.0.1').banned,false);
      for(let i=0;i<3;i++) await call('/api/modules/image-host/list',{headers:{Authorization:'Bearer invalid-token'}});
      assert.equal(security.checkIpBan('127.0.0.1').banned,true);
      assert.equal((await call('/test-admin',{headers:admin()})).status,200);
      assert.equal((await call('/api/platform/config',{headers:admin()})).status,200);
      assert.equal((await call('/api/modules/image-host/list',{headers:admin()})).status,200);
    } finally {security.clearLoginFailures('127.0.0.1');await patch({max_login_attempts:100});}
  });

  await t.test('Form/raw configuration preserves secrets and rejects malformed input without writes', async () => {
    const redacted = await call('/api/platform/config', { headers: admin() });
    assert.ok(!redacted.text.includes(token)); assert.ok(!redacted.text.includes('scrypt:'));
    const revealed = await call('/api/platform/config?reveal=1', { headers: admin() });
    assert.equal(revealed.data.config.api_token, token);
    const before = fs.readFileSync(CONFIG_PATH, 'utf8');
    const preview = await call('/api/platform/config/preview', { method: 'POST', headers: admin(), json: { rawYaml: redacted.data.rawYaml } });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.valid, true);
    assert.equal(fs.readFileSync(CONFIG_PATH, 'utf8'), before, 'YAML preview must never write configuration');
    assert.equal((await call('/api/platform/config/preview', { method: 'POST', headers: admin(), json: { rawYaml: 'image_host: []' } })).status, 400);
    const bad = await call('/api/platform/config', { method: 'PUT', headers: admin(), json: { mode: 'raw', rawYaml: 'image_host: []' } });
    assert.equal(bad.status, 400); assert.equal(fs.readFileSync(CONFIG_PATH, 'utf8'), before);
    const raw = await call('/api/platform/config', { method: 'PUT', headers: admin(),
      json: { mode: 'raw', rawYaml: redacted.data.rawYaml.replace('FileMaster Server', 'Functional Test') } });
    assert.equal(raw.status, 200, raw.text); saveCookie(raw);
    assert.equal(getConfig().api_token, token);
    assert.equal((await call('/api/platform/login', { method: 'POST', json: credentials })).status, 200);
  });

  await t.test('Real multipart uploads validate, preserve Unicode, deduplicate and reject name conflicts', async () => {
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
    assert.equal(collision.status, 409); assert.equal(collision.data.code, 'NAME_CONFLICT');
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

  await t.test('Catalog API filters and sorts before slicing pages while retaining all directory choices', async () => {
    const full=(await call('/api/modules/image-host/list',{headers:api})).data.images;
    assert.ok(full.length>=2);
    const query=new URLSearchParams({types:'image',sort:'name_asc',limit:'1',offset:'0'});
    const first=await call(`/api/modules/image-host/list?${query}`,{headers:api});
    assert.equal(first.status,200);assert.equal(first.data.images.length,1);assert.equal(first.data.totalCount,full.length);
    query.set('offset','1');
    const second=(await call(`/api/modules/image-host/list?${query}`,{headers:api})).data;
    assert.notEqual(first.data.images[0].filename,second.images[0].filename);
    assert.deepEqual(first.data.buckets,[...new Set(full.map(item=>`${item.year}/${item.month}`))].sort().reverse());
    query.set('q','camera.tiff');query.set('offset','0');
    const searched=(await call(`/api/modules/image-host/list?${query}`,{headers:api})).data;
    assert.equal(searched.totalCount,1);assert.equal(searched.images[0].filename,'camera.tiff');
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

  await t.test('Draft image preview reflects unsaved parameters without changing config, originals or caches', async () => {
    const endpoint='/api/modules/image-host/preview';
    assert.equal((await call(endpoint,{method:'POST',headers:api,json:{...asset}})).status,401);
    const beforeConfig=fs.readFileSync(CONFIG_PATH,'utf8');
    const snapshot=(dir)=>!fs.existsSync(dir)?[]:fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?snapshot(path.join(dir,entry.name)):[entry.name+':'+crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,entry.name))).digest('hex')]).sort();
    const beforeCache=snapshot(path.join(STORAGE_DIR,'cache'));
    const preview=await call(endpoint,{method:'POST',headers:admin(),json:{...asset,image_host:{enable_optimization:true,max_width:192,watermark_enable:false,webp_quality:60}}});
    assert.equal(preview.status,200,preview.text.slice(0,200));assert.equal(preview.headers.get('cache-control'),'no-store');
    assert.equal((await sharp(preview.buffer).metadata()).width,192);
    const watermarked=await call(endpoint,{method:'POST',headers:admin(),json:{...asset,image_host:{enable_optimization:true,max_width:192,watermark_enable:true,watermark_type:'text',watermark_text:'DRAFT',watermark_min_width:0,watermark_margin:0}}});
    assert.equal(watermarked.status,200,watermarked.text.slice(0,200));assert.notDeepEqual(watermarked.buffer,preview.buffer);
    assert.equal((await call(endpoint,{method:'POST',headers:admin(),json:{...asset,filename:'../config.yaml'}})).status,400);
    assert.equal((await call(endpoint,{method:'POST',headers:admin(),json:{...asset,image_host:{watermark_image:'../../outside.png'}}})).status,400);
    assert.equal(fs.readFileSync(CONFIG_PATH,'utf8'),beforeConfig);
    assert.deepEqual(fs.readFileSync(assetPath(asset)),original);
    assert.deepEqual(snapshot(path.join(STORAGE_DIR,'cache')),beforeCache);
    assert.equal(fs.readdirSync(path.join(STORAGE_DIR,'tmp')).filter(name=>name.startsWith('draft-preview-')).length,0);
    await patch({console:{card_copy_format:'markdown_webp'},backup:{frequency:'weekly',weekday:0,monthday:12,cron_expression:'0 4 * * 0'}});
    assert.equal(getConfig().console.card_copy_format,'markdown_webp');assert.equal(getConfig().backup.frequency,'weekly');assert.equal(getConfig().backup.weekday,0);
    assert.equal((await call('/api/platform/config',{method:'PUT',headers:admin(),json:{patch:{console:{card_copy_format:'invalid'}}}})).status,400);
  });

  await t.test('Trash management restores JSON bytes and original integrity baselines, rejects conflicts and authorizes authenticated plugin operations', async () => {
    const before=Buffer.from('{"trash":"original"}'),after=Buffer.from('{"trash":"modified"}');
    const saved=(await upload('回收站.json',before)).data;
    fs.writeFileSync(assetPath(saved),after);
    const endpoint=`/api/modules/image-host/item/${saved.year}/${saved.month}/${encodeURIComponent(saved.filename)}`;
    assert.equal((await call(endpoint,{method:'DELETE',headers:api})).status,200);
    assert.equal((await call('/api/modules/image-host/trash')).status,401);
    assert.equal((await call('/api/modules/image-host/trash',{headers:api})).status,200);
    let listed=await call('/api/modules/image-host/trash',{headers:admin()});assert.equal(listed.status,200);
    const item=listed.data.items.find(i=>i.filename===saved.filename);assert.ok(item);assert.ok(!('fullPath' in item));
    assert.equal((await call(`/api/modules/image-host/trash/${item.id}/preview`,{headers:api})).status,415);
    const restore=`/api/modules/image-host/trash/${item.id}/restore`;
    assert.equal((await call(restore,{method:'POST'})).status,401);
    fs.writeFileSync(assetPath(saved),'conflicting file');
    assert.equal((await call(restore,{method:'POST',headers:admin()})).status,409);
    assert.equal(fs.readFileSync(assetPath(saved),'utf8'),'conflicting file');fs.unlinkSync(assetPath(saved));
    assert.equal((await call(restore,{method:'POST',headers:api})).status,200);
    assert.deepEqual(fs.readFileSync(assetPath(saved)),after);
    const {pathToShaMap}=require('../src/modules/image-host/sha-index');
    assert.equal(pathToShaMap.get(`${saved.year}/${saved.month}/${saved.filename}`).baselineSha256,crypto.createHash('sha256').update(before).digest('hex'));
    assert.equal((await call('/api/modules/image-host/trash',{headers:admin()})).data.items.some(i=>i.id===item.id),false);
    assert.equal((await call(restore,{method:'POST',headers:admin()})).status,404);
    assert.equal((await call('/api/modules/image-host/trash/invalid',{method:'DELETE',headers:admin()})).status,400);
    await call(endpoint,{method:'DELETE',headers:api});
    listed=await call('/api/modules/image-host/trash',{headers:admin()});const second=listed.data.items.find(i=>i.filename===saved.filename);
    assert.equal((await call(`/api/modules/image-host/trash/${second.id}`,{method:'DELETE'})).status,401);
    assert.equal((await call(`/api/modules/image-host/trash/${second.id}`,{method:'DELETE',headers:api})).status,200);
    assert.equal((await call('/api/modules/image-host/trash',{headers:admin()})).data.items.some(i=>i.id===second.id),false);
  });

  await t.test('Deleted image previews require authentication and disappear after restore or permanent deletion', async () => {
    const image = await sharp({create:{width:640,height:480,channels:3,background:'#7132f5'}}).png().toBuffer();
    const uploaded = await upload('trash-preview-regression.png',image);assert.equal(uploaded.status,200,uploaded.text);const saved=uploaded.data;
    const endpoint=`/api/modules/image-host/item/${saved.year}/${saved.month}/${encodeURIComponent(saved.filename)}`;
    assert.equal((await call(endpoint,{method:'DELETE',headers:api})).status,200);
    let listing = await call('/api/modules/image-host/trash',{headers:api});
    let item=listing.data.items.find(item=>item.filename===saved.filename);
    assert.equal(item.isImage,true);assert.ok(!('fullPath' in item));
    let preview=`/api/modules/image-host/trash/${item.id}/preview`;
    assert.equal((await call(preview)).status,401);
    for(const [suffix,expectedWidth] of [['?thumbnail=1',320],['',640]]) {
      const result=await call(preview+suffix,{headers:api});assert.equal(result.status,200,result.text);
      assert.match(result.headers.get('cache-control'),/private.*no-store/);
      assert.equal(result.headers.get('content-type'),'image/webp');
      const metadata=await sharp(result.buffer).metadata();assert.equal(metadata.width,expectedWidth);
    }
    assert.equal((await call('/api/modules/image-host/trash/invalid/preview',{headers:api})).status,400);
    assert.equal((await call(`/api/modules/image-host/trash/${item.id}/restore`,{method:'POST',headers:api})).status,200);
    assert.deepEqual(fs.readFileSync(assetPath(saved)),image);
    assert.equal((await call(preview,{headers:admin()})).status,404);
    await call(endpoint,{method:'DELETE',headers:api});
    listing=await call('/api/modules/image-host/trash',{headers:api});item=listing.data.items.find(item=>item.filename===saved.filename);
    preview=`/api/modules/image-host/trash/${item.id}/preview`;
    assert.equal((await call(preview+'?thumbnail=1',{headers:admin()})).status,200);
    assert.equal((await call(`/api/modules/image-host/trash/${item.id}`,{method:'DELETE',headers:api})).status,200);
    assert.equal((await call(preview,{headers:api})).status,404);
    const {UPLOAD_TMP_DIR}=require('../src/core/config');
    assert.equal(fs.readdirSync(UPLOAD_TMP_DIR).some(name=>name.startsWith('trash-preview-')),false);
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

  await t.test('Saved backup listing and downloads expose completed archives only and require admin access',async()=>{
    const backupDir=path.join(root,'data','backups');fs.mkdirSync(backupDir,{recursive:true});
    const filename='filemaster-full-fixture.tar.gz',archive=Buffer.from('fixture-archive');
    fs.writeFileSync(path.join(backupDir,filename),archive);
    fs.writeFileSync(path.join(backupDir,'filemaster-partial.tar.gz.tmp'),'not-finished');
    fs.symlinkSync(CONFIG_PATH,path.join(backupDir,'filemaster-symlink.tar.gz'));
    assert.equal((await call('/api/platform/backup/files')).status,401);
    assert.equal((await call('/api/platform/backup/files',{headers:api})).status,401);
    const listed=await call('/api/platform/backup/files',{headers:admin()});assert.equal(listed.status,200);
    assert.deepEqual(listed.data.files.map(i=>i.filename),[filename]);assert.equal(listed.data.files[0].size,archive.length);
    assert.ok(!listed.text.includes(backupDir));
    const downloaded=await call('/api/platform/backup/files/'+filename,{headers:admin()});assert.equal(downloaded.status,200);assert.deepEqual(downloaded.buffer,archive);
    assert.equal((await call('/api/platform/backup/files/filemaster-symlink.tar.gz',{headers:admin()})).status,404);
    assert.equal((await call('/api/platform/backup/files/config.yaml',{headers:admin()})).status,404);
    fs.rmSync(backupDir,{recursive:true,force:true});
  });

  await t.test('Retired login credential cannot block password login or leak through configuration', async () => {
    fs.appendFileSync(CONFIG_PATH, '\ntotp_secret: "RETIRED_TEST_SECRET"\n');
    const login = await call('/api/platform/login', {method:'POST',json:credentials});
    assert.equal(login.status,200);saveCookie(login);
    assert.equal((await call('/api/platform/login',{method:'POST',json:{...credentials,password:'wrong'}})).status,401);
    for(const reveal of ['', '?reveal=1']){
      const result=await call('/api/platform/config'+reveal,{headers:admin()});
      assert.equal(result.status,200);assert.ok(!result.text.includes('RETIRED_TEST_SECRET'));
      assert.ok(!('totp_secret' in result.data.config));
    }
    assert.equal((await call('/api/platform/totp-generate',{method:'POST',headers:admin()})).status,404);
    await patch({site_name:'Migration complete'});
    assert.ok(!fs.readFileSync(CONFIG_PATH,'utf8').includes('totp_secret'));
  });

  await t.test('Editor rejects credential fields and stale saves; preview returns only actual changes', async () => {
    const snapshot=(await call('/api/platform/config',{headers:admin()})).data;
    const before=fs.readFileSync(CONFIG_PATH,'utf8');
    for(const entry of ['password: changed','api_token: changed']){
      const result=await call('/api/platform/config',{method:'PUT',headers:admin(),json:{mode:'raw',rawYaml:snapshot.rawYaml+'\n'+entry,revision:snapshot.revision}});
      assert.equal(result.status,400);assert.equal(result.data.error,'EDIT_CREDENTIALS_IN_SECURITY');
      assert.equal(fs.readFileSync(CONFIG_PATH,'utf8'),before);
    }
    const unchanged=await call('/api/platform/config/preview',{method:'POST',headers:admin(),json:{rawYaml:snapshot.rawYaml,revision:snapshot.revision}});
    assert.deepEqual(unchanged.data.changes,[]);
    const invalid=await call('/api/platform/config/preview',{method:'POST',headers:admin(),json:{rawYaml:'image_host: [\n',revision:snapshot.revision}});
    assert.equal(invalid.status,400);assert.ok(invalid.data.line>0);assert.ok(invalid.data.code);
    await patch({site_name:'Concurrent change'});
    for(const endpoint of ['/api/platform/config','/api/platform/config/preview']){
      const stale=await call(endpoint,{method:endpoint.endsWith('preview')?'POST':'PUT',headers:admin(),json:{mode:'raw',rawYaml:snapshot.rawYaml,revision:snapshot.revision}});
      assert.equal(stale.status,409);assert.equal(stale.data.error,'CONFIG_CHANGED');
    }
    const current=(await call('/api/platform/config',{headers:admin()})).data;
    const raw=current.rawYaml.replace('Concurrent change','Reviewed change');
    const preview=await call('/api/platform/config/preview',{method:'POST',headers:admin(),json:{rawYaml:raw,revision:current.revision}});
    assert.deepEqual(preview.data.changes,[{key:'site_name',before:'Concurrent change',after:'Reviewed change'}]);
    const saved=await call('/api/platform/config',{method:'PUT',headers:admin(),json:{mode:'raw',rawYaml:raw,revision:current.revision}});
    assert.equal(saved.status,200);saveCookie(saved);assert.equal(getConfig().api_token,token);
    assert.equal((await call('/api/platform/login',{method:'POST',json:credentials})).status,200);
  });

  await t.test('Conditional delete checks the full attachment hash at the server boundary',async()=>{
    const bytes=await sharp({create:{width:20,height:20,channels:3,background:'#123456'}}).png().toBuffer();
    const item=(await upload('conditional-router.png',bytes)).data;
    const url=`/api/modules/image-host/item/${item.year}/${item.month}/${item.filename}`;
    const wrong=await call(url,{method:'DELETE',headers:{...api,'If-Match':'"'+'0'.repeat(64)+'"'}});
    assert.equal(wrong.status,412);assert.deepEqual(fs.readFileSync(assetPath(item)),bytes);
    const removed=await call(url,{method:'DELETE',headers:{...api,'If-Match':'"'+item.sha256+'"'}});
    assert.equal(removed.status,200);assert.equal(fs.existsSync(assetPath(item)),false);
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
