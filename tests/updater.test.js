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
  assert.ok(files.includes('watermark.png'), 'Must include default light watermark');
  assert.ok(files.includes('watermark-dark.png'), 'Must include default dark watermark');

  const tempBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wm-test-'));
  const tempSourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-wm-src-'));
  try {
    fs.writeFileSync(path.join(tempSourceDir, 'watermark.png'), 'wm-bytes');
    const backups = backupWatermarkFiles(tempBackupDir, tempSourceDir);
    assert.ok(backups instanceof Map, 'backupWatermarkFiles returns Map');
    assert.ok(backups.has(path.join(tempSourceDir, 'watermark.png')));
    assert.ok(fs.existsSync(path.join(tempBackupDir, 'manifest.json')));
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
  } finally {
    try {
      fs.rmSync(tempRootDir, { recursive: true, force: true });
      fs.rmSync(testBackupDir, { recursive: true, force: true });
    } catch {}
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

    // Case 2: Watermark restoration fails -> recovery fails, flag is preserved
    fs.writeFileSync(configBackup, 'port: 3000\n', 'utf8');
    // Write manifest with a non-existent backup file to trigger wm failure
    fs.writeFileSync(
      path.join(backupDir, 'manifest.json'),
      JSON.stringify([{ rel: 'watermark.png', diskTarget: path.join(backupDir, 'nonexistent.png') }]),
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

    // Case 3: Watermark backup file exists -> recovery succeeds, flag & backup cleared, config restored
    fs.writeFileSync(path.join(backupDir, 'nonexistent.png'), 'wm-bytes');
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
    performHotUpdate
  } = require('../src/core/updater');

  assert.strictEqual(isUpdateInProgress(), false, 'Lock must be false initially');

  // Trigger error before or during update flow (invalid branch with characters that fail validation)
  await assert.rejects(
    async () => {
      await performHotUpdate({ upstream_branch: 'invalid branch with space!' });
    },
    /Invalid upstream branch name format/
  );

  // Lock must be released
  assert.strictEqual(isUpdateInProgress(), false, 'Lock must be false after failed update attempt');
});
