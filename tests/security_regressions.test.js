const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { UPLOAD_TMP_DIR } = require('../src/core/config');
const { createSessionCookie } = require('../src/core/security');
const { acceptSingleUpload, moveFileToTrash } = require('../src/modules/image-host');

test('Gallery treats uploaded filenames as data without executable click handlers', async () => {
  const { fileCard } = await import('../src/public/assets/admin/features/files.mjs');
  const { parseRoute, detailHref } = await import('../src/public/assets/admin/router.mjs');
  const filename = "x'-alert`1`-'.png";
  const item = { year: '2026', month: '10', filename, ext: 'png', size: 5, isImage: true,
    rawPreviewPath: '/raw/2026/10/' + encodeURIComponent(filename) };
  const html = fileCard(item, 0);
  assert.ok(html.includes('&#39;'));
  assert.ok(!/\bonclick=/.test(html));
  assert.ok(!html.includes(`title="${filename}"`));
  assert.equal(parseRoute(detailHref(item)).key, `2026/10/${filename}`);
});

test('Multipart upload accepts one file and rejects a second without leaving temp files', async () => {
  const before = new Set(fs.existsSync(UPLOAD_TMP_DIR) ? fs.readdirSync(UPLOAD_TMP_DIR) : []);
  const boundary = 'filemaster-security-test';
  const send = (count) => {
    const body = Buffer.from(Array.from({ length: count }, (_, index) => {
      const n = index + 1;
      return `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${n}.png"\r\nContent-Type: image/png\r\n\r\nfile${n}\r\n`;
    }).join('') + `--${boundary}--\r\n`);
    const req = Readable.from([body]);
    req.method = 'POST';
    req.headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length)
    };
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { resolve({ status: this.statusCode, data }); return this; }
      };
      acceptSingleUpload(req, res, (err) => err ? reject(err) : resolve({ status: 200, file: req.file }));
    });
  };

  const accepted = await send(1);
  assert.equal(accepted.status, 200);
  assert.equal(fs.readFileSync(accepted.file.path, 'utf8'), 'file1');
  fs.unlinkSync(accepted.file.path);

  const rejected = await send(2);
  assert.equal(rejected.status, 400);
  assert.deepEqual(new Set(fs.readdirSync(UPLOAD_TMP_DIR)), before);
});

test('Failed trash move keeps the original; successful move removes it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-trash-test-'));
  try {
    const source = path.join(dir, 'original.png');
    const blockedTarget = path.join(dir, 'existing-directory');
    fs.writeFileSync(source, 'original content');
    fs.mkdirSync(blockedTarget);
    const hash = crypto.createHash('sha256').update('original content').digest('hex');
    await assert.rejects(moveFileToTrash(source, blockedTarget, hash));
    assert.equal(fs.readFileSync(source, 'utf8'), 'original content');

    const target = path.join(dir, 'trashed.png');
    await moveFileToTrash(source, target, hash);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original content');

    const crossDeviceSource = path.join(dir, 'cross-device.png');
    const crossDeviceTarget = path.join(dir, 'cross-device-trash.png');
    fs.writeFileSync(crossDeviceSource, 'original content');
    const renameSync = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
    try {
      await assert.rejects(moveFileToTrash(crossDeviceSource, crossDeviceTarget, 'wrong-hash'));
      assert.equal(fs.readFileSync(crossDeviceSource, 'utf8'), 'original content');
      assert.equal(fs.existsSync(crossDeviceTarget), false);

      await moveFileToTrash(crossDeviceSource, crossDeviceTarget, hash);
      assert.equal(fs.existsSync(crossDeviceSource), false);
      assert.equal(fs.readFileSync(crossDeviceTarget, 'utf8'), 'original content');
    } finally {
      fs.renameSync = renameSync;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTPS cookies are Secure while HTTP cookies omit Secure flag', () => {
  assert.match(createSessionCookie({ secure: true }, 'token'), /; Secure(?:;|$)/);
  assert.doesNotMatch(createSessionCookie({ secure: false }, 'token'), /; Secure(?:;|$)/);
});

test('Config exports EXAMPLE_CONFIG_PATH, redacts credentials by default, and blocks watermark path traversal', () => {
  const {
    EXAMPLE_CONFIG_PATH,
    redactConfigForClient,
    validateWatermarkImagePath
  } = require('../src/core/config');
  assert.ok(EXAMPLE_CONFIG_PATH && EXAMPLE_CONFIG_PATH.endsWith('config.example.yaml'));

  const sampleCfg = {
    site_name: 'Test',
    password: 'scrypt:1234:abcd',
    api_token: 'fm_secret_token_999',
    totp_secret: 'JBSWY3DPEHPK3PXP'
  };
  const sampleYaml = [
    'site_name: Test',
    'password: "scrypt:1234:abcd"',
    'api_token: "fm_secret_token_999"',
    'totp_secret: "JBSWY3DPEHPK3PXP"'
  ].join('\n');

  const redacted = redactConfigForClient(sampleCfg, sampleYaml, false);
  assert.equal(redacted.config.password, '');
  assert.equal(redacted.config.api_token, '');
  assert.equal('totp_secret' in redacted.config, false);
  assert.equal(redacted.config.hasPassword, true);
  assert.equal(redacted.config.hasApiToken, true);
  assert.equal('hasTotp' in redacted.config, false);
  assert.ok(!redacted.rawYaml.includes('scrypt:1234:abcd'));
  assert.ok(!redacted.rawYaml.includes('fm_secret_token_999'));
  assert.ok(!redacted.rawYaml.includes('JBSWY3DPEHPK3PXP'));

  const revealed = redactConfigForClient(sampleCfg, sampleYaml, true);
  assert.equal(revealed.config.password, '');
  assert.equal(revealed.config.api_token, 'fm_secret_token_999');
  assert.equal('totp_secret' in revealed.config, false);
  assert.ok(!revealed.rawYaml.includes('JBSWY3DPEHPK3PXP'));
  assert.ok(!redacted.rawYaml.includes('password:'));
  assert.ok(!redacted.rawYaml.includes('api_token:'));
  assert.ok(!revealed.rawYaml.includes('scrypt:1234:abcd'));
  for(const invalid of ['password: "fm_secret_unclosed','[not, a, mapping]','']) {
    assert.throws(()=>redactConfigForClient(sampleCfg,invalid,false),error=>{
      assert.equal(error.status,503);assert.equal(error.code,'CONFIG_INVALID');
      assert.ok(!error.message.includes('fm_secret'));
      return true;
    });
  }

  assert.equal(validateWatermarkImagePath('./watermark.png'), './watermark.png');
  assert.throws(() => validateWatermarkImagePath('../../etc/passwd'), /Invalid watermark_image path/);
});

test('Same-basename images with different extensions get isolated WebP cache paths and disambiguated lookup', () => {
  const { STORAGE_DIR } = require('../src/core/config');
  const { getWebpCacheFilePath, findRawFile } = require('../src/modules/image-host');

  const cacheJpg = getWebpCacheFilePath('2026', '10', 'photo.jpg');
  const cachePng = getWebpCacheFilePath('2026', '10', 'photo.png');
  assert.notEqual(cacheJpg, cachePng, 'photo.jpg and photo.png must not share the same WebP cache path');
  assert.ok(cacheJpg.endsWith('photo.jpg.webp'));
  assert.ok(cachePng.endsWith('photo.png.webp'));

  const monthDir = path.join(STORAGE_DIR, 'raw', '2026', '10');
  fs.mkdirSync(monthDir, { recursive: true });
  const fJpg = path.join(monthDir, 'collision_test.jpg');
  const fPng = path.join(monthDir, 'collision_test.png');
  fs.writeFileSync(fJpg, 'jpg-bytes');
  fs.writeFileSync(fPng, 'png-bytes');
  try {
    assert.equal(findRawFile('2026', '10', 'collision_test.jpg.webp'), fJpg);
    assert.equal(findRawFile('2026', '10', 'collision_test.png.webp'), fPng);
  } finally {
    if (fs.existsSync(fJpg)) fs.unlinkSync(fJpg);
    if (fs.existsSync(fPng)) fs.unlinkSync(fPng);
  }
});

test('getClientIp does not trust spoofed X-Forwarded-For when req.ip is absent', () => {
  const { getClientIp } = require('../src/core/security');
  const spoofedReq = {
    headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  assert.equal(getClientIp(spoofedReq), '127.0.0.1');
});

test('Landing page is served on root without leaking admin_path', () => {
  const indexHtmlPath = path.join(__dirname, '../src/public/index.html');
  assert.ok(fs.existsSync(indexHtmlPath), 'index.html must exist');
  const content = fs.readFileSync(indexHtmlPath, 'utf8');
  assert.ok(!content.includes('admin_path'), 'index.html must not contain admin_path references');
  assert.ok(content.includes('File Master'), 'index.html must introduce File Master');
});

test('404 page is served without leaking admin_path', () => {
  const notFoundPath = path.join(__dirname, '../src/public/404.html');
  assert.ok(fs.existsSync(notFoundPath), '404.html must exist');
  const content = fs.readFileSync(notFoundPath, 'utf8');
  assert.ok(!content.includes('admin_path'), '404.html must not contain admin_path references');
  assert.ok(content.includes('404'), '404.html must display 404');
});

test('Session revocation cache detects same-mtime file replacement via dataRevision', () => {
  const { DATA_DIR, getConfig } = require('../src/core/config');
  const { createSessionToken, verifySessionToken } = require('../src/core/security');
  const cfg = getConfig();
  const token = createSessionToken(cfg);
  const revFile = path.join(DATA_DIR, 'revoked_sessions.json');
  const original = fs.existsSync(revFile) ? fs.readFileSync(revFile, 'utf8') : null;
  try {
    fs.writeFileSync(revFile, '[]');
    const stat = fs.statSync(revFile);
    assert.ok(verifySessionToken(token, cfg));

    const replacement = path.join(DATA_DIR, 'revoked_sessions.replace.tmp');
    fs.writeFileSync(replacement, JSON.stringify([token]));
    fs.utimesSync(replacement, stat.atime, stat.mtime);
    fs.renameSync(replacement, revFile);

    assert.equal(verifySessionToken(token, cfg), false);
  } finally {
    if (original !== null) fs.writeFileSync(revFile, original);
    else fs.rmSync(revFile, { force: true });
  }
});

test('Malformed percent-encoded cookies do not throw URIError during authentication checks', () => {
  const { isAdminAuthenticated, requireAdmin, requireApiOrAdmin } = require('../src/core/security');
  const badReq = {
    headers: { cookie: 'bad=%E0%A4%A; filemaster_session=%E0%A4%A' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  assert.equal(isAdminAuthenticated(badReq), false);

  let status = 0;
  const mockRes = {
    status(c) { status = c; return this; },
    json() { return this; }
  };
  requireAdmin(badReq, mockRes, () => {});
  assert.equal(status, 401);

  status = 0;
  requireApiOrAdmin(badReq, mockRes, () => {});
  assert.equal(status, 401);
});

test('Async password verification and constant-time username comparison match expected credentials', async () => {
  const { hashPassword, verifyPasswordAsync, verifyUsername } = require('../src/core/security');
  const hashed = hashPassword('correct-horse-battery');
  assert.equal(await verifyPasswordAsync('correct-horse-battery', hashed), true);
  assert.equal(await verifyPasswordAsync('wrong-horse', hashed), false);
  assert.equal(await verifyPasswordAsync('legacy-plain', 'legacy-plain'), true);
  assert.equal(await verifyPasswordAsync('wrong-plain', 'legacy-plain'), false);

  assert.equal(verifyUsername('admin', 'admin'), true);
  assert.equal(verifyUsername(' admin ', 'admin'), true);
  assert.equal(verifyUsername('admin2', 'admin'), false);
  assert.equal(verifyUsername('', 'admin'), false);
});

test('State and audit files are created owner-only (0600)', () => {
  const { DATA_DIR, writeJsonData } = require('../src/core/config');

  writeJsonData('perm_check_tmp', { ok: true });
  const permFile = path.join(DATA_DIR, 'perm_check_tmp.json');
  try {
    if (process.platform !== 'win32') {
      const mode = fs.statSync(permFile).mode & 0o777;
      assert.equal(mode, 0o600, 'State JSON files must be written with 0600 permissions');
    }
  } finally {
    fs.rmSync(permFile, { force: true });
  }

});

test('Audit log rotation keeps only the newest rotated files', () => {
  const { DATA_DIR } = require('../src/core/config');
  const { pruneRotatedAuditLogs } = require('../src/core/audit');
  const createdLogs = [];
  try {
    for (let i = 0; i < 7; i++) {
      const p = path.join(DATA_DIR, `audit.${1000 + i}.log`);
      fs.writeFileSync(p, 'log\n');
      createdLogs.push(p);
    }
    pruneRotatedAuditLogs(5);
    const remaining = createdLogs.filter((p) => fs.existsSync(p));
    assert.equal(remaining.length, 5);
    assert.equal(fs.existsSync(createdLogs[0]), false);
    assert.equal(fs.existsSync(createdLogs[1]), false);
  } finally {
    for (const p of createdLogs) fs.rmSync(p, { force: true });
  }

});

test('Share creation rejects a symlink that escapes RAW_DIR', () => {
  const { STORAGE_DIR } = require('../src/core/config');
  const { createShareRecord } = require('../src/modules/share');
  if (process.platform !== 'win32') {
    const outsideFile = path.join(os.tmpdir(), `fm-outside-${process.pid}.png`);
    const monthDir = path.join(STORAGE_DIR, 'raw', '2026', '11');
    const symlinkPath = path.join(monthDir, 'escaped_symlink.png');
    fs.mkdirSync(monthDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'outside-secret');
    try {
      fs.rmSync(symlinkPath, { force: true });
      fs.symlinkSync(outsideFile, symlinkPath);
      assert.throws(
        () => createShareRecord({ year: '2026', month: '11', filename: 'escaped_symlink.png' }),
        /Target asset does not exist/
      );
    } finally {
      fs.rmSync(symlinkPath, { force: true });
      fs.rmSync(outsideFile, { force: true });
    }
  }
});
