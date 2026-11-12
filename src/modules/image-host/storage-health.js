const fs = require('node:fs');
const path = require('node:path');
const { RAW_DIR } = require('./asset-paths');
const { getConfig } = require('../../core/config');

let storageHealth = { checked: false, atomicUploads: false };

// Probe inside the actual volume, using private names that catalog scans ignore.
function probeAtomicUploads(directory, io = fs) {
  let probeDir;
  let result;
  try {
    io.mkdirSync(directory, { recursive: true });
    probeDir = io.mkdtempSync(path.join(directory, '.publish-probe-'));
    const source = path.join(probeDir, 'source');
    const target = path.join(probeDir, 'target');
    io.writeFileSync(source, 'file-master-storage-probe', { flag: 'wx' });
    io.linkSync(source, target);
    try {
      io.linkSync(source, target);
      throw new Error('Storage did not reject an existing target');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    result = { checked: true, atomicUploads: true };
  } catch (err) {
    result = { checked: true, atomicUploads: false, errorCode: err.code || 'PROBE_FAILED' };
  } finally {
    if (probeDir) {
      try { io.rmSync(probeDir, { recursive: true, force: true }); }
      catch (err) { result = { checked: true, atomicUploads: false, errorCode: err.code || 'PROBE_CLEANUP_FAILED' }; }
    }
  }
  return result;
}

function checkStorageHealth() {
  storageHealth = probeAtomicUploads(RAW_DIR);
  if (!storageHealth.atomicUploads) {
    console.warn(getConfig().language === 'zh'
      ? `[ImageHost] 存储检查失败（${storageHealth.errorCode}）：${RAW_DIR}。上传需要可写且支持硬链接的存储，请修复权限或更换文件系统后重启。`
      : `[ImageHost] Storage probe failed (${storageHealth.errorCode}) in ${RAW_DIR}. Uploads require writable storage with exclusive hard-link support. Fix permissions or move storage to a compatible filesystem, then restart.`);
  } else {
    console.log(getConfig().language === 'zh' ? '[ImageHost] 存储检查通过，可以安全接收上传文件。' : '[ImageHost] Storage probe passed: atomic upload publication available.');
  }
  return storageHealth;
}

function getStorageHealth() { return storageHealth; }

module.exports = { probeAtomicUploads, checkStorageHealth, getStorageHealth };
