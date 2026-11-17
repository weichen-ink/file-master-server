const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

assert.equal(process.env.FILE_MASTER_TEST_ROOT, fs.realpathSync(path.resolve(__dirname, '..')),
  'Run npm test: permissions tests require an isolated project');

test('Existing private files and reused temporary files are tightened on POSIX', { skip: process.platform === 'win32' }, () => {
  const config = require('../src/core/config');
  config.initializeConfigFromSetup({ username: 'test', password: 'test-only-password' });
  const mode = file => fs.statSync(file).mode & 0o777;
  fs.chmodSync(config.CONFIG_PATH, 0o644);
  assert.equal(config.getConfig().username, 'test');
  assert.equal(mode(config.CONFIG_PATH), 0o600);
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  for (const name of ['security_meta', 'revoked_sessions']) {
    const file = path.join(config.DATA_DIR, name + '.json');
    fs.writeFileSync(file, '{}'); fs.chmodSync(file, 0o644);
    assert.deepEqual(config.readCriticalJsonData(name, null), {});
    assert.equal(mode(file), 0o600);
  }
  const temp = path.join(config.DATA_DIR, 'private-test.json.tmp');
  fs.writeFileSync(temp, 'stale'); fs.chmodSync(temp, 0o644);
  config.writeJsonData('private-test', { saved: true });
  assert.equal(mode(path.join(config.DATA_DIR, 'private-test.json')), 0o600);
  assert.deepEqual(config.readCriticalJsonData('private-test', null), { saved: true });
  const configTemp = config.CONFIG_PATH + '.tmp';
  fs.writeFileSync(configTemp, 'stale'); fs.chmodSync(configTemp, 0o644);
  config.updateConfigPreservingComments({ site_name: 'saved' });
  assert.equal(mode(config.CONFIG_PATH), 0o600);
  const audit = require('../src/core/audit');
  const rotated = path.join(config.DATA_DIR, 'audit.1000.log');
  for (const file of [audit.AUDIT_LOG_FILE, rotated]) {
    fs.writeFileSync(file, 'old\n'); fs.chmodSync(file, 0o644);
  }
  audit.appendAuditLog({ action: 'permission-test' });
  for (const file of [audit.AUDIT_LOG_FILE, rotated]) assert.equal(mode(file), 0o600);
  assert.match(fs.readFileSync(audit.AUDIT_LOG_FILE, 'utf8'), /permission-test/);
});

test('Symlink temporary paths cannot overwrite or chmod another file', { skip: process.platform === 'win32' }, () => {
  const { DATA_DIR, writeJsonData } = require('../src/core/config');
  const { ensurePrivateFile } = require('../src/core/private-files');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = path.join(DATA_DIR, 'unchanged.txt');
  fs.writeFileSync(target, 'keep me'); fs.chmodSync(target, 0o644);
  const link = path.join(DATA_DIR, 'linked.json.tmp');
  fs.symlinkSync(target, link);
  assert.throws(() => writeJsonData('linked', { changed: true }));
  assert.throws(() => ensurePrivateFile(link));
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep me');
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  assert.equal(fs.existsSync(path.join(DATA_DIR, 'linked.json')), false);
});

test('Permission failures surface before existing private contents are truncated', { skip: process.platform === 'win32' }, () => {
  const { writePrivateFile } = require('../src/core/private-files');
  const { DATA_DIR } = require('../src/core/config');
  const file = path.join(DATA_DIR, 'chmod-failure.txt');
  fs.writeFileSync(file, 'keep me'); fs.chmodSync(file, 0o644);
  const chmod = fs.fchmodSync;
  fs.fchmodSync = () => { throw new Error('simulated chmod failure'); };
  try { assert.throws(() => writePrivateFile(file, 'replacement'), /chmod failure/); }
  finally { fs.fchmodSync = chmod; }
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep me');
});
