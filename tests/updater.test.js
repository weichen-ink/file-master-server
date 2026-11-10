const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OFFICIAL_UPSTREAM_REPO,
  getEffectiveUpstreamRepo,
  validateGitMirror
} = require('../src/core/updater');

test('Updater: locks upstream repo to official GitHub repository', () => {
  assert.equal(OFFICIAL_UPSTREAM_REPO, 'https://github.com/weichen-ink/file-master-server.git');
  
  // Direct official repo when no mirror
  assert.equal(getEffectiveUpstreamRepo(), OFFICIAL_UPSTREAM_REPO);
  assert.equal(getEffectiveUpstreamRepo(''), OFFICIAL_UPSTREAM_REPO);
  assert.equal(getEffectiveUpstreamRepo('   '), OFFICIAL_UPSTREAM_REPO);
});

test('Updater: prefixes valid GitHub mirror accelerators', () => {
  // ghproxy format: https://ghproxy.net/https://github.com/...
  assert.equal(
    getEffectiveUpstreamRepo('https://ghproxy.net'),
    'https://ghproxy.net/https://github.com/weichen-ink/file-master-server.git'
  );
  // Strips trailing slashes from mirror prefix
  assert.equal(
    getEffectiveUpstreamRepo('https://ghproxy.net///'),
    'https://ghproxy.net/https://github.com/weichen-ink/file-master-server.git'
  );
});

test('Updater: validates git mirror URLs for safety', () => {
  assert.equal(validateGitMirror(''), true);
  assert.equal(validateGitMirror(null), true);
  assert.equal(validateGitMirror('https://ghproxy.net'), true);
  assert.equal(validateGitMirror('https://gh-proxy.com/'), true);
  assert.equal(validateGitMirror('http://mirror.internal.lan:8080'), true);

  // Invalid protocols, deceptive repo mirrors, or suspicious characters
  assert.equal(validateGitMirror('file:///etc/passwd'), false);
  assert.equal(validateGitMirror('javascript:alert(1)'), false);
  assert.equal(validateGitMirror('ssh://git@github.com'), false);
  assert.equal(validateGitMirror('https://ghproxy.net; rm -rf /'), false);
  assert.equal(validateGitMirror('https://ghproxy.net && whoami'), false);
  assert.equal(validateGitMirror('not-a-valid-url'), false);
  assert.equal(validateGitMirror('https://evil.example.com/weichen-ink/file-master-server.git'), false);
  assert.equal(
    getEffectiveUpstreamRepo('https://evil.example.com/weichen-ink/file-master-server.git'),
    OFFICIAL_UPSTREAM_REPO
  );
});

test('Updater: preserves, backs up, and restores dual watermark files with error tracking', () => {
  const {
    getWatermarkFilesToPreserve,
    backupWatermarkFiles,
    restoreWatermarkFiles
  } = require('../src/core/updater');

  const files = getWatermarkFilesToPreserve();
  assert.ok(files.includes('watermark.png'), 'Must include default light watermark');
  assert.ok(files.includes('watermark-dark.png'), 'Must include default dark watermark');

  const backups = backupWatermarkFiles();
  assert.ok(backups instanceof Map, 'backupWatermarkFiles returns Map');

  // Test restoration reporting
  const testMap = new Map();
  const validPath = require('path').join(__dirname, 'test_wm_restore.tmp');
  testMap.set(validPath, Buffer.from('test-wm-bytes'));

  try {
    const res = restoreWatermarkFiles(testMap);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.failed.length, 0);
    assert.ok(require('fs').existsSync(validPath));
  } finally {
    if (require('fs').existsSync(validPath)) require('fs').unlinkSync(validPath);
  }

  // Test failure reporting on invalid write path (e.g. write to a directory path)
  const failMap = new Map();
  failMap.set(__dirname, Buffer.from('cannot-write-directory'));
  const failRes = restoreWatermarkFiles(failMap);
  assert.strictEqual(failRes.success, false);
  assert.strictEqual(failRes.failed.length, 1);
  assert.strictEqual(failRes.failed[0].file, __dirname);
});

test('Updater: persistent watermark disk backup survives reset or process restart', () => {
  const {
    backupWatermarkFiles,
    restoreWatermarkFiles
  } = require('../src/core/updater');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const rootDir = path.resolve(__dirname, '..');
  const customWmPath = path.join(rootDir, 'watermark.png');
  const originalBytes = fs.existsSync(customWmPath) ? fs.readFileSync(customWmPath) : null;
  const testBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wm-test-'));

  try {
    const dummyBytes = Buffer.from('persistent-watermark-bytes-12345');
    fs.writeFileSync(customWmPath, dummyBytes);

    // 1. Back up watermarks to isolated test directory
    const backups = backupWatermarkFiles(testBackupDir);
    assert.ok(backups.has(customWmPath));

    // Verify disk backup exists in testBackupDir
    const diskBackup = path.join(testBackupDir, 'watermark.png');
    assert.ok(fs.existsSync(diskBackup), 'Disk backup file must exist in test directory');
    assert.deepStrictEqual(fs.readFileSync(diskBackup), dummyBytes);

    // 2. Simulate git reset --hard wiping the file
    fs.writeFileSync(customWmPath, Buffer.from('upstream-clobbered-bytes'));

    // 3. Simulate process restart where in-memory Map is lost (pass null with isolated backup dir)
    const restoreRes = restoreWatermarkFiles(null, testBackupDir);
    assert.strictEqual(restoreRes.success, true);
    assert.deepStrictEqual(fs.readFileSync(customWmPath), dummyBytes, 'Watermark must be restored from disk backup');
  } finally {
    if (originalBytes) {
      fs.writeFileSync(customWmPath, originalBytes);
    }
    try {
      fs.rmSync(testBackupDir, { recursive: true, force: true });
    } catch {}
  }
});

test('Updater: recoverInterruptedUpdate restores watermarks and clears pending flag', () => {
  const {
    recoverInterruptedUpdate
  } = require('../src/core/updater');
  const { DATA_DIR } = require('../src/core/config');
  const fs = require('fs');
  const path = require('path');

  const flagPath = path.join(DATA_DIR, 'update_pending_restore.flag');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(flagPath, 'interrupted', 'utf8');

  try {
    recoverInterruptedUpdate();
    assert.strictEqual(fs.existsSync(flagPath), false, 'Pending flag must be cleared after recovery');
  } finally {
    if (fs.existsSync(flagPath)) fs.unlinkSync(flagPath);
  }
});
