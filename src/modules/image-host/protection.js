const { readCriticalJsonData, writeJsonData } = require('../../core/config');

function getProtectedMap() {
  return readCriticalJsonData('protected_files', {}, value => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.entries(value).every(([key,item]) => /^\d{4}\/\d{2}\/[^/]+$/.test(key) && item && typeof item === 'object' && Number.isFinite(item.lockedAt)));
}

function isItemLocked(year, month, filename, protectedMap = null) {
  const map = protectedMap || getProtectedMap();
  const key = `${year}/${month}/${filename}`;
  return Boolean(map[key]);
}

function setItemLockState(year, month, filename, locked) {
  const map = getProtectedMap();
  const key = `${year}/${month}/${filename}`;
  if (locked) {
    map[key] = { lockedAt: Date.now() };
  } else {
    delete map[key];
  }
  writeJsonData('protected_files', map);
  return Boolean(locked);
}

module.exports = { getProtectedMap, isItemLocked, setItemLockState };
