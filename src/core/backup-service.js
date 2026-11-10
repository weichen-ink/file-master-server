const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ROOT_DIR, DATA_DIR, getConfig, readJsonData, writeJsonData } = require('./config');
const { appendAuditLog } = require('./audit');

const execFileAsync = promisify(execFile);

let activeBackupJob = null;

function resolveBackupDir(configuredDir) {
  if (!configuredDir || typeof configuredDir !== 'string' || !configuredDir.trim()) {
    return path.join(DATA_DIR, 'backups');
  }
  const trimmed = configuredDir.trim();
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }
  return path.resolve(ROOT_DIR, trimmed);
}

function formatBackupTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
}

async function sendBarkNotification({ barkUrl, title, body, isError = false }) {
  if (!barkUrl || typeof barkUrl !== 'string' || !barkUrl.trim()) {
    return { skipped: true, reason: 'Bark URL not configured' };
  }

  let cleanUrl = barkUrl.trim();
  // Strip trailing slashes
  cleanUrl = cleanUrl.replace(/\/+$/, '');

  const payload = {
    title: title || 'File Master 通知',
    body: body || '',
    group: 'File Master',
    badge: isError ? 1 : undefined,
    level: isError ? 'timeSensitive' : 'active'
  };

  try {
    const res = await fetch(cleanUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      // Fallback for servers that only accept GET: https://api.day.app/KEY/title/body
      const getUrl = `${cleanUrl}/${encodeURIComponent(payload.title)}/${encodeURIComponent(payload.body)}?group=${encodeURIComponent('File Master')}`;
      const getRes = await fetch(getUrl);
      if (!getRes.ok) {
        throw new Error(`Bark HTTP ${getRes.status}: ${getRes.statusText}`);
      }
    }
    return { success: true };
  } catch (err) {
    console.error('[Backup] Bark notification failed:', err.message);
    return { success: false, error: err.message };
  }
}

async function checkRcloneInstalled() {
  try {
    await execFileAsync('rclone', ['version'], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

async function testBarkNotification(barkUrl) {
  if (!barkUrl || !barkUrl.trim()) {
    throw new Error('请提供有效的 Bark 推送地址');
  }
  const res = await sendBarkNotification({
    barkUrl,
    title: 'File Master 测试通知',
    body: `这是一条来自 File Master 服务端的测试提醒。网络连通正常！\n测试时间: ${new Date().toLocaleString()}`,
    isError: false
  });
  if (!res.success) {
    throw new Error(res.error || '推送失败，请检查 Bark URL 是否正确');
  }
  return { success: true, message: 'Bark 测试推送已送达！' };
}

async function testRcloneTarget(target) {
  if (!target || !target.trim()) {
    throw new Error('请提供有效的 Rclone / OneDrive 目标路径（如 onedrive:应用/File Master 备份）');
  }
  const cleanTarget = target.trim();
  const installed = await checkRcloneInstalled();
  if (!installed) {
    throw new Error('服务器未检测到 rclone 命令行工具。请确认在服务器终端已安装 rclone。');
  }

  try {
    // Try to ensure directory exists or list it
    await execFileAsync('rclone', ['mkdir', cleanTarget], { timeout: 15000 });
    const { stdout } = await execFileAsync('rclone', ['lsjson', cleanTarget, '--max-depth', '1'], { timeout: 15000 });
    return {
      success: true,
      message: `连通成功！目标路径 [${cleanTarget}] 正常可用。`,
      filesCount: JSON.parse(stdout || '[]').length
    };
  } catch (err) {
    throw new Error(`Rclone 连通失败: ${err.message}`);
  }
}

function getLocalBackupFiles(backupDir) {
  if (!fs.existsSync(backupDir)) return [];
  try {
    const files = fs.readdirSync(backupDir);
    return files
      .filter((f) => f.startsWith('filemaster-') && f.endsWith('.tar.gz'))
      .map((f) => {
        const fullPath = path.join(backupDir, f);
        const st = fs.statSync(fullPath);
        return {
          filename: f,
          path: fullPath,
          size: st.size,
          sizeFormatted: formatBytes(st.size),
          mtime: st.mtimeMs,
          createdAt: new Date(st.mtimeMs).toISOString()
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

function rotateLocalBackups(backupDir, retentionLimit) {
  const files = getLocalBackupFiles(backupDir);
  const deleted = [];
  if (files.length > retentionLimit) {
    const toDelete = files.slice(retentionLimit);
    for (const f of toDelete) {
      try {
        fs.unlinkSync(f.path);
        deleted.push(f.filename);
      } catch (err) {
        console.warn(`[Backup] Failed to remove expired backup ${f.filename}:`, err.message);
      }
    }
  }
  return { kept: Math.min(files.length, retentionLimit), deleted };
}

function executeRcloneWithProgress(args, logStep, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn('rclone', args);
    let stdout = '';
    let stderr = '';
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        reject(new Error(`rclone operation timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.includes('Transferred:') || line.includes('ETA') || line.includes('%')) {
          logStep(`[Rclone] ${line}`);
        }
      }
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const errMsg = stderr.trim() || `rclone process exited with code ${code}`;
        reject(new Error(errMsg));
      }
    });
  });
}

async function syncAndRotateRclone(archivePath, rcloneTarget, retentionLimit, logStep) {
  const cleanTarget = rcloneTarget.trim();
  logStep(`[Rclone] Uploading ${path.basename(archivePath)} to ${cleanTarget}...`);

  await executeRcloneWithProgress([
    'copy',
    archivePath,
    cleanTarget,
    '--stats=5s',
    '--stats-one-line'
  ], logStep, 20 * 60 * 1000);
  logStep(`[Rclone] Upload completed successfully.`);

  // Rotate remote backups if retention limit is specified
  try {
    const { stdout } = await execFileAsync('rclone', [
      'lsjson',
      cleanTarget,
      '--include',
      'filemaster-*.tar.gz'
    ], { timeout: 30000 });

    const remoteFiles = JSON.parse(stdout || '[]');
    // Sort by ModTime descending
    remoteFiles.sort((a, b) => new Date(b.ModTime).getTime() - new Date(a.ModTime).getTime());

    if (remoteFiles.length > retentionLimit) {
      const expired = remoteFiles.slice(retentionLimit);
      logStep(`[Rclone] Cleaning up ${expired.length} expired remote backup(s)...`);
      for (const ef of expired) {
        const remoteFilePath = `${cleanTarget.replace(/\/+$/, '')}/${ef.Path}`;
        try {
          await execFileAsync('rclone', ['deletefile', remoteFilePath], { timeout: 15000 });
          logStep(`[Rclone] Removed remote backup: ${ef.Path}`);
        } catch (delErr) {
          logStep(`[Rclone] Warning: failed to delete remote ${ef.Path}: ${delErr.message}`);
        }
      }
    }
  } catch (rotErr) {
    logStep(`[Rclone] Remote retention cleanup note: ${rotErr.message}`);
  }
}

async function performBackup({ manual = false } = {}) {
  if (activeBackupJob) {
    throw new Error('备份任务正在进行中，请稍候...');
  }

  const cfg = getConfig();
  const backupCfg = cfg.backup || {};
  const retentionLimit = Math.max(1, Number(backupCfg.retention) || 7);
  const localDir = resolveBackupDir(backupCfg.local_dir);
  const rcloneTarget = (backupCfg.rclone_target || '').trim();
  const barkUrl = (backupCfg.bark_url || '').trim();

  const startedAt = Date.now();
  const logs = [];
  const logStep = (msg) => {
    const entry = `[${new Date().toLocaleTimeString('en-US', { hour12: false })}] ${msg}`;
    logs.push(entry);
    if (activeBackupJob) {
      activeBackupJob.currentStep = msg;
    }
    console.log(`[Backup] ${msg}`);
  };

  activeBackupJob = {
    startedAt,
    manual,
    currentStep: `Starting ${manual ? 'manual' : 'scheduled'} full backup...`,
    logs
  };

  try {
    logStep(`Starting ${manual ? 'manual' : 'scheduled'} full backup...`);
    fs.mkdirSync(localDir, { recursive: true });

    // Gather backup targets
    const backupCandidates = new Set([
      'config.yaml',
      'config.example.yaml',
      'wm-light.png',
      'wm-dark.png',
      'watermark.png',
      'watermark-dark.png',
      'data'
    ]);

    try {
      if (cfg.image_host?.watermark_image) {
        const rel = path.relative(ROOT_DIR, path.resolve(ROOT_DIR, cfg.image_host.watermark_image));
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) backupCandidates.add(rel);
      }
      if (cfg.image_host?.watermark_image_dark) {
        const rel = path.relative(ROOT_DIR, path.resolve(ROOT_DIR, cfg.image_host.watermark_image_dark));
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) backupCandidates.add(rel);
      }
    } catch {}

    const targets = [];
    for (const cand of backupCandidates) {
      if (fs.existsSync(path.join(ROOT_DIR, cand))) {
        targets.push(cand);
      }
    }
    if (fs.existsSync(path.join(ROOT_DIR, 'storage', 'raw'))) {
      targets.push('storage/raw');
    }

    if (targets.length === 0) {
      throw new Error('未在磁盘上找到可备份的有效目标目录');
    }

    const timestamp = formatBackupTimestamp(new Date());
    const archiveFilename = `filemaster-full-${timestamp}.tar.gz`;
    const archivePath = path.join(localDir, archiveFilename);

    logStep(`Packing targets into ${archiveFilename}...`);
    // Tar exclude internal backups directory if targets contains 'data'
    const tarArgs = ['-czf', archivePath, '--exclude=data/backups', '--exclude=*.tmp', '-C', ROOT_DIR, ...targets];
    await execFileAsync('tar', tarArgs, { timeout: 30 * 60 * 1000 });

    if (!fs.existsSync(archivePath)) {
      throw new Error('创建归档文件失败，未生成压缩包');
    }

    const stat = fs.statSync(archivePath);
    const archiveSize = stat.size;
    const formattedSize = formatBytes(archiveSize);
    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    logStep(`Archive created successfully (${formattedSize}, ${durationSec}s).`);

    // Rotate local backups
    const rotation = rotateLocalBackups(localDir, retentionLimit);
    logStep(`Local retention applied: kept ${rotation.kept} backup(s), pruned ${rotation.deleted.length} old backup(s).`);

    let rcloneSuccess = null;
    let rcloneError = null;

    if (rcloneTarget) {
      const hasRclone = await checkRcloneInstalled();
      if (hasRclone) {
        try {
          await syncAndRotateRclone(archivePath, rcloneTarget, retentionLimit, logStep);
          rcloneSuccess = true;
        } catch (rErr) {
          rcloneSuccess = false;
          rcloneError = rErr.message;
          logStep(`[Rclone] Upload failed: ${rErr.message}`);
        }
      } else {
        rcloneSuccess = false;
        rcloneError = '服务器未安装 rclone 命令行工具';
        logStep(`[Rclone] Skipped upload: rclone not installed`);
      }
    }

    // Bark notification
    let barkSuccess = null;
    if (barkUrl) {
      const targetHint = rcloneTarget
        ? (rcloneSuccess ? `已同步至: ${rcloneTarget}` : `⚠️ 同步失败: ${rcloneError}`)
        : `本地保存: ${localDir}`;
      const barkBody = `归档大小: ${formattedSize}\n耗时: ${durationSec}s\n${targetHint}\n本地保留最近 ${retentionLimit} 份`;
      const barkRes = await sendBarkNotification({
        barkUrl,
        title: '✅ File Master 备份成功',
        body: barkBody,
        isError: false
      });
      barkSuccess = barkRes.success;
      logStep(`Bark notification ${barkRes.success ? 'delivered' : 'failed: ' + barkRes.error}`);
    }

    const result = {
      success: true,
      archiveFilename,
      archivePath,
      archiveSize,
      archiveSizeFormatted: formattedSize,
      durationMs: Date.now() - startedAt,
      durationSec,
      retentionLimit,
      rcloneTarget: rcloneTarget || null,
      rcloneSuccess,
      rcloneError,
      barkSuccess,
      completedAt: new Date().toISOString(),
      logs
    };

    writeJsonData('backup_status', result);
    appendAuditLog({
      action: 'automated_backup',
      mode: manual ? 'manual' : 'scheduled',
      archiveFilename,
      size: archiveSize,
      durationSec,
      rcloneSuccess
    });

    return result;
  } catch (err) {
    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    logStep(`Backup failed: ${err.message}`);

    const failureRecord = {
      success: false,
      error: err.message,
      durationMs: Date.now() - startedAt,
      durationSec,
      completedAt: new Date().toISOString(),
      logs
    };

    writeJsonData('backup_status', failureRecord);

    if (barkUrl) {
      sendBarkNotification({
        barkUrl,
        title: '⚠️ File Master 备份失败',
        body: `备份执行异常: ${err.message}\n耗时: ${durationSec}s`,
        isError: true
      }).catch(() => {});
    }

    throw err;
  } finally {
    activeBackupJob = null;
  }
}

function getBackupStatus() {
  const cfg = getConfig();
  const backupCfg = cfg.backup || {};
  const localDir = resolveBackupDir(backupCfg.local_dir);
  const status = readJsonData('backup_status', null);
  const localBackups = getLocalBackupFiles(localDir);

  const isBackingUp = activeBackupJob !== null;
  return {
    config: {
      enabled: backupCfg.enabled !== false,
      frequency: backupCfg.frequency || 'daily',
      schedule: String(backupCfg.schedule || '03:00'),
      weekday: Number(backupCfg.weekday ?? 0),
      monthday: Number(backupCfg.monthday ?? 1),
      cron_expression: backupCfg.cron_expression || '',
      retention: Math.max(1, Number(backupCfg.retention) || 7),
      local_dir: backupCfg.local_dir || './data/backups',
      resolved_dir: localDir,
      rclone_target: backupCfg.rclone_target || '',
      bark_url: backupCfg.bark_url || ''
    },
    lastBackup: status,
    localBackupsCount: localBackups.length,
    recentBackups: localBackups.slice(0, 5),
    isBackingUp,
    currentStep: activeBackupJob ? activeBackupJob.currentStep : '',
    liveLogs: activeBackupJob ? activeBackupJob.logs : (status?.logs || [])
  };
}

module.exports = {
  performBackup,
  sendBarkNotification,
  testBarkNotification,
  testRcloneTarget,
  checkRcloneInstalled,
  getBackupStatus,
  resolveBackupDir,
  isBackupInProgress: () => activeBackupJob !== null
};

