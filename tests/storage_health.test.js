const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probeAtomicUploads } = require('../src/modules/image-host/storage-health');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-storage-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'existing.png'), 'untouched');
  return root;
}

test('Storage probe verifies exclusive links on the actual volume and removes only its private files', (t) => {
  const root = fixture(t);
  assert.deepEqual(probeAtomicUploads(root), { checked: true, atomicUploads: true });
  assert.deepEqual(fs.readdirSync(root), ['existing.png']);
  assert.equal(fs.readFileSync(path.join(root, 'existing.png'), 'utf8'), 'untouched');
});

for (const code of ['ENOTSUP', 'EPERM', 'EACCES']) {
  test(`Storage probe reports ${code} before uploads and cleans staged files`, (t) => {
    const root = fixture(t);
    const io = { ...fs, linkSync() { throw Object.assign(new Error('simulated storage failure'), { code }); } };
    assert.deepEqual(probeAtomicUploads(root, io), { checked: true, atomicUploads: false, errorCode: code });
    assert.deepEqual(fs.readdirSync(root), ['existing.png']);
  });
}

test('Startup registration logs a failed probe and retains its health for the admin status', () => {
  const { registerImageHostModule, getStorageHealth } = require('../src/modules/image-host');
  const express = require('express');
  const originalLink = fs.linkSync;
  const originalWarn = console.warn;
  const warnings = [];
  try {
    fs.linkSync = () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    console.warn = (text) => warnings.push(text);
    registerImageHostModule(express());
    assert.equal(getStorageHealth().atomicUploads, false);
    assert.equal(getStorageHealth().errorCode, 'ENOTSUP');
    assert.ok(warnings.some((text) => text.includes('ENOTSUP') && text.includes('restart')));
  } finally {
    fs.linkSync = originalLink;
    console.warn = originalWarn;
  }
});

test('Probe cleanup failure becomes a diagnostic instead of crashing startup', (t) => {
  const root = fixture(t);
  const io = { ...fs, rmSync() { throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' }); } };
  assert.deepEqual(probeAtomicUploads(root, io), { checked: true, atomicUploads: false, errorCode: 'EACCES' });
});

test('Authenticated console warns before uploading when storage health is unknown or failed', async () => {
  const { storageWarning } = await import('../src/public/assets/admin/ui.mjs');
  assert.match(storageWarning({ atomicUploads: false }), /role="status"/);
  assert.match(storageWarning(null), /role="status"/);
  assert.equal(storageWarning({ atomicUploads: true }), '');
});
