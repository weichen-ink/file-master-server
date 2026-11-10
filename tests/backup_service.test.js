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

test('backup-scheduler supports daily, every_12h, every_6h, hourly, weekly, and cron', () => {
  const { shouldTriggerBackup } = require('../src/core/backup-scheduler');

  // 1. Daily
  const dNow1 = new Date('2026-11-11T03:00:00');
  const dNow2 = new Date('2026-11-11T04:00:00');
  const dailyRes = shouldTriggerBackup({ enabled: true, frequency: 'daily', schedule: '03:00' }, dNow1);
  assert.equal(dailyRes.shouldTrigger, true);
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'daily', schedule: '03:00' }, dNow2).shouldTrigger, false);

  // 2. Every 12h
  const h12_1 = new Date('2026-11-11T03:00:00');
  const h12_2 = new Date('2026-11-11T15:00:00');
  const h12_3 = new Date('2026-11-11T06:00:00');
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'every_12h', schedule: '03:00' }, h12_1).shouldTrigger, true);
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'every_12h', schedule: '03:00' }, h12_2).shouldTrigger, true);
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'every_12h', schedule: '03:00' }, h12_3).shouldTrigger, false);

  // 3. Every 6h
  const h6_1 = new Date('2026-11-11T00:00:00');
  const h6_2 = new Date('2026-11-11T06:00:00');
  const h6_3 = new Date('2026-11-11T08:00:00');
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'every_6h', schedule: '00:00' }, h6_1).shouldTrigger, true);
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'every_6h', schedule: '00:00' }, h6_2).shouldTrigger, true);
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'every_6h', schedule: '00:00' }, h6_3).shouldTrigger, false);

  // 4. Hourly
  const h1 = new Date('2026-11-11T14:15:00');
  const h2 = new Date('2026-11-11T14:16:00');
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'hourly', schedule: '00:15' }, h1).shouldTrigger, true);
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'hourly', schedule: '00:15' }, h2).shouldTrigger, false);

  // 5. Weekly (Sunday = 0)
  const sunday = new Date('2026-11-15T03:00:00'); // Nov 15, 2026 is Sunday
  const monday = new Date('2026-11-16T03:00:00');
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'weekly', weekday: 0, schedule: '03:00' }, sunday).shouldTrigger, true);
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'weekly', weekday: 0, schedule: '03:00' }, monday).shouldTrigger, false);

  // 6. Monthly (e.g. 1st of month)
  const m1 = new Date('2026-11-01T03:00:00');
  const m2 = new Date('2026-11-02T03:00:00');
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'monthly', monthday: 1, schedule: '03:00' }, m1).shouldTrigger, true);
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'monthly', monthday: 1, schedule: '03:00' }, m2).shouldTrigger, false);

  // 7. Interval 2 days / 3 days
  const now = new Date('2026-11-11T03:00:00');
  const daysEpoch = Math.floor(now.getTime() / 86400000);
  const expected2d = (daysEpoch % 2 === 0);
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'interval_2d', schedule: '03:00' }, now).shouldTrigger, expected2d);

  // 8. Cron
  const cronMatch = new Date('2026-11-11T02:30:00');
  const cronMismatch = new Date('2026-11-11T02:31:00');
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'cron', cron_expression: '30 2 * * *' }, cronMatch).shouldTrigger, true);
  assert.equal(shouldTriggerBackup({ enabled: true, frequency: 'cron', cron_expression: '30 2 * * *' }, cronMismatch).shouldTrigger, false);
});

