const { readJsonData, writeJsonData } = require('../../core/config');

let accessStats = null;
let isDirty = false;
let flushTimer = null;
const FLUSH_INTERVAL_MS = 5000;

function getAccessStats() {
  if (!accessStats) {
    accessStats = readJsonData('access_stats', {});
  }
  return accessStats;
}

function recordHit(year, month, filename) {
  if (!year || !month || !filename) return;
  const relKey = `${year}/${month}/${filename}`;
  const stats = getAccessStats();
  const existing = stats[relKey] || { hits: 0, lastAccessedAt: null };
  existing.hits = (existing.hits || 0) + 1;
  existing.lastAccessedAt = Date.now();
  stats[relKey] = existing;
  isDirty = true;
  scheduleFlush();
}

function getAssetStats(year, month, filename) {
  const relKey = `${year}/${month}/${filename}`;
  const stats = getAccessStats();
  return stats[relKey] || { hits: 0, lastAccessedAt: null };
}

function removeAssetStats(year, month, filename) {
  const relKey = `${year}/${month}/${filename}`;
  const stats = getAccessStats();
  if (stats[relKey]) {
    delete stats[relKey];
    isDirty = true;
    scheduleFlush();
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAccessStats();
  }, FLUSH_INTERVAL_MS);
  if (flushTimer.unref) flushTimer.unref();
}

function flushAccessStats() {
  if (!isDirty || !accessStats) return;
  try {
    writeJsonData('access_stats', accessStats);
    isDirty = false;
  } catch (err) {
    console.error('[ImageHost] Failed to write access_stats.json:', err.message);
  }
}

process.on('beforeExit', () => {
  flushAccessStats();
});

module.exports = {
  getAccessStats,
  recordHit,
  getAssetStats,
  removeAssetStats,
  flushAccessStats
};

