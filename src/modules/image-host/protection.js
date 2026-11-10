const { readJsonData, writeJsonData } = require('../../core/config');

function getProtectedMap() {
  const data = readJsonData('protected_files', {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
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
