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

  // Invalid protocols or suspicious characters
  assert.equal(validateGitMirror('file:///etc/passwd'), false);
  assert.equal(validateGitMirror('javascript:alert(1)'), false);
  assert.equal(validateGitMirror('ssh://git@github.com'), false);
  assert.equal(validateGitMirror('https://ghproxy.net; rm -rf /'), false);
  assert.equal(validateGitMirror('https://ghproxy.net && whoami'), false);
  assert.equal(validateGitMirror('not-a-valid-url'), false);
});
