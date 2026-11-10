const { getConfig } = require('./config');
const { performBackup, isBackupInProgress } = require('./backup-service');

let timer = null;
let lastExecutionKey = '';

function matchCronField(value, fieldStr) {
  if (!fieldStr || fieldStr === '*') return true;
  for (const part of fieldStr.split(',')) {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      let start = 0;
      if (range !== '*') start = parseInt(range, 10);
      if (step > 0 && (value - start) >= 0 && (value - start) % step === 0) return true;
    } else if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (value >= start && value <= end) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

function shouldTriggerBackup(backupCfg, now, currentLastKey = '') {
  if (!backupCfg || backupCfg.enabled === false) {
    return { shouldTrigger: false, key: '' };
  }

  const frequency = backupCfg.frequency || 'daily';
  const schedule = String(backupCfg.schedule || '03:00').trim();
  const [schedH, schedM] = schedule.split(':').map((s) => parseInt(s, 10));
  const validH = isNaN(schedH) ? 3 : schedH;
  const validM = isNaN(schedM) ? 0 : schedM;

  const curH = now.getHours();
  const curM = now.getMinutes();
  const curD = now.getDate();
  const curDay = now.getDay(); // 0 is Sunday
  const curMon = now.getMonth() + 1;
  const todayKey = `${now.getFullYear()}-${String(curMon).padStart(2, '0')}-${String(curD).padStart(2, '0')}`;
  const daysEpoch = Math.floor(now.getTime() / 86400000);

  if (frequency === 'hourly' || frequency === 'hourly_1') {
    const key = `${todayKey}-H${curH}`;
    if (curM === validM && currentLastKey !== key) {
      return { shouldTrigger: true, key };
    }
  } else if (frequency === 'hourly_2') {
    const key = `${todayKey}-H${curH}`;
    if ((curH % 2 === validH % 2) && curM === validM && currentLastKey !== key) {
      return { shouldTrigger: true, key };
    }
  } else if (frequency === 'hourly_4') {
    const key = `${todayKey}-H${curH}`;
    if ((curH % 4 === validH % 4) && curM === validM && currentLastKey !== key) {
      return { shouldTrigger: true, key };
    }
  } else if (frequency === 'hourly_6' || frequency === 'every_6h') {
    const key = `${todayKey}-H${curH}`;
    if ((curH % 6 === validH % 6) && curM === validM && currentLastKey !== key) {
      return { shouldTrigger: true, key };
    }
  } else if (frequency === 'hourly_12' || frequency === 'every_12h') {
    const key = `${todayKey}-H${curH}`;
    if ((curH % 12 === validH % 12) && curM === validM && currentLastKey !== key) {
      return { shouldTrigger: true, key };
    }
  } else if (frequency === 'interval_2d') {
    const key = `${todayKey}`;
    if (daysEpoch % 2 === 0 && curH === validH && curM === validM && currentLastKey !== key) {
      return { shouldTrigger: true, key };
    }
  } else if (frequency === 'interval_3d') {
    const key = `${todayKey}`;
    if (daysEpoch % 3 === 0 && curH === validH && curM === validM && currentLastKey !== key) {
      return { shouldTrigger: true, key };
    }
  } else if (frequency === 'weekly') {
    const targetWeekday = parseInt(backupCfg.weekday ?? 0, 10); // 0 = Sunday
    const key = `${todayKey}`;
    if (curDay === targetWeekday && curH === validH && curM === validM && currentLastKey !== key) {
      return { shouldTrigger: true, key };
    }
  } else if (frequency === 'monthly') {
    const targetMonthDay = parseInt(backupCfg.monthday ?? 1, 10);
    const key = `${now.getFullYear()}-${String(curMon).padStart(2, '0')}`;
    if (curD === targetMonthDay && curH === validH && curM === validM && currentLastKey !== key) {
      return { shouldTrigger: true, key };
    }
  } else if (frequency === 'cron') {
    const cronExpr = String(backupCfg.cron_expression || '').trim();
    const parts = cronExpr.split(/\s+/);
    if (parts.length === 5) {
      const [mField, hField, domField, monField, dowField] = parts;
      if (
        matchCronField(curM, mField) &&
        matchCronField(curH, hField) &&
        matchCronField(curD, domField) &&
        matchCronField(curMon, monField) &&
        matchCronField(curDay, dowField)
      ) {
        const key = `${todayKey}-${curH}:${curM}`;
        if (currentLastKey !== key) {
          return { shouldTrigger: true, key };
        }
      }
    }
  } else {
    // Default: daily
    const key = `${todayKey}`;
    if (curH === validH && curM === validM && currentLastKey !== key) {
      return { shouldTrigger: true, key };
    }
  }

  return { shouldTrigger: false, key: '' };
}

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

