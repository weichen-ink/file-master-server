const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  performBackup,
  resolveBackupDir,
  getBackupStatus,
  sendBarkNotification
} = require('../src/core/backup-service');
const { ROOT_DIR, DATA_DIR, getConfig, setConfigOverride } = require('../src/core/config');

test('resolveBackupDir handles absolute and relative paths', () => {
  const defaultDir = resolveBackupDir();
  assert.equal(defaultDir, path.join(DATA_DIR, 'backups'));

  const relativeDir = resolveBackupDir('./custom_backups');
  assert.equal(relativeDir, path.resolve(ROOT_DIR, './custom_backups'));

  const absDir = resolveBackupDir('/tmp/my_backups');
  assert.equal(absDir, path.normalize('/tmp/my_backups'));
});

test('sendBarkNotification returns skipped when no URL is provided', async () => {
  const res = await sendBarkNotification({ barkUrl: '', title: 'Test', body: 'Body' });
  assert.equal(res.skipped, true);
});

test('performBackup executes full archive, applies local retention and records status', async () => {
  const tmpBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-backup-test-'));
  const originalCfg = getConfig();

  try {
    setConfigOverride({
      ...originalCfg,
      backup: {
        enabled: true,
        retention: 2,
        local_dir: tmpBackupDir,
        rclone_target: '',
        bark_url: ''
      }
    });

    // Run first backup
    const b1 = await performBackup({ manual: true });
    assert.equal(b1.success, true);
    assert.ok(fs.existsSync(b1.archivePath));
    assert.ok(b1.archiveSize > 0);

    // Run second backup (with a slight delay to ensure distinct timestamp)
    await new Promise((r) => setTimeout(r, 1100));
    const b2 = await performBackup({ manual: true });
    assert.equal(b2.success, true);
    assert.ok(fs.existsSync(b2.archivePath));

    // Run third backup (retention is 2, so the oldest should be rotated out)
    await new Promise((r) => setTimeout(r, 1100));
    const b3 = await performBackup({ manual: true });
    assert.equal(b3.success, true);
    assert.ok(fs.existsSync(b3.archivePath));

    const filesInDir = fs.readdirSync(tmpBackupDir).filter((f) => f.endsWith('.tar.gz'));
    assert.equal(filesInDir.length, 2, 'Should retain exactly 2 archives');
    assert.equal(filesInDir.includes(path.basename(b1.archivePath)), false, 'First archive should be removed');
    assert.equal(filesInDir.includes(path.basename(b2.archivePath)), true);
    assert.equal(filesInDir.includes(path.basename(b3.archivePath)), true);

    const status = getBackupStatus();
    assert.equal(status.config.retention, 2);
    assert.equal(status.lastBackup.success, true);
    assert.equal(status.localBackupsCount, 2);
  } finally {
    setConfigOverride(null);
    fs.rmSync(tmpBackupDir, { recursive: true, force: true });
  }
});

