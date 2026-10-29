const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { appendAuditLog, AUDIT_LOG_FILE } = require('../src/core/audit');
const { STORAGE_DIR, TRASH_DIR } = require('../src/core/config');

test('Audit Log: records entries in valid JSON Lines format', () => {
  const testAction = 'test_audit_entry_' + Date.now();
  appendAuditLog({
    action: testAction,
    ip: '127.0.0.1',
    user: 'tester',
    details: { foo: 'bar' }
  });

  assert.ok(fs.existsSync(AUDIT_LOG_FILE), 'Audit log file should exist');
  const content = fs.readFileSync(AUDIT_LOG_FILE, 'utf8');
  const lines = content.trim().split('\n');
  const matching = lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(entry => entry && entry.action === testAction);

  assert.strictEqual(matching.length, 1, 'Should find recorded audit entry');
  assert.strictEqual(matching[0].user, 'tester');
  assert.strictEqual(matching[0].details.foo, 'bar');
  assert.ok(matching[0].timestamp, 'Timestamp should be recorded');
});

test('Trash Retention: directory config is defined within storage directory', () => {
  assert.ok(TRASH_DIR, 'TRASH_DIR should be defined');
  assert.ok(TRASH_DIR.startsWith(STORAGE_DIR), 'TRASH_DIR should reside in STORAGE_DIR');
});
