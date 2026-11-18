const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const sharp = require('sharp');

assert.equal(
  process.env.FILE_MASTER_TEST_ROOT,
  fs.realpathSync(path.resolve(__dirname, '..')),
  'Run via npm test so tests use an isolated workspace'
);

test('2026-11-18 Audit Regressions: P0-5, S-1, S-2, S-5, S-6, W-1, D-2', async (t) => {
  const { app } = require('../src/server');
  const { queryCatalog } = require('../src/modules/image-host/catalog-query');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const token = 'audit-2026-11-18-secret-token';
  const authHeaders = { Authorization: `Bearer ${token}` };

  const call = async (url, options = {}) => {
    const res = await fetch(new URL(url, base), {
      ...options,
      headers: { ...authHeaders, ...options.headers },
      signal: AbortSignal.timeout(10000)
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    const isJson = res.headers.get('content-type')?.includes('json');
    return {
      status: res.status,
      headers: res.headers,
      buffer,
      data: isJson ? JSON.parse(buffer.toString('utf8')) : null
    };
  };
  const post = (url, body, extraHeaders = {}) =>
    call(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body)
    });
  const upload = (name, buf, extraHeaders = {}) => {
    const form = new FormData();
    form.append('file', new Blob([buf]), name);
    return call('/api/image/upload', {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent(name), ...extraHeaders },
      body: form
    });
  };

  const setupRes = await post('/api/platform/setup', {
    username: 'auditor',
    password: 'audit-strong-password-123',
    base_url: base,
    api_token: token,
    enable_optimization: true,
    watermark_enable: true,
    watermark_type: 'text',
    watermark_text: 'AUDIT'
  });
  assert.equal(setupRes.status, 200);

  await t.test('P0-5: Overwriting a renamed file keeps trash restore working while deleted renamed names stay permanently reserved', async () => {
    const v1 = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#2255cc' } }).png().toBuffer();
    const v2 = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#cc5522' } }).png().toBuffer();
    const v3 = await sharp({ create: { width: 28, height: 28, channels: 3, background: '#22aa55' } }).png().toBuffer();

    const up1 = await upload('origin-name.png', v1);
    assert.equal(up1.status, 200);

    const renamed = await post('/api/modules/image-host/rename', {
      year: up1.data.year,
      month: up1.data.month,
      filename: up1.data.filename,
      newFilename: 'renamed-target.png',
      expectedSha256: up1.data.sha256,
      operationId: 'audit-rename-op-1'
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.item.filename, 'renamed-target.png');

    // Overwrite renamed-target.png in place with v2
    const replaced = await upload('renamed-target.png', v2, {
      'X-Conflict-Strategy': 'replace',
      'X-Conflict-Target-Year': renamed.data.item.year,
      'X-Conflict-Target-Month': renamed.data.item.month,
      'X-Conflict-Target-Filename': encodeURIComponent('renamed-target.png'),
      'X-Conflict-Target-Sha256': renamed.data.item.sha256
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.data.filename, 'renamed-target.png');
    assert.notEqual(replaced.data.sha256, up1.data.sha256);

    // Move the overwritten file to trash, then restore it -> must NOT fail with 409 NAME_RESERVED
    const delRes = await call(
      `/api/modules/image-host/item/${replaced.data.year}/${replaced.data.month}/${encodeURIComponent('renamed-target.png')}`,
      { method: 'DELETE' }
    );
    assert.equal(delRes.status, 200);

    const trashList = await call('/api/modules/image-host/trash');
    const latestTrash = trashList.data.items.find(
      (i) => i.filename === 'renamed-target.png' && i.size === v2.length
    );
    assert.ok(latestTrash, 'expected overwritten renamed file in trash');

    const restored = await post(`/api/modules/image-host/trash/${encodeURIComponent(latestTrash.id)}/restore`, {});
    assert.equal(restored.status, 200, `Expected restore 200, got ${restored.status}: ${JSON.stringify(restored.data)}`);

    // Now trash and permanently delete renamed-target.png -> name must stay permanently reserved!
    await call(
      `/api/modules/image-host/item/${replaced.data.year}/${replaced.data.month}/${encodeURIComponent('renamed-target.png')}`,
      { method: 'DELETE' }
    );
    const trashAfter = await call('/api/modules/image-host/trash');
    for (const entry of trashAfter.data.items.filter((i) => i.filename === 'renamed-target.png')) {
      const purge = await call(`/api/modules/image-host/trash/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      assert.equal(purge.status, 200);
    }

    const checkReserved = await post('/api/image/upload-check', {
      items: [{ filename: 'renamed-target.png', year: replaced.data.year, month: replaced.data.month }]
    });
    assert.equal(checkReserved.status, 200);
    assert.equal(checkReserved.data.results[0].status, 'conflict');
    assert.equal(checkReserved.data.results[0].code, 'NAME_RESERVED');
    assert.equal(checkReserved.data.results[0].conflict.code, 'NAME_RESERVED');

    const unrelatedUpload = await upload('renamed-target.png', v3);
    assert.equal(unrelatedUpload.status, 409);
  });

  await t.test('S-1 & S-2: Uppercase extension upload does not double extension, and EXIF Orientation=6 watermarked WebP rotates cleanly', async () => {
    // Landscape pixel buffer (320x180) tagged with EXIF Orientation 6 (90 CW -> 180x320 portrait)
    const exifPortraitJpg = await sharp({
      create: { width: 320, height: 180, channels: 3, background: '#4477aa' }
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const up = await upload('IMG_9001.JPG', exifPortraitJpg);
    assert.equal(up.status, 200);
    assert.equal(up.data.filename, 'IMG_9001.jpg');

    const pubRes = await fetch(up.data.pubUrl, { signal: AbortSignal.timeout(10000) });
    assert.equal(pubRes.status, 200);
    const webpBuf = Buffer.from(await pubRes.arrayBuffer());
    const outMeta = await sharp(webpBuf).metadata();
    assert.equal(outMeta.width, 180);
    assert.equal(outMeta.height, 320);
  });

  await t.test('S-5: Multi-byte UTF-8 bearer token returns 401 instead of 500 RangeError, and forged logout cookies do not bloat revoked_sessions.json', async () => {
    // Same string length as `token` (both 28 UTF-16 code units), but 'é' is 2 bytes in UTF-8 (29 bytes vs 28 bytes).
    // Previously `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))` threw RangeError (HTTP 500).
    const multibyteSameLen = 'é' + token.slice(1);
    assert.equal(multibyteSameLen.length, token.length);
    assert.notEqual(Buffer.byteLength(multibyteSameLen), Buffer.byteLength(token));
    const badAuth = await fetch(`${base}/api/modules/image-host/list`, {
      headers: { Authorization: `Bearer ${multibyteSameLen}` },
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(badAuth.status, 401);

    const config = require('../src/core/config');
    const revokedPath = path.join(config.DATA_DIR, 'revoked_sessions.json');
    const beforeSize = fs.existsSync(revokedPath) ? fs.statSync(revokedPath).size : 0;
    const fakeLogout = await fetch(`${base}/api/platform/logout`, {
      method: 'POST',
      headers: { Cookie: 'fm_admin_session=forged.payload.invalid_signature' },
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(fakeLogout.status, 200);
    const afterSize = fs.existsSync(revokedPath) ? fs.statSync(revokedPath).size : 0;
    assert.equal(afterSize, beforeSize);
  });

  await t.test('S-6: Share links bind to SHA-256, invalidate on overwrite with 410, and support self-check + cleanup-invalid', async () => {
    const origBuf = Buffer.from('confidential-report-v1');
    const nextBuf = Buffer.from('different-public-file-v2');
    const up = await upload('report-share.pdf', origBuf);
    assert.equal(up.status, 200);

    const shareRes = await post('/api/modules/share/create', {
      year: up.data.year,
      month: up.data.month,
      filename: up.data.filename,
      expiresInHours: 24,
      maxDownloads: 0
    });
    assert.equal(shareRes.status, 200);
    const shareId = shareRes.data.share.id;

    // Valid before replacement
    const okDl = await fetch(`${base}/s/${shareId}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(okDl.status, 200);

    // Overwrite report-share.pdf with different content
    const rep = await upload('report-share.pdf', nextBuf, {
      'X-Conflict-Strategy': 'replace',
      'X-Conflict-Target-Year': up.data.year,
      'X-Conflict-Target-Month': up.data.month,
      'X-Conflict-Target-Filename': encodeURIComponent(up.data.filename),
      'X-Conflict-Target-Sha256': up.data.sha256
    });
    assert.equal(rep.status, 200);

    // Share link must now be invalidated (410)
    const blockedDl = await fetch(`${base}/s/${shareId}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(blockedDl.status, 410);
    const htmlBlocked = await fetch(`${base}/s/${shareId}`, {
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(htmlBlocked.status, 410);
    assert.match(htmlBlocked.headers.get('content-type') || '', /text\/html/);

    // Self-check endpoint reports fileChanged
    const verifyRes = await post('/api/modules/share/verify', {});
    assert.equal(verifyRes.status, 200);
    const checkedShare = verifyRes.data.shares.find((s) => s.id === shareId);
    assert.ok(checkedShare);
    assert.equal(checkedShare.state, 'fileChanged');
    assert.equal(checkedShare.invalid, true);

    // Cleanup removes invalid shares
    const cleanRes = await post('/api/modules/share/cleanup-invalid', {});
    assert.equal(cleanRes.status, 200);
    assert.ok(cleanRes.data.removed >= 1);
    assert.equal(cleanRes.data.shares.some((s) => s.id === shareId), false);
  });

  await t.test('W-1 & D-2: Server-side catalog paging, archiveGroups bucketCounts, and locale pluralization', async () => {
    const sample = {
      optimizationEnabled: true,
      images: [
        { year: '2026', month: '11', filename: 'a.png', category: 'image', size: 100, locked: true, createdAt: 2 },
        { year: '2026', month: '10', filename: 'b.pdf', category: 'document', size: 250, locked: false, createdAt: 1 }
      ]
    };
    const q1 = queryCatalog(sample, { folder: '2026', protected: '1', sort: 'time-desc', limit: '60', offset: '0' });
    assert.equal(q1.totalCount, 1);
    assert.equal(q1.totalBytes, 100);
    assert.equal(q1.allTotalCount, 2);
    assert.deepEqual(q1.bucketCounts, { '2026/11': 1, '2026/10': 1 });

    const qKey = queryCatalog(sample, { key: '2026/10/b.pdf', limit: '1' });
    assert.equal(qKey.images.length, 1);
    assert.equal(qKey.images[0].filename, 'b.pdf');

    const { archiveGroups } = await import('../src/public/assets/admin/features/files.mjs');
    assert.deepEqual(archiveGroups(q1.bucketCounts), archiveGroups(sample.images));

    const { setLocale, t: translate } = await import('../src/public/assets/admin/locale.mjs');
    setLocale('en');
    assert.equal(translate('unsavedCount', { count: 1 }), '1 unsaved section');
    assert.equal(translate('unsavedCount', { count: 3 }), '3 unsaved sections');
    assert.equal(translate('downloadCount', { count: 1 }), '1 download');
    assert.equal(translate('downloadCount', { count: 0 }), '0 downloads');
  });
});
