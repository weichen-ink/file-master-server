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
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const files = getWatermarkFilesToPreserve();
  assert.ok(files.includes('wm-light.png') || files.includes('watermark.png'), 'Must include default light watermark');
  assert.ok(files.includes('wm-dark.png') || files.includes('watermark-dark.png'), 'Must include default dark watermark');

  const tempBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wm-test-'));
  const tempSourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wm-src-'));
  try {
    fs.writeFileSync(path.join(tempSourceDir, 'watermark.png'), 'wm-bytes');
    const backups = backupWatermarkFiles(tempBackupDir, tempSourceDir);
    assert.ok(backups instanceof Map, 'backupWatermarkFiles returns Map');
    assert.ok(backups.has(path.join(tempSourceDir, 'watermark.png')));
    const manifest = JSON.parse(fs.readFileSync(path.join(tempBackupDir, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(manifest.map(({ rel }) => rel), ['watermark.png']);
    assert.match(manifest[0].sha256, /^[a-f0-9]{64}$/);
    assert.strictEqual(manifest[0].diskTarget, undefined);
  } finally {
    fs.rmSync(tempBackupDir, { recursive: true, force: true });
    fs.rmSync(tempSourceDir, { recursive: true, force: true });
  }

  // Test restoration reporting
  const testMap = new Map();
  const validPath = path.join(os.tmpdir(), 'test_wm_restore.tmp');
  testMap.set(validPath, Buffer.from('test-wm-bytes'));

  try {
    const res = restoreWatermarkFiles(testMap);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.failed.length, 0);
    assert.ok(fs.existsSync(validPath));
  } finally {
    if (fs.existsSync(validPath)) fs.unlinkSync(validPath);
  }

  // Test failure reporting on invalid write path (e.g. write to a directory path)
  const failMap = new Map();
  const failDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wm-faildir-'));
  failMap.set(failDir, Buffer.from('cannot-write-directory'));
  try {
    const failRes = restoreWatermarkFiles(failMap);
    assert.strictEqual(failRes.success, false);
    assert.strictEqual(failRes.failed.length, 1);
    assert.strictEqual(failRes.failed[0].file, failDir);
  } finally {
    fs.rmSync(failDir, { recursive: true, force: true });
  }
});

test('Updater: persistent watermark disk backup survives reset or process restart', () => {
  const {
    backupWatermarkFiles,
    restoreWatermarkFiles
  } = require('../src/core/updater');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-root-test-'));
  const customWmPath = path.join(tempRootDir, 'watermark.png');
  const testBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wm-test-'));

  try {
    const dummyBytes = Buffer.from('persistent-watermark-bytes-12345');
    fs.writeFileSync(customWmPath, dummyBytes);

    // 1. Back up watermarks to isolated test directory from tempRootDir
    const backups = backupWatermarkFiles(testBackupDir, tempRootDir);
    assert.ok(backups.has(customWmPath));

    // Verify disk backup exists in testBackupDir
    const diskBackup = path.join(testBackupDir, 'watermark.png');
    assert.ok(fs.existsSync(diskBackup), 'Disk backup file must exist in test directory');
    assert.deepStrictEqual(fs.readFileSync(diskBackup), dummyBytes);

    // 2. Simulate git reset --hard wiping the file
    fs.writeFileSync(customWmPath, Buffer.from('upstream-clobbered-bytes'));

    // 3. Simulate process restart where in-memory Map is lost (pass null with isolated backup dir and target root)
    const restoreRes = restoreWatermarkFiles(null, testBackupDir, tempRootDir);
    assert.strictEqual(restoreRes.success, true);
    assert.deepStrictEqual(fs.readFileSync(customWmPath), dummyBytes, 'Watermark must be restored from disk backup');

    fs.writeFileSync(diskBackup, Buffer.alloc(dummyBytes.length, 0x78));
    const corruptRes = restoreWatermarkFiles(null, testBackupDir, tempRootDir);
    assert.strictEqual(corruptRes.success, false, 'Same-size corrupt backups must be rejected');
    assert.deepStrictEqual(fs.readFileSync(customWmPath), dummyBytes);
  } finally {
    try {
      fs.rmSync(tempRootDir, { recursive: true, force: true });
      fs.rmSync(testBackupDir, { recursive: true, force: true });
    } catch {}
  }
});

test('Updater: distinct watermark paths remain distinct in disk backups', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { getConfig, setConfigOverride } = require('../src/core/config');
  const { backupWatermarkFiles, restoreWatermarkFiles } = require('../src/core/updater');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wm-paths-'));
  const source = path.join(tempDir, 'source');
  const backup = path.join(tempDir, 'backup');
  const target = path.join(tempDir, 'target');
  const cfg = getConfig();

  try {
    setConfigOverride({
      ...cfg,
      image_host: {
        ...cfg.image_host,
        watermark_image: 'assets/a_b.png',
        watermark_image_dark: 'assets/a/b.png'
      }
    });
    fs.mkdirSync(path.join(source, 'assets', 'a'), { recursive: true });
    fs.writeFileSync(path.join(source, 'assets', 'a_b.png'), 'light');
    fs.writeFileSync(path.join(source, 'assets', 'a', 'b.png'), 'dark');

    backupWatermarkFiles(backup, source);
    assert.equal(fs.readFileSync(path.join(backup, 'assets', 'a_b.png'), 'utf8'), 'light');
    assert.equal(fs.readFileSync(path.join(backup, 'assets', 'a', 'b.png'), 'utf8'), 'dark');

    const result = restoreWatermarkFiles(null, backup, target);
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(target, 'assets', 'a_b.png'), 'utf8'), 'light');
    assert.equal(fs.readFileSync(path.join(target, 'assets', 'a', 'b.png'), 'utf8'), 'dark');
  } finally {
    setConfigOverride(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Updater: previous size-only manifests remain recoverable', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { getConfig, setConfigOverride } = require('../src/core/config');
  const { restoreWatermarkFiles } = require('../src/core/updater');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wm-legacy-'));
  const backup = path.join(tempDir, 'backup');
  const target = path.join(tempDir, 'target');
  const cfg = getConfig();

  try {
    setConfigOverride({
      ...cfg,
      image_host: {
        ...cfg.image_host,
        watermark_image: './watermark.png',
        watermark_image_dark: './watermark-dark.png'
      }
    });
    fs.mkdirSync(backup);
    fs.writeFileSync(path.join(backup, 'watermark.png'), 'legacy');
    fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify([
      { rel: 'watermark.png', diskTarget: '/obsolete/path', size: 6 }
    ]));
    const result = restoreWatermarkFiles(null, backup, target);
    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(path.join(target, 'watermark.png'), 'utf8'), 'legacy');

    fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify([
      { rel: '../outside.png', sha256: 'a'.repeat(64) }
    ]));
    assert.equal(restoreWatermarkFiles(null, backup, target).success, false);
    assert.equal(fs.existsSync(path.join(tempDir, 'outside.png')), false);

    fs.unlinkSync(path.join(backup, 'manifest.json'));
    assert.equal(restoreWatermarkFiles(null, backup, target).success, true, 'new optional watermark names must not invalidate a legacy backup');
    fs.unlinkSync(path.join(backup, 'watermark.png'));
    assert.equal(restoreWatermarkFiles(null, backup, target).success, false, 'an empty legacy backup must fail');
    fs.writeFileSync(path.join(backup, 'watermark.png'), 'legacy');
    fs.writeFileSync(path.join(backup, 'watermark-dark.png'), 'dark');
    assert.equal(restoreWatermarkFiles(null, backup, target).success, true);
  } finally {
    setConfigOverride(null);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Updater: recoverInterruptedUpdate preserves flag on failure and clears on complete recovery', () => {
  const {
    recoverInterruptedUpdate
  } = require('../src/core/updater');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-recover-test-'));
  const pendingFile = path.join(tempDir, 'update_pending_restore.flag');
  const configBackup = path.join(tempDir, 'config.backup.yaml');
  const configPath = path.join(tempDir, 'config.yaml');
  const backupDir = path.join(tempDir, 'wm-backup');
  const targetRootDir = path.join(tempDir, 'root');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(targetRootDir, { recursive: true });

  try {
    fs.writeFileSync(pendingFile, 'interrupted', 'utf8');

    // Case 1: config backup is missing -> recovery fails, flag is preserved for retry
    const res1 = recoverInterruptedUpdate({
      pendingFile,
      configBackup,
      configPath,
      backupDir,
      targetRootDir
    });
    assert.strictEqual(res1.success, false);
    assert.strictEqual(fs.existsSync(pendingFile), true, 'Flag must be preserved when config backup missing');

    // Case 2: No watermark backup exists -> recovery fails, flag is preserved
    fs.writeFileSync(configBackup, 'port: 3000\n', 'utf8');
    const noBackupRes = recoverInterruptedUpdate({
      pendingFile,
      configBackup,
      configPath,
      backupDir,
      targetRootDir
    });
    assert.strictEqual(noBackupRes.success, false);
    assert.strictEqual(fs.existsSync(pendingFile), true);

    // Case 3: A missing file listed in the manifest also preserves the flag
    const crypto = require('node:crypto');
    fs.writeFileSync(
      path.join(backupDir, 'manifest.json'),
      JSON.stringify([{
        rel: 'watermark.png',
        sha256: crypto.createHash('sha256').update('wm-bytes').digest('hex')
      }]),
      'utf8'
    );
    const res2 = recoverInterruptedUpdate({
      pendingFile,
      configBackup,
      configPath,
      backupDir,
      targetRootDir
    });
    assert.strictEqual(res2.success, false);
    assert.strictEqual(fs.existsSync(pendingFile), true, 'Flag must be preserved when wm restore fails');

    // Case 4: Complete backup restores both files and clears the flag
    fs.writeFileSync(path.join(backupDir, 'watermark.png'), 'wm-bytes');
    const res3 = recoverInterruptedUpdate({
      pendingFile,
      configBackup,
      configPath,
      backupDir,
      targetRootDir
    });
    assert.strictEqual(res3.success, true);
    assert.strictEqual(fs.existsSync(pendingFile), false, 'Pending flag must be cleared on success');
    assert.strictEqual(fs.existsSync(configBackup), false, 'Config backup must be removed on success');
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), 'port: 3000\n');
    assert.strictEqual(fs.readFileSync(path.join(targetRootDir, 'watermark.png'), 'utf8'), 'wm-bytes');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Updater: updateInProgress lock releases properly and is not permanently held on error', async () => {
  const {
    isUpdateInProgress,
    performHotUpdate,
    WM_BACKUP_DIR
  } = require('../src/core/updater');
  const fs = require('node:fs');
  const mkdirSync = fs.mkdirSync;

  assert.strictEqual(isUpdateInProgress(), false, 'Lock must be false initially');

  fs.mkdirSync = function (dir, ...args) {
    if (dir === WM_BACKUP_DIR) throw new Error('simulated backup failure');
    return mkdirSync.call(this, dir, ...args);
  };
  try {
    await assert.rejects(performHotUpdate(), /simulated backup failure/);
    assert.strictEqual(isUpdateInProgress(), false, 'Backup failure must release the lock');
    await assert.rejects(performHotUpdate(), /simulated backup failure/);
  } finally {
    fs.mkdirSync = mkdirSync;
  }
});
