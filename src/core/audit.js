const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');
const { ensurePrivateFile, writePrivateFile } = require('./private-files');

const AUDIT_LOG_FILE = path.join(DATA_DIR, 'audit.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_ROTATED_LOGS = 5;

let knownLogSize = null;
let dirEnsured = false;

function pruneRotatedAuditLogs(maxKeep = MAX_ROTATED_LOGS) {
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    const rotatedFiles = fs.readdirSync(DATA_DIR)
      .filter((name) => /^audit\.\d+\.log$/.test(name))
      .sort();
    while (rotatedFiles.length > maxKeep) {
      const oldest = rotatedFiles.shift();
      try {
        fs.unlinkSync(path.join(DATA_DIR, oldest));
      } catch {}
    }
  } catch {}
}

function appendAuditLog(entry) {
  try {
    if (!dirEnsured) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      for (const name of fs.readdirSync(DATA_DIR)) {
        if (/^audit(?:\.\d+)?\.log$/.test(name)) ensurePrivateFile(path.join(DATA_DIR, name));
      }
      dirEnsured = true;
    }
    if (knownLogSize === null) {
      try {
        knownLogSize = fs.statSync(AUDIT_LOG_FILE).size;
      } catch (err) {
        if (err.code === 'ENOENT') knownLogSize = 0;
        else throw err;
      }
    }
    if (knownLogSize >= MAX_LOG_SIZE) {
      const rotated = path.join(DATA_DIR, `audit.${Date.now()}.log`);
      fs.renameSync(AUDIT_LOG_FILE, rotated);
      pruneRotatedAuditLogs();
      knownLogSize = 0;
    }
    const logLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry
    }) + '\n';
    writePrivateFile(AUDIT_LOG_FILE, logLine, { append: true });
    knownLogSize += Buffer.byteLength(logLine, 'utf8');
  } catch (err) {
    knownLogSize = null;
    console.warn('[AuditLog] Failed to write audit log:', err.message);
  }
}

module.exports = {
  appendAuditLog,
  pruneRotatedAuditLogs,
  AUDIT_LOG_FILE
};

