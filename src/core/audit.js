const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');

const AUDIT_LOG_FILE = path.join(DATA_DIR, 'audit.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB per file

let knownLogSize = null;
let dirEnsured = false;

function appendAuditLog(entry) {
  try {
    if (!dirEnsured) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
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
      knownLogSize = 0;
    }
    const logLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry
    }) + '\n';
    fs.appendFileSync(AUDIT_LOG_FILE, logLine, 'utf8');
    knownLogSize += Buffer.byteLength(logLine, 'utf8');
  } catch (err) {
    knownLogSize = null;
    console.warn('[AuditLog] Failed to write audit log:', err.message);
  }
}

module.exports = {
  appendAuditLog,
  AUDIT_LOG_FILE
};

