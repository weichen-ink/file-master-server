const { getConfig } = require('./config');
const { performBackup, isBackupInProgress } = require('./backup-service');

let timer = null;
let lastExecutedDateKey = '';

function startBackupScheduler() {
  if (timer) return;

  // Check every 30 seconds
  timer = setInterval(async () => {
    try {
      const cfg = getConfig();
      const backupCfg = cfg.backup || {};
      if (backupCfg.enabled === false) return;
      if (isBackupInProgress()) return;

      const schedule = String(backupCfg.schedule || '03:00').trim();
      const [schedH, schedM] = schedule.split(':').map((s) => parseInt(s, 10));
      if (isNaN(schedH) || isNaN(schedM)) return;

      const now = new Date();
      const curH = now.getHours();
      const curM = now.getMinutes();

      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      if (curH === schedH && curM === schedM && lastExecutedDateKey !== todayKey) {
        lastExecutedDateKey = todayKey;
        console.log(`[BackupScheduler] Triggering scheduled backup at ${schedule}...`);
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
  stopBackupScheduler
};
