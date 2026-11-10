const { readJsonData, writeJsonData } = require('../../core/config');

function getProtectedMap() {
  const data = readJsonData('protected_files', {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function isItemLocked(year, month, filename, protectedMap = null) {
  const map = protectedMap || getProtectedMap();
  const key = `${year}/${month}/${filename}`;
  if (map[key] !== undefined) {
    return Boolean(map[key]);
  }
  if (year === 'protected') return true;
  return false;
}

function setItemLockState(year, month, filename, locked) {
  const map = getProtectedMap();
  const key = `${year}/${month}/${filename}`;
  if (locked) {
    map[key] = { lockedAt: Date.now() };
  } else {
    if (year === 'protected') {
      map[key] = false;
    } else {
      delete map[key];
    }
  }
  writeJsonData('protected_files', map);
  return Boolean(locked);
}

module.exports = { getProtectedMap, isItemLocked, setItemLockState };
