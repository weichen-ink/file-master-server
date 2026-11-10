const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Backup layout and legacy readers remain compatible with earlier server versions.
function createUpdateBackup({ rootDir: ROOT_DIR, dataDir: DATA_DIR, configPath: CONFIG_PATH, getConfig }) {
  const WM_BACKUP_DIR = path.join(ROOT_DIR, 'backups', 'watermarks');
  const UPDATE_PENDING_FILE = path.join(DATA_DIR, 'update_pending_restore.flag');

  // Replace the marker atomically so a crash cannot silently discard an install obligation.
  function readPendingUpdate(pendingFile = UPDATE_PENDING_FILE) {
    if (!fs.existsSync(pendingFile)) return null;
    const raw = fs.readFileSync(pendingFile, 'utf8').trim();
    // Pre-state-machine releases wrote these plain markers.
    if (raw === 'pending' || raw === 'interrupted') return { assetsRestored: false, dependenciesPending: false };
    const state = JSON.parse(raw);
    if (typeof state.assetsRestored !== 'boolean' || typeof state.dependenciesPending !== 'boolean') {
      throw new Error('Invalid pending update state; preserve backups and repair the marker before updating');
    }
    return state;
  }

  function writePendingUpdate(state, pendingFile = UPDATE_PENDING_FILE) {
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(`${pendingFile}.tmp`, JSON.stringify(state), 'utf8');
    fs.renameSync(`${pendingFile}.tmp`, pendingFile);
  }

  function clearPendingUpdate(pendingFile = UPDATE_PENDING_FILE, cfgBackup = path.join(DATA_DIR, 'config.backup.yaml')) {
    // Remove the marker last: cleanup failure must not claim completion.
    if (fs.existsSync(cfgBackup)) fs.unlinkSync(cfgBackup);
    if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile);
  }

  function getConfiguredWatermarks() {
    const configured = [];
    try {
      const cfg = getConfig();
      const wmImg = cfg.image_host?.watermark_image;
      if (wmImg) {
        const rel = path.relative(ROOT_DIR, path.resolve(ROOT_DIR, wmImg));
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) configured.push(rel);
      }
      const wmDark = cfg.image_host?.watermark_image_dark;
      if (wmDark) {
        const rel = path.relative(ROOT_DIR, path.resolve(ROOT_DIR, wmDark));
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) configured.push(rel);
      }
    } catch {}
    if (!configured.length) {
      configured.push('wm-light.png', 'wm-dark.png');
    }
    return configured;
  }

  function getWatermarkFilesToPreserve() {
    const candidates = new Set(getConfiguredWatermarks());
    candidates.add('wm-light.png');
    candidates.add('wm-dark.png');
    candidates.add('watermark.png');
    candidates.add('watermark-dark.png');
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
          console.error(`[File Master Updater] Failed to restore watermark file ${full}:`, err);
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
      // No manifest means we cannot infer that an absent optional file was ever
      // backed up. New default filenames must not invalidate an older snapshot.
      const filesToPreserve = getWatermarkFilesToPreserve().filter((rel) =>
        fs.existsSync(path.join(sourceBackupDir, rel.replace(/[/\\]/g, '_'))));
      if (!filesToPreserve.length) failed.push({ file: sourceBackupDir, error: 'Legacy watermark backup files missing' });
      for (const rel of filesToPreserve) {
        const full = path.join(targetRootDir, rel);
        const diskTarget = path.join(sourceBackupDir, rel.replace(/[/\\]/g, '_'));
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

    if (!fs.existsSync(pendingFile)) return { recovered: false, success: true };
    try {
      const state = readPendingUpdate(pendingFile);
      if (!state.assetsRestored) {
        console.log('[File Master Updater] Interrupted update detected, restoring configuration and watermarks from disk backups...');
        if (!fs.existsSync(cfgBackup)) throw new Error('Config backup missing in data/config.backup.yaml');
        const wmRes = restoreWatermarkFiles(null, backupDir, targetRootDir);
        if (!wmRes.success) {
          const errs = wmRes.failed.map((f) => `${path.basename(f.file)}: ${f.error}`).join(', ');
          throw new Error(`Watermark restoration failed: ${errs}`);
        }
        fs.copyFileSync(cfgBackup, targetConfig);
        state.assetsRestored = true;
        writePendingUpdate(state, pendingFile);
      }
      if (state.dependenciesPending) {
        console.warn('[File Master Updater] User assets restored; dependencies may be incomplete. Retry the hot update to install dependencies before restarting.');
      } else {
        clearPendingUpdate(pendingFile, cfgBackup);
        console.log('[File Master Updater] Successfully recovered from interrupted update.');
      }
      return { recovered: true, success: true, dependenciesPending: state.dependenciesPending };
    } catch (err) {
      console.error('[File Master Updater] Error during interrupted update recovery (flag preserved for retry):', err.message);
      return { recovered: true, success: false, error: err.message };
    }
  }

  return { getWatermarkFilesToPreserve, backupWatermarkFiles, restoreWatermarkFiles,
    recoverInterruptedUpdate, readPendingUpdate, writePendingUpdate, clearPendingUpdate, WM_BACKUP_DIR, UPDATE_PENDING_FILE };
}
module.exports = { createUpdateBackup };
