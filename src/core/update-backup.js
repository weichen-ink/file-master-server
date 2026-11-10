const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Backup layout and legacy readers remain compatible with earlier server versions.
function createUpdateBackup({ rootDir: ROOT_DIR, dataDir: DATA_DIR, configPath: CONFIG_PATH, getConfig }) {
  const WM_BACKUP_DIR = path.join(ROOT_DIR, 'backups', 'watermarks');
  const UPDATE_PENDING_FILE = path.join(DATA_DIR, 'update_pending_restore.flag');

  function getWatermarkFilesToPreserve() {
    const candidates = new Set(['watermark.png', 'watermark-dark.png']);
    try {
      const cfg = getConfig();
      const wmImg = cfg.image_host?.watermark_image;
      if (wmImg) {
        const rel = path.relative(ROOT_DIR, path.resolve(ROOT_DIR, wmImg));
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) candidates.add(rel);
      }
      const wmDark = cfg.image_host?.watermark_image_dark;
      if (wmDark) {
        const rel = path.relative(ROOT_DIR, path.resolve(ROOT_DIR, wmDark));
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) candidates.add(rel);
      }
    } catch {}
    return [...candidates];
  }

  function backupWatermarkFiles(targetBackupDir = WM_BACKUP_DIR, sourceRootDir = ROOT_DIR) {
    const backups = new Map();
    fs.mkdirSync(targetBackupDir, { recursive: true });

    const manifest = [];
    for (const rel of getWatermarkFilesToPreserve()) {
      const full = path.join(sourceRootDir, rel);
      if (fs.existsSync(full)) {
        const content = fs.readFileSync(full);
        backups.set(full, content);
        const diskTarget = path.join(targetBackupDir, rel);
        fs.mkdirSync(path.dirname(diskTarget), { recursive: true });
        fs.writeFileSync(diskTarget, content);
        manifest.push({ rel, sha256: crypto.createHash('sha256').update(content).digest('hex') });
      }
    }
    fs.writeFileSync(
      path.join(targetBackupDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );
    return backups;
  }

  function restoreWatermarkFiles(backups = null, sourceBackupDir = WM_BACKUP_DIR, targetRootDir = ROOT_DIR) {
    const failed = [];
    let restoredCount = 0;

    if (backups instanceof Map) {
      for (const [full, buf] of backups.entries()) {
        try {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, buf);
          restoredCount++;
        } catch (err) {
          console.error(`[FileMaster Updater] Failed to restore watermark file ${full}:`, err);
          failed.push({ file: full, error: err.message });
        }
      }
      return { success: failed.length === 0, failed, restoredCount };
    }

    const manifestPath = path.join(sourceBackupDir, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!Array.isArray(manifest)) throw new Error('Backup manifest must be an array');
        for (const item of manifest) {
          if (typeof item?.rel !== 'string' || !item.rel || path.isAbsolute(item.rel) ||
            item.rel.split(/[\\/]/).includes('..')) {
            throw new Error('Invalid watermark path in backup manifest');
          }
          const targetFull = path.join(targetRootDir, item.rel);
          const diskTarget = item.sha256
            ? path.join(sourceBackupDir, item.rel)
            : path.join(sourceBackupDir, item.rel.replace(/[/\\]/g, '_'));
          try {
            const content = fs.readFileSync(diskTarget);
            if (item.sha256) {
              const digest = crypto.createHash('sha256').update(content).digest('hex');
              if (!/^[a-f0-9]{64}$/.test(item.sha256) || digest !== item.sha256) {
                throw new Error('Backup checksum mismatch');
              }
            } else if (!Number.isSafeInteger(item.size) || content.length !== item.size) {
              // Earlier manifests recorded only the file size.
              throw new Error('Legacy backup size mismatch');
            }
            fs.mkdirSync(path.dirname(targetFull), { recursive: true });
            fs.writeFileSync(targetFull, content);
            restoredCount++;
          } catch (err) {
            failed.push({ file: targetFull, error: err.message });
          }
        }
      } catch (mErr) {
        failed.push({ file: manifestPath, error: 'Failed to parse backup manifest: ' + mErr.message });
      }
    } else {
      // Backups made before manifests existed contain only the watermark files.
      const filesToPreserve = getWatermarkFilesToPreserve();
      for (const rel of filesToPreserve) {
        const full = path.join(targetRootDir, rel);
        const diskTarget = path.join(sourceBackupDir, rel.replace(/[/\\]/g, '_'));
        if (!fs.existsSync(diskTarget)) {
          failed.push({ file: full, error: 'Legacy backup file missing' });
          continue;
        }
        try {
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, fs.readFileSync(diskTarget));
          restoredCount++;
        } catch (err) {
          failed.push({ file: full, error: err.message });
        }
      }
    }

    return {
      success: failed.length === 0,
      failed,
      restoredCount
    };
  }

  function recoverInterruptedUpdate(options = {}) {
    const pendingFile = options.pendingFile || UPDATE_PENDING_FILE;
    const cfgBackup = options.configBackup || path.join(DATA_DIR, 'config.backup.yaml');
    const targetConfig = options.configPath || CONFIG_PATH;
    const backupDir = options.backupDir || WM_BACKUP_DIR;
    const targetRootDir = options.targetRootDir || ROOT_DIR;

    if (fs.existsSync(pendingFile)) {
      console.log('[FileMaster Updater] Interrupted update detected, restoring configuration and watermarks from disk backups...');
      try {
        if (!fs.existsSync(cfgBackup)) {
          throw new Error('Config backup missing in data/config.backup.yaml');
        }
        const wmRes = restoreWatermarkFiles(null, backupDir, targetRootDir);
        if (!wmRes.success) {
          const errs = wmRes.failed.map((f) => `${path.basename(f.file)}: ${f.error}`).join(', ');
          throw new Error(`Watermark restoration failed: ${errs}`);
        }
        fs.copyFileSync(cfgBackup, targetConfig);
        fs.unlinkSync(pendingFile);
        if (fs.existsSync(cfgBackup)) fs.unlinkSync(cfgBackup);
        console.log('[FileMaster Updater] Successfully recovered from interrupted update.');
        return { recovered: true, success: true };
      } catch (err) {
        console.error('[FileMaster Updater] Error during interrupted update recovery (flag preserved for retry):', err.message);
        return { recovered: true, success: false, error: err.message };
      }
    }
    return { recovered: false, success: true };
  }

  return { getWatermarkFilesToPreserve, backupWatermarkFiles, restoreWatermarkFiles,
    recoverInterruptedUpdate, WM_BACKUP_DIR, UPDATE_PENDING_FILE };
}
module.exports = { createUpdateBackup };
