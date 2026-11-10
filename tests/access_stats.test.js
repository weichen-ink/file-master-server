const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  recordHit,
  getAssetStats,
  removeAssetStats,
  flushAccessStats,
  getAccessStats
} = require('../src/modules/image-host/stats');
const { DATA_DIR } = require('../src/core/config');

test('Access statistics tracks hits, debounces persistence and removes on deletion', async () => {
  const year = '2026';
  const month = '11';
  const filename = 'stat_test_image.png';

  // 1. Initial hit should record 1 hit
  recordHit(year, month, filename);
  let stats = getAssetStats(year, month, filename);
  assert.equal(stats.hits, 1);
  assert.ok(stats.lastAccessedAt > 0);

  // 2. Second hit should record 2 hits
  recordHit(year, month, filename);
  stats = getAssetStats(year, month, filename);
  assert.equal(stats.hits, 2);

  // 3. Flush persistence to data/access_stats.json
  flushAccessStats();
  const filePath = path.join(DATA_DIR, 'access_stats.json');
  assert.ok(fs.existsSync(filePath), 'access_stats.json should exist');
  const diskData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(diskData[`${year}/${month}/${filename}`]?.hits, 2);

  // 4. Remove asset stats
  removeAssetStats(year, month, filename);
  stats = getAssetStats(year, month, filename);
  assert.equal(stats.hits, 0);

  // 5. Flush again and verify deletion
  flushAccessStats();
  const diskDataAfter = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(diskDataAfter[`${year}/${month}/${filename}`], undefined);
});

