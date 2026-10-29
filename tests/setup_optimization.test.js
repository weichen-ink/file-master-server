const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CONFIG_PATH,
  isConfigInitialized,
  initializeConfigFromSetup,
  getConfig,
  updateConfigPreservingComments
} = require('../src/core/config');
const { verifyPassword } = require('../src/core/security');

test('Setup Wizard & Image Optimization: uninitialized mode, setup flow, and optimization switch', () => {
  const backupPath = `${CONFIG_PATH}.test_backup`;
  const hadConfig = fs.existsSync(CONFIG_PATH);
  if (hadConfig) {
    fs.renameSync(CONFIG_PATH, backupPath);
  }

  try {
    // 1. Uninitialized state should not write config.yaml automatically
    assert.strictEqual(isConfigInitialized(), false, 'Should be uninitialized when config.yaml is absent');
    const uninitCfg = getConfig();
    assert.strictEqual(uninitCfg.needsSetup, true, 'getConfig() should report needsSetup: true');
    assert.strictEqual(uninitCfg.admin_path, 'admin', 'Default admin_path should be clean "admin"');
    assert.strictEqual(uninitCfg.image_host.raw_secret_path, 'raw', 'Default raw path should be "raw"');
    assert.strictEqual(uninitCfg.image_host.enable_optimization, true, 'Default enable_optimization should be true');
    assert.strictEqual(fs.existsSync(CONFIG_PATH), false, 'getConfig() must not silently create config.yaml');

    // 2. Empty password should be rejected by setup wizard
    assert.throws(
      () => initializeConfigFromSetup({ username: 'admin', password: '' }),
      /Password cannot be empty/,
      'Empty password should be rejected'
    );

    // 3. Complete setup with custom credentials and optimization disabled
    const createdCfg = initializeConfigFromSetup({
      site_name: 'Weichen Image Host',
      port: 3000,
      base_url: 'http://localhost:3000',
      admin_path: 'admin',
      username: 'weichen',
      password: 'custom-user-pass-123',
      api_token: 'fm_custom_token_abc',
      raw_secret_path: 'raw',
      enable_optimization: false
    });

    assert.strictEqual(isConfigInitialized(), true, 'Should be initialized after setup');
    assert.strictEqual(createdCfg.needsSetup, false);
    assert.strictEqual(createdCfg.site_name, 'Weichen Image Host');
    assert.strictEqual(createdCfg.username, 'weichen');
    assert.ok(createdCfg.password.startsWith('scrypt:'), 'Password must be hashed with scrypt');
    assert.strictEqual(verifyPassword('custom-user-pass-123', createdCfg.password), true);
    assert.strictEqual(createdCfg.image_host.enable_optimization, false, 'enable_optimization should be false');

    // 4. Re-running setup when already initialized must be blocked
    assert.throws(
      () => initializeConfigFromSetup({ username: 'hacker', password: '123' }),
      /Server is already initialized/,
      'Repeated setup calls must be rejected'
    );

    // 5. Toggling enable_optimization via settings update
    const updatedCfg = updateConfigPreservingComments({
      image_host: { enable_optimization: true }
    });
    assert.strictEqual(updatedCfg.image_host.enable_optimization, true, 'Should toggle enable_optimization to true');
  } finally {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.unlinkSync(CONFIG_PATH);
    }
    if (hadConfig && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, CONFIG_PATH);
    }
  }
});

test('Share Module: creates expiring share records with download limits and prevents path traversal', () => {
  const { STORAGE_DIR, writeJsonData } = require('../src/core/config');
  const { createShareRecord, getSharesMap } = require('../src/modules/share');

  const testDir = path.join(STORAGE_DIR, 'raw', '2026', '10');
  fs.mkdirSync(testDir, { recursive: true });
  const testFile = path.join(testDir, 'share_test_sample.png');
  fs.writeFileSync(testFile, Buffer.from('sample-image-bytes'));

  try {
    const rec = createShareRecord({
      year: '2026',
      month: '10',
      filename: 'share_test_sample.png',
      expiresInHours: 12,
      maxDownloads: 5
    });

    assert.ok(rec.id && rec.id.length >= 8, 'Share ID must be generated');
    assert.strictEqual(rec.filename, 'share_test_sample.png');
    assert.strictEqual(rec.maxDownloads, 5);
    assert.strictEqual(rec.downloads, 0);
    assert.ok(rec.expiresAt > Date.now(), 'Expiration timestamp must be in the future');

    const map = getSharesMap();
    assert.ok(map[rec.id], 'Share record must be persisted in shares.json');

    // Clean up test share entry
    delete map[rec.id];
    writeJsonData('shares', map);
  } finally {
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});


