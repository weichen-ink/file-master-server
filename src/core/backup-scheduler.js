const { getConfig } = require('./config');
const { performBackup, isBackupInProgress } = require('./backup-service');

let timer = null;
let lastExecutionKey = '';

const { matchCronField, shouldTriggerBackup } = require('./backup-schedule');

function startBackupScheduler() {
  if (timer) return;

  // Check every 30 seconds
  timer = setInterval(async () => {
    try {
      const cfg = getConfig();
      const backupCfg = cfg.backup || {};
      if (backupCfg.enabled === false) return;
      if (isBackupInProgress()) return;

      const now = new Date();
      const check = shouldTriggerBackup(backupCfg, now, lastExecutionKey);

      if (check.shouldTrigger) {
        lastExecutionKey = check.key;
        console.log(`[BackupScheduler] Triggering scheduled backup (frequency: ${backupCfg.frequency || 'daily'})...`);
        await performBackup({ manual: false });
      }
    } catch (err) {
      console.error('[BackupScheduler] Scheduled backup error:', err.message);
    }
  }, 30000);

  if (timer.unref) timer.unref();
}

function stopBackupScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startBackupScheduler,
  stopBackupScheduler,
  shouldTriggerBackup,
  matchCronField
};

