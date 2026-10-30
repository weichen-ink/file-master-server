const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { UPLOAD_TMP_DIR } = require('../src/core/config');
const { SETUP_TOKEN, requireSetupToken, createSessionCookie } = require('../src/core/security');
const { acceptSingleUpload, moveFileToTrash } = require('../src/modules/image-host');

test('Gallery treats uploaded filename as data in click handlers and HTML', () => {
  const elements = new Map();
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        value: '', innerHTML: '', textContent: '', addEventListener() {},
        classList: { add() {}, remove() {} }
      });
      return elements.get(id);
    } },
    window: { addEventListener() {} },
    t: (key) => key
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/public/assets/console.js'), 'utf8');
  vm.runInContext(source.replace(/\ninitApp\(\);\s*$/, ''), context);

  const filename = "x'-alert`1`-'.png";
  context.item = {
    year: '2026', month: '10', filename, ext: 'png', size: 5,
    isImage: true, isProcessableImage: true,
    rawUrl: `/raw/2026/10/${filename}`,
    pubUrl: '/pub/2026/10/example.webp',
    rawPreviewPath: `/raw/2026/10/${filename}`
  };
  vm.runInContext('allImages = [item]; renderGallery()', context);
  const html = elements.get('galleryGrid').innerHTML;
  assert.ok(html.includes('&#39;'));
  assert.ok(!html.includes(`title="${filename}"`));

  const handler = /onclick="([^"]+)"/.exec(html)[1]
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  let opened;
  let injected = false;
  new Function('openPreview', 'alert', handler)(
    (...args) => { opened = args; },
    () => { injected = true; }
  );
  assert.deepEqual(opened, ['2026', '10', filename]);
  assert.equal(injected, false);
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

test('First-time setup requires its server-side token; HTTPS cookies are Secure', () => {
  const makeRes = () => ({
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.data = data; return this; }
  });
  let allowed = false;
  const denied = makeRes();
  requireSetupToken({ headers: {} }, denied, () => { allowed = true; });
  assert.equal(denied.statusCode, 403);
  assert.equal(allowed, false);

  requireSetupToken({ headers: { 'x-filemaster-setup-token': SETUP_TOKEN } }, makeRes(), () => { allowed = true; });
  assert.equal(allowed, true);
  assert.match(createSessionCookie({ secure: true }, 'token'), /; Secure(?:;|$)/);
  assert.doesNotMatch(createSessionCookie({ secure: false }, 'token'), /; Secure(?:;|$)/);
});
