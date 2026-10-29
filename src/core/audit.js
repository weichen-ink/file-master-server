const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./config');

const AUDIT_LOG_FILE = path.join(DATA_DIR, 'audit.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB per file

function appendAuditLog(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Check rotation if file is too large
    if (fs.existsSync(AUDIT_LOG_FILE)) {
      const stat = fs.statSync(AUDIT_LOG_FILE);
      if (stat.size >= MAX_LOG_SIZE) {
        const rotated = path.join(DATA_DIR, `audit.${Date.now()}.log`);
        fs.renameSync(AUDIT_LOG_FILE, rotated);
      }
    }
    const logLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry
    }) + '\n';
    fs.appendFileSync(AUDIT_LOG_FILE, logLine, 'utf8');
  } catch (err) {
    console.warn('[AuditLog] Failed to write audit log:', err.message);
  }
}

module.exports = {
  appendAuditLog,
  AUDIT_LOG_FILE
};
