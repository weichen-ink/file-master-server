const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  performBackup,
  resolveBackupDir,
  getBackupStatus,
  getBackupMonitorState,
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
    assert.equal(getBackupMonitorState().lastSuccessAt,b3.completedAt);
    const blockedDir=path.join(tmpBackupDir,'blocked');
    fs.writeFileSync(blockedDir,'not a directory');
    setConfigOverride({...getConfig(),backup:{...getConfig().backup,local_dir:blockedDir}});
    await assert.rejects(performBackup({manual:true}));
    assert.equal(getBackupMonitorState().status,'failed');
    assert.equal(getBackupMonitorState().lastSuccessAt,b3.completedAt,'A failed backup must preserve the previous success');
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


test('Backup forecast uses scheduler semantics and server timezone without changing the schedule', () => {
  const { forecastBackup, shouldTriggerBackup } = require('../src/core/backup-schedule');
  const now = new Date(2026, 10, 11, 2, 30, 0);
  const daily = {enabled:true, frequency:'daily', schedule:'03:00'};
  const forecast = forecastBackup(daily, now);
  assert.equal(forecast.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(new Date(forecast.nextRunAt).getHours(), 3);
  assert.equal(new Date(forecast.nextRunAt).getMinutes(), 0);
  assert.equal(shouldTriggerBackup(daily, new Date(forecast.nextRunAt)).shouldTrigger, true);
  const weekly = {...daily, frequency:'weekly', weekday:0};
  const next = new Date(forecastBackup(weekly, now).nextRunAt);
  assert.equal(next.getDay(), 0);
  assert.equal(shouldTriggerBackup(weekly, next).shouldTrigger, true);
  assert.equal(forecastBackup({...daily, enabled:false}, now).nextRunAt, null);
  assert.deepEqual(daily, {enabled:true, frequency:'daily', schedule:'03:00'});
});

test('performBackup excludes custom local_dir inside data so previous archives are not nested', async () => {
  const { execFileSync } = require('node:child_process');
  const { performBackup } = require('../src/core/backup-service');
  const { DATA_DIR, getConfig, setConfigOverride } = require('../src/core/config');
  const customDir = path.join(DATA_DIR, 'custom-backups-test');
  fs.rmSync(customDir, { recursive: true, force: true });
  fs.mkdirSync(customDir, { recursive: true });
  const sentinelArchive = path.join(customDir, 'filemaster-full-20200101-000000.tar.gz');
  fs.writeFileSync(sentinelArchive, 'sentinel');

  try {
    setConfigOverride({
      ...getConfig(),
      backup: { ...getConfig().backup, enabled: false, local_dir: './data/custom-backups-test', retention: 5, rclone_target: '', bark_url: '' }
    });
    const res = await performBackup({ manual: true });
    assert.equal(res.success, true);
    const listOut = execFileSync('tar', ['-tzf', res.archivePath], { encoding: 'utf8' });
    assert.equal(listOut.includes('custom-backups-test'), false, 'Custom local_dir must not be archived recursively');
  } finally {
    setConfigOverride(null);
    fs.rmSync(customDir, { recursive: true, force: true });
  }
});

test('performBackup snapshots watermark files matching the queued config.yaml version', async () => {
  const { execFileSync } = require('node:child_process');
  const { performBackup } = require('../src/core/backup-service');
  const { ROOT_DIR, CONFIG_PATH, getConfig, setConfigOverride } = require('../src/core/config');
  const { mutateAssets } = require('../src/modules/image-host/mutation-queue');
  const os = require('node:os');

  const tmpBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-backup-wm-'));
  const wmBefore = path.join(ROOT_DIR, 'custom-wm-before-test.png');
  const wmAfter = path.join(ROOT_DIR, 'custom-wm-after-test.png');
  const hadConfig = fs.existsSync(CONFIG_PATH);
  const origConfig = hadConfig ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;
  fs.writeFileSync(wmBefore, 'before');
  fs.writeFileSync(wmAfter, 'after');

  try {
    setConfigOverride({
      ...getConfig(),
      backup: { ...getConfig().backup, enabled: false, local_dir: tmpBackupDir, retention: 2, rclone_target: '', bark_url: '' },
      image_host: { ...getConfig().image_host, watermark_image: './custom-wm-before-test.png' }
    });
    fs.writeFileSync(CONFIG_PATH, 'image_host:\n  watermark_image: ./custom-wm-before-test.png\n', 'utf8');

    let releaseQueue;
    const queueGate = new Promise((r) => { releaseQueue = r; });
    const queuedChange = mutateAssets(async () => {
      await queueGate;
      fs.writeFileSync(CONFIG_PATH, 'image_host:\n  watermark_image: ./custom-wm-after-test.png\n', 'utf8');
    });

    const backupPromise = performBackup({ manual: true });
    releaseQueue();
    await queuedChange;
    const res = await backupPromise;

    const listOut = execFileSync('tar', ['-tzf', res.archivePath], { encoding: 'utf8' });
    assert.ok(listOut.includes('custom-wm-after-test.png'), 'Archive must include watermark matching archived config.yaml');
  } finally {
    setConfigOverride(null);
    fs.rmSync(wmBefore, { force: true });
    fs.rmSync(wmAfter, { force: true });
    fs.rmSync(tmpBackupDir, { recursive: true, force: true });
    if (hadConfig) fs.writeFileSync(CONFIG_PATH, origConfig, 'utf8');
    else fs.rmSync(CONFIG_PATH, { force: true });
  }
});
