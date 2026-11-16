const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const sharp = require('sharp');

const root = fs.realpathSync(path.resolve(__dirname, '..'));
assert.equal(process.env.FILE_MASTER_TEST_ROOT, root, 'Run npm test: HTTP tests require an isolated project');

test('Upload conflict metadata, replacement to recycle bin, auto-rename and trash retention purge', async (t) => {
  const { app } = require('../src/server');
  const { getConfig, prepareConfigPatch, writePreparedConfig } = require('../src/core/config');
  const { listTrashEntries, pruneExpiredTrash, trashMetadata } = require('../src/modules/image-host/trash');
  const { RAW_DIR } = require('../src/modules/image-host/asset-paths');

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = 'conflict-test-api-token';

  const setupRes = await fetch(`${base}/api/platform/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      site_name: 'Conflict Test',
      base_url: base,
      port: server.address().port,
      admin_path: 'admin',
      username: 'tester',
      password: 'test-only-password',
      api_token: token
    })
  });
  assert.equal(setupRes.status, 200);

  const imgA = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 220, g: 40, b: 40, alpha: 1 } } }).png().toBuffer();
  const imgB = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 40, g: 120, b: 220, alpha: 1 } } }).png().toBuffer();
  const imgC = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 40, g: 200, b: 80, alpha: 1 } } }).png().toBuffer();
  const imgD = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 220, g: 180, b: 40, alpha: 1 } } }).png().toBuffer();

  const upload = async (buf, name, strategy = '') => {
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'image/png' }), name);
    const headers = { Authorization: `Bearer ${token}`, 'X-File-Name': encodeURIComponent(name) };
    if (strategy) headers['X-Conflict-Strategy'] = strategy;
    if (strategy === 'replace') {
      const checked = await (await fetch(`${base}/api/image/upload-check`, {
        method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        body:JSON.stringify({items:[{filename:name}]})
      })).json();
      const target=checked.results[0].conflict;
      headers['X-Conflict-Target-Year']=target.year;
      headers['X-Conflict-Target-Month']=target.month;
      headers['X-Conflict-Target-Filename']=encodeURIComponent(target.filename);
      headers['X-Conflict-Target-Sha256']=target.sha256;
    }
    const res = await fetch(`${base}/api/image/upload`, { method: 'POST', headers, body: form });
    return { status: res.status, data: await res.json() };
  };

  // 1. Initial upload succeeds
  const first = await upload(imgA, 'cover.png');
  assert.equal(first.status, 200);
  assert.equal(first.data.filename, 'cover.png');

  // 2. Upload-check reports conflict for same-name different content & instant for same bytes
  const checkRes = await fetch(`${base}/api/image/upload-check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [
        { filename: 'cover.png' },
        { filename: 'cover.png', sha256: first.data.sha256 }
      ]
    })
  });
  assert.equal(checkRes.status, 200);
  const checkData = await checkRes.json();
  assert.equal(checkData.results[0].status, 'conflict');
  assert.equal(checkData.results[0].conflict.filename, 'cover.png');
  assert.equal(checkData.results[0].conflict.locked, false);
  assert.equal(checkData.results[1].status, 'instant');

  // 3. Default upload with same name and different bytes returns 409 with conflict metadata
  const conflictRes = await upload(imgB, 'cover.png');
  assert.equal(conflictRes.status, 409);
  assert.equal(conflictRes.data.code, 'NAME_CONFLICT');
  assert.equal(conflictRes.data.conflict.filename, 'cover.png');
  assert.equal(conflictRes.data.conflict.sha256, first.data.sha256);
  assert.ok(conflictRes.data.conflict.rawUrl);

  // 4. Replace strategy moves old file to recycle bin and stores new file at cover.png
  const replaced = await upload(imgB, 'cover.png', 'replace');
  assert.equal(replaced.status, 200);
  assert.equal(replaced.data.replaced, true);
  assert.equal(replaced.data.filename, 'cover.png');
  assert.notEqual(replaced.data.sha256, first.data.sha256);

  const trashAfterReplace = listTrashEntries();
  assert.equal(trashAfterReplace.length, 1);
  assert.equal(trashAfterReplace[0].filename, 'cover.png');
  assert.equal(trashAfterReplace[0].sha256, first.data.sha256);

  // 5. Rename strategy disambiguates and keeps both files
  const renamed = await upload(imgC, 'cover.png', 'rename');
  assert.equal(renamed.status, 200);
  assert.notEqual(renamed.data.filename, 'cover.png');

  // 6. Locked remote file blocks replacement with 403
  const lockRes = await fetch(`${base}/api/modules/image-host/lock`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ year: replaced.data.year, month: replaced.data.month, filename: 'cover.png', locked: true })
  });
  assert.equal(lockRes.status, 200);
  const lockedReplace = await upload(imgD, 'cover.png', 'replace');
  assert.equal(lockedReplace.status, 403);
  assert.equal(lockedReplace.data.code, 'FILE_LOCKED');

  // 7. Recycle bin auto-purge removes expired entries based on trash_retention_days
  const cfg = getConfig();
  assert.equal(cfg.image_host.trash_retention_days, 0);
  assert.equal(pruneExpiredTrash(), 0);

  // Backdate the trash entry metadata by 10 days
  const trashEntry = listTrashEntries()[0];
  const sidecarPath = trashEntry.fullPath + '.json';
  const meta = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  meta.deletedAt = Date.now() - 10 * 86400000;
  fs.writeFileSync(sidecarPath, JSON.stringify(meta));

  const prepared = prepareConfigPatch({ image_host: { trash_retention_days: 7 } });
  writePreparedConfig(prepared);
  const purgedCount = pruneExpiredTrash();
  assert.equal(purgedCount, 1);
  assert.equal(listTrashEntries().length, 0);

  // 8. Trash restore conflict returns 409 and supports rename and replace strategies
  await fetch(`${base}/api/modules/image-host/lock`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ year: replaced.data.year, month: replaced.data.month, filename: 'cover.png', locked: false })
  });
  const replacedAgain = await upload(imgD, 'cover.png', 'replace');
  assert.equal(replacedAgain.status, 200);
  const trashListRes = await fetch(`${base}/api/modules/image-host/trash`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const trashListData = await trashListRes.json();
  const conflictTrashId = trashListData.items[0].id;

  const conflictRestore = await fetch(`${base}/api/modules/image-host/trash/${encodeURIComponent(conflictTrashId)}/restore`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(conflictRestore.status, 409);
  const conflictRestoreBody = await conflictRestore.json();
  assert.equal(conflictRestoreBody.conflict.filename, 'cover.png');

  const replaceRestore = await fetch(`${base}/api/modules/image-host/trash/${encodeURIComponent(conflictTrashId)}/restore`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conflictStrategy: 'replace', conflictTarget: conflictRestoreBody.conflict })
  });
  assert.equal(replaceRestore.status, 200);
  const replaceRestoreBody = await replaceRestore.json();
  assert.equal(replaceRestoreBody.filename, 'cover.png');

  // The newly trashed file can also be restored with a new name
  const trashList2 = await (await fetch(`${base}/api/modules/image-host/trash`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const renameRestore = await fetch(`${base}/api/modules/image-host/trash/${encodeURIComponent(trashList2.items[0].id)}/restore`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conflictStrategy: 'rename', filename: 'cover_restored.png' })
  });
  assert.equal(renameRestore.status, 200);
  const renameRestoreBody = await renameRestore.json();
  assert.equal(renameRestoreBody.filename, 'cover_restored.png');

  // 9. N02 + N05: Cross-month replace preserves original year/month URL and verifies expected target/sha256
  const oldDir = path.join(RAW_DIR, '2020', '01');
  fs.mkdirSync(oldDir, { recursive: true });
  const oldBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
  fs.writeFileSync(path.join(oldDir, 'legacy_cross.png'), oldBytes);
  const crossCheck = await fetch(`${base}/api/image/upload-check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ filename: 'legacy_cross.png' }] })
  });
  const crossCheckData = await crossCheck.json();
  assert.equal(crossCheckData.results[0].status, 'conflict');
  assert.equal(crossCheckData.results[0].conflict.year, '2020');
  assert.equal(crossCheckData.results[0].conflict.month, '01');

  // Mismatched expected SHA256 must be rejected with 409 CONFLICT_TARGET_CHANGED
  const imgE = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  const boundary1 = '----fmCross1' + Date.now();
  const mismatchRes = await fetch(`${base}/api/image/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Conflict-Strategy': 'replace',
      'X-Conflict-Target-Year': '2020',
      'X-Conflict-Target-Month': '01',
      'X-Conflict-Target-Filename': 'legacy_cross.png',
      'X-Conflict-Target-Sha256': '0'.repeat(64),
      'Content-Type': `multipart/form-data; boundary=${boundary1}`
    },
    body: Buffer.concat([
      Buffer.from(`--${boundary1}\r\nContent-Disposition: form-data; name="file"; filename="legacy_cross.png"\r\nContent-Type: image/png\r\n\r\n`),
      imgE,
      Buffer.from(`\r\n--${boundary1}--\r\n`)
    ])
  });
  assert.equal(mismatchRes.status, 409);
  const mismatchBody = await mismatchRes.json();
  assert.equal(mismatchBody.code, 'CONFLICT_TARGET_CHANGED');

  // Matching expected target preserves 2020/01 path
  const boundary2 = '----fmCross2' + Date.now();
  const crossReplaceRes = await fetch(`${base}/api/image/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Conflict-Strategy': 'replace',
      'X-Conflict-Target-Year': '2020',
      'X-Conflict-Target-Month': '01',
      'X-Conflict-Target-Filename': 'legacy_cross.png',
      'X-Conflict-Target-Sha256': require('node:crypto').createHash('sha256').update(oldBytes).digest('hex'),
      'Content-Type': `multipart/form-data; boundary=${boundary2}`
    },
    body: Buffer.concat([
      Buffer.from(`--${boundary2}\r\nContent-Disposition: form-data; name="file"; filename="legacy_cross.png"\r\nContent-Type: image/png\r\n\r\n`),
      imgE,
      Buffer.from(`\r\n--${boundary2}--\r\n`)
    ])
  });
  assert.equal(crossReplaceRes.status, 200);
  const crossReplaceBody = await crossReplaceRes.json();
  assert.equal(crossReplaceBody.year, '2020');
  assert.equal(crossReplaceBody.month, '01');
  assert.equal(crossReplaceBody.filename, 'legacy_cross.png');
});
