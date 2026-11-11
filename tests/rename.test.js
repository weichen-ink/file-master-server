const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const sharp = require('sharp');
const { execFileSync } = require('node:child_process');
assert.equal(process.env.FILE_MASTER_TEST_ROOT, fs.realpathSync(path.resolve(__dirname, '..')), 'Use npm test with an isolated project');

test('Server rename keeps file identity, old URLs and one upload namespace', async t => {
  const { app } = require('../src/server');
  const { RAW_DIR, findRawFile } = require('../src/modules/image-host/asset-paths');
  const { getShaIndex, pathToShaMap, updateShaIndex } = require('../src/modules/image-host/sha-index');
  const { readNameState } = require('../src/modules/image-host/asset-names');
  const { recoverPendingRename } = require('../src/modules/image-host/rename');
  const { getAssetStats, recordHit } = require('../src/modules/image-host/stats');
  const { getSharesMap } = require('../src/modules/share');
  const { isItemLocked } = require('../src/modules/image-host/protection');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer rename-test-token' };
  const call = async (url, options = {}) => {
    const res = await fetch(new URL(url, base), { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(10000) });
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buffer, data: res.headers.get('content-type')?.includes('json') ? JSON.parse(buffer) : null };
  };
  const post = (url, body) => call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const upload = (name, bytes, endpoint = '/api/image/upload') => {
    const form = new FormData(); form.append('file', new Blob([bytes]), name);
    return call(endpoint, { method: 'POST', headers: { 'X-File-Name': encodeURIComponent(name) }, body: form });
  };
  assert.equal((await post('/api/platform/setup', { username: 'rename', password: 'test-rename-password', base_url: base, api_token: 'rename-test-token', watermark_enable: false })).status, 200);
  const image = await sharp({ create: { width: 24, height: 20, channels: 3, background: '#7132f5' } }).png().toBuffer();
  const other = await sharp({ create: { width: 26, height: 22, channels: 3, background: '#345678' } }).png().toBuffer();
  let file = (await upload('旧名称.png', image)).data;
  const original = { ...file }, location = item => path.join(RAW_DIR, item.year, item.month, item.filename);
  let counter = 0;
  const payload = (item, newFilename) => ({ year: item.year, month: item.month, filename: item.filename, newFilename, expectedSha256: item.sha256, operationId: `test-operation-${++counter}` });
  let request, shareId;

  await t.test('Preview is read-only, validates hashes, paths, extensions, case and Unicode conflicts', async () => {
    const namesBefore = fs.readdirSync(path.dirname(location(file)));
    const oldInode = fs.statSync(location(file)).ino;
    const preview = await post('/api/modules/image-host/rename/preview', payload(file, '新名称.png'));
    assert.equal(preview.status, 200); assert.equal(preview.data.item.filename, '新名称.png');
    assert.ok(preview.data.linkMappings.some(map => map.from === file.rawUrl && map.to === preview.data.item.rawUrl));
    assert.ok(preview.data.linkMappings.some(map => map.from === file.pubUrl && map.to === preview.data.item.pubUrl));
    assert.deepEqual(fs.readdirSync(path.dirname(location(file))), namesBefore);
    assert.equal(fs.statSync(location(file)).ino, oldInode); assert.equal(readNameState().pending, null);
    for (const name of ['../escape.png','bad.jpg','.hidden.png','NUL.png','bad?.png','bad.png.']) {
      assert.equal((await post('/api/modules/image-host/rename/preview', payload(file, name))).status, 400, name);
    }
    assert.equal((await post('/api/modules/image-host/rename/preview', { ...payload(file, 'valid.png'), expectedSha256: '0'.repeat(64) })).status, 409);
    assert.equal((await upload('Taken.png', other)).status, 200);
    assert.equal((await post('/api/modules/image-host/rename/preview', payload(file, 'taken.png'))).status, 409);
    assert.equal((await call('/api/modules/image-host/rename', { method: 'POST', headers: { Authorization: '' } })).status, 401);
  });
  await t.test('Commit moves SHA baseline, lock, shares and access counters without copying file bytes', async () => {
    getShaIndex(); const sourceKey = `${file.year}/${file.month}/${file.filename}`;
    const known = pathToShaMap.get(sourceKey), baselineSha256 = 'a'.repeat(64);
    updateShaIndex(file.sha256, { ...file, ...known, mtimeMs: known.mtimeMs + 1, baselineSha256 });
    // Preserve the existing integrity baseline even if it differs from the file hash.
    pathToShaMap.get(sourceKey).baselineSha256 = baselineSha256;
    await post('/api/modules/image-host/lock', { ...file, locked: true });
    shareId = (await post('/api/modules/share/create', { ...file, expiresInHours: 24 })).data.share.id;
    recordHit(file.year, file.month, file.filename);
    const inode = fs.statSync(location(file)).ino;
    request = payload(file, '新名称.png');
    const result = await post('/api/modules/image-host/rename', request);
    assert.equal(result.status, 200, JSON.stringify(result.data)); file = result.data.item;
    assert.equal(fs.existsSync(location(original)), false); assert.equal(fs.statSync(location(file)).ino, inode);
    assert.deepEqual(fs.readFileSync(location(file)), image);
    assert.equal(pathToShaMap.has(sourceKey), false);
    assert.equal(pathToShaMap.get(`${file.year}/${file.month}/${file.filename}`).baselineSha256, baselineSha256);
    assert.equal(isItemLocked(file.year,file.month,file.filename), true);
    assert.equal(getSharesMap()[shareId].filename, file.filename);
    assert.equal(getAssetStats(file.year,file.month,file.filename).hits, 1);
    const retry = await post('/api/modules/image-host/rename', request);
    assert.equal(retry.status, 200); assert.equal(retry.data.item.filename, file.filename);
    assert.equal((await post('/api/modules/image-host/rename', { ...request, newFilename: 'unrelated.png' })).status, 409);
  });
  await t.test('Old and new raw/WebP URLs and share links still serve the correct file', async () => {
    for (const url of [original.rawUrl, file.rawUrl]) {
      assert.deepEqual((await call(url + '?download=1')).buffer, image);
      assert.equal((await sharp((await call(url + '?thumbnail=1')).buffer).metadata()).format, 'webp');
    }
    for (const url of [original.pubUrl,file.pubUrl]) assert.equal((await sharp((await call(url+'?wm=0')).buffer).metadata()).format, 'webp');
    assert.deepEqual((await call(`/s/${shareId}`)).buffer, image);
    const listing = (await call('/api/modules/image-host/list')).data.images;
    assert.ok(listing.some(item => item.filename === file.filename));
    assert.ok(!listing.some(item => item.filename === original.filename));
  });
  await t.test('Every upload endpoint deduplicates first and returns the current renamed URL', async () => {
    for (const endpoint of ['/api/image/upload','/api/modules/image-host/upload']) {
      const result = await upload(original.filename, image, endpoint);
      assert.equal(result.status, 200); assert.equal(result.data.deduplicated, true);
      assert.equal(result.data.filename, file.filename); assert.equal(result.data.rawUrl, file.rawUrl);
      const conflict = await upload(original.filename, Buffer.concat([other, Buffer.from(endpoint)]), endpoint);
      assert.equal(conflict.status, 409); assert.equal(conflict.data.code, 'NAME_RESERVED');
    }
    const probe = (await call(`/api/image/probe?sha256=${file.sha256}`)).data;
    assert.equal(probe.filename, file.filename); assert.equal(probe.rawUrl, file.rawUrl);
    const reservedWebp = await upload('旧名称.webp', Buffer.concat([other,Buffer.from('webp')]));
    assert.equal(reservedWebp.status, 409);
  });
  await t.test('Rename chains and reclaiming an owned historical name flatten aliases', async () => {
    const second = await post('/api/modules/image-host/rename', payload(file, 'final.png'));
    assert.equal(second.status, 200);file=second.data.item;
    const retried = await post('/api/modules/image-host/rename', request);
    assert.equal(retried.data.item.filename, 'final.png');
    assert.ok(retried.data.linkMappings.some(item => item.from === original.rawUrl && item.to === file.rawUrl));
    const reclaimed = await post('/api/modules/image-host/rename', payload(file,original.filename));
    assert.equal(reclaimed.status,200);file=reclaimed.data.item;
    assert.deepEqual((await call(second.data.item.rawUrl)).buffer,image);
    const differentExt = await upload('final.jpg', Buffer.concat([other,Buffer.from('jpg')]));
    assert.equal(differentExt.status,200);assert.ok(differentExt.data.pubUrl.endsWith('/final.jpg.webp'));
    assert.deepEqual((await call(second.data.item.rawUrl)).buffer,image);
    // New uploads with a previously used full name may not revive an old URL.
    assert.equal((await upload('final.png', Buffer.concat([other,Buffer.from('conflict')]))).status,409);
  });
  await t.test('Deletion retains name reservations, and restoring the same file restores aliases', async () => {
    await post('/api/modules/image-host/lock', { ...file, locked: false });
    assert.equal((await call(`/api/modules/image-host/item/${file.year}/${file.month}/${encodeURIComponent(file.filename)}`,{method:'DELETE'})).status,200);
    assert.equal((await call(original.rawUrl)).status,404);
    assert.equal((await upload(original.filename,Buffer.concat([other,Buffer.from('deleted')]))).status,409);
    const trash=(await call('/api/modules/image-host/trash')).data.items.find(item=>item.filename===file.filename);
    assert.equal((await post(`/api/modules/image-host/trash/${trash.id}/restore`,{})).status,200);
    assert.deepEqual((await call(original.rawUrl)).buffer,image);
  });
  await t.test('An interrupted metadata commit is replayed before the next mutation', async () => {
    const oldPath=location(file), realUnlink=fs.unlinkSync;
    fs.unlinkSync=target=>{if(target===oldPath)throw new Error('injected interruption');return realUnlink(target);};
    const next=payload(file,'recovered.png');
    try { assert.equal((await post('/api/modules/image-host/rename',next)).status,500); }
    finally { fs.unlinkSync=realUnlink; }
    assert.ok(readNameState().pending);
    execFileSync(process.execPath, ['-e', "require('./src/modules/image-host/rename').recoverPendingRename()"], { cwd: path.resolve(__dirname, '..') });
    recoverPendingRename();
    assert.equal(readNameState().pending,null);
    const response=await post('/api/modules/image-host/rename',next);
    assert.equal(response.status,200);file=response.data.item;
    assert.equal(fs.existsSync(oldPath),false);
    assert.deepEqual((await call(original.rawUrl)).buffer,image);
    assert.equal(path.basename(findRawFile(file.year,file.month,original.filename,true)),file.filename);
  });
  await t.test('Existing sibling WebP links survive new basename collisions and restore normally', async () => {
    const first=(await upload('sibling-source.png',Buffer.concat([image,Buffer.from('source')]))).data;
    const sibling=(await upload('sibling-destination.jpg',await sharp(other).jpeg().toBuffer())).data;
    const oldSibling=await call(sibling.pubUrl+'?wm=0');assert.equal(oldSibling.status,200);
    const renamed=await post('/api/modules/image-host/rename',payload(first,'sibling-destination.png'));
    assert.equal(renamed.status,200);assert.ok(renamed.data.item.pubUrl.endsWith('sibling-destination.png.webp'));
    assert.deepEqual((await call(sibling.pubUrl+'?wm=0')).buffer,oldSibling.buffer);
    assert.deepEqual((await call(renamed.data.item.rawUrl)).buffer,Buffer.concat([image,Buffer.from('source')]));
    await call(`/api/modules/image-host/item/${sibling.year}/${sibling.month}/${sibling.filename}`,{method:'DELETE'});
    const trashed=(await call('/api/modules/image-host/trash')).data.items.find(item=>item.filename===sibling.filename);
    assert.equal((await post(`/api/modules/image-host/trash/${trashed.id}/restore`,{})).status,200);
    assert.deepEqual((await call(sibling.pubUrl+'?wm=0')).buffer,oldSibling.buffer);
  });
  await t.test('Same-name bytes are reused even before the hash index discovers the file', async () => {
    const filename='not-indexed-yet.png',bytes=Buffer.concat([image,Buffer.from('not indexed')]);
    fs.writeFileSync(path.join(RAW_DIR,file.year,file.month,filename),bytes);
    const result=await upload(filename,bytes);
    assert.equal(result.status,200);assert.equal(result.data.deduplicated,true);assert.equal(result.data.filename,filename);
    const dir=path.join(RAW_DIR,'2025','01');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,original.filename),other);
    // Name reservations are scoped to their directory, not the entire server.
    const {assertNameAvailable}=require('../src/modules/image-host/asset-names');
    assert.doesNotThrow(()=>assertNameAvailable(dir,'2025','01','new-unique.png'));
    assert.doesNotThrow(()=>assertNameAvailable(dir,'2025','01',file.filename));
  });
  await t.test('Concurrent renames have one winner and never overwrite another file', async () => {
    const results=await Promise.all(['winner-a.png','winner-b.png'].map(name=>post('/api/modules/image-host/rename',payload(file,name))));
    assert.deepEqual(results.map(result=>result.status).sort(),[200,404]);
    const success=results.find(result=>result.status===200);assert.deepEqual(fs.readFileSync(location(success.data.item)),image);
  });
});
