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
