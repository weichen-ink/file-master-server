const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = fs.realpathSync(path.resolve(__dirname, '..'));
assert.equal(process.env.FILE_MASTER_TEST_ROOT, root, 'Run npm test with isolated storage');
const { RAW_DIR, ensureDirs } = require('../src/modules/image-host/asset-paths');
const { readCriticalJsonData } = require('../src/core/config');
const { updateShaIndex, getShaIndex, pathToShaMap } = require('../src/modules/image-host/sha-index');
const { replaceAsset, trashAsset, restoreTrash, listTrashEntries, recoverPendingTrash } = require('../src/modules/image-host/trash');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const year = '2024', month = '03';
ensureDirs();

function seed(filename, bytes) {
  const target = path.join(RAW_DIR, year, month, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  const stat = fs.statSync(target);
  updateShaIndex(hash(bytes), { year, month, filename, size: stat.size, mtimeMs: stat.mtimeMs });
  return target;
}
async function fixture(name, restore) {
  const filename = name + '.txt', oldBytes = 'online-' + name, newBytes = 'incoming-' + name;
  let item;
  if (restore) {
    seed(filename, newBytes);
    await trashAsset(year, month, filename);
    item = listTrashEntries().find(i => i.filename === filename);
  }
  const target = seed(filename, oldBytes);
  const conflictTarget = { year, month, filename, sha256: hash(oldBytes) };
  const run = () => restore
    ? restoreTrash(item.id, { conflictStrategy: 'replace', filename, conflictTarget })
    : replaceAsset(year, month, filename, { buffer: Buffer.from(newBytes) }, hash(newBytes), { expectedSha256: hash(oldBytes) });
  const operation = restore
    ? `mod.restoreTrash(${JSON.stringify(item.id)},${JSON.stringify({conflictStrategy:'replace',filename,conflictTarget})})`
    : `mod.replaceAsset(${JSON.stringify(year)},${JSON.stringify(month)},${JSON.stringify(filename)},{buffer:Buffer.from(${JSON.stringify(newBytes)})},${JSON.stringify(hash(newBytes))},{expectedSha256:${JSON.stringify(hash(oldBytes))}})`;
  return { filename, target, oldBytes, newBytes, item, run, operation };
}

for (const restore of [false, true]) {
  const kind = restore ? 'restore' : 'upload';
  test(`${kind}: failed publication leaves old bytes online and clears the intent`, async () => {
    const f = await fixture(kind + '-eio', restore), rename = fs.renameSync;
    fs.renameSync = (from, to, ...rest) => {
      if (to === f.target && path.basename(from).startsWith('.replace-')) {
        assert.equal(fs.readFileSync(f.target, 'utf8'), f.oldBytes);
        throw Object.assign(new Error('Injected replacement EIO'), { code: 'EIO' });
      }
      return rename(from, to, ...rest);
    };
    try { await assert.rejects(f.run(), { code: 'EIO' }); }
    finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(f.target, 'utf8'), f.oldBytes);
    assert.equal(readCriticalJsonData('asset_mutation', null, () => true), null);
    const trash = listTrashEntries().filter(i => i.filename === f.filename);
    assert.equal(trash.length, restore ? 1 : 0);
    if (restore) assert.equal(fs.readFileSync(f.item.fullPath, 'utf8'), f.newBytes);
  });

  for (const phase of ['intent', 'backup', 'before-publish', 'after-publish', 'index', ...(restore ? ['cleanup'] : [])]) {
    test(`${kind}: restart after ${phase} keeps URL readable and recovers metadata`, async () => {
      const f = await fixture(`${kind}-${phase}`, restore);
      const child = spawnSync(process.execPath, ['-e', `
        const fs=require('node:fs'),path=require('node:path');
        const target=${JSON.stringify(f.target)},phase=${JSON.stringify(phase)};
        const rename=fs.renameSync,copy=fs.copyFileSync,remove=fs.rmSync;
        fs.renameSync=(from,to,...rest)=>{
          const publish=to===target&&path.basename(from).startsWith('.replace-');
          if(publish&&phase==='before-publish')process.exit(86);
          const result=rename(from,to,...rest);
          if((publish&&phase==='after-publish')||(to.endsWith('/asset_mutation.json')&&phase==='intent')||(to.endsWith('/sha_index.json')&&phase==='index'))process.exit(86);
          return result;
        };
        fs.copyFileSync=(from,to,...rest)=>{const result=copy(from,to,...rest);if(from===target&&phase==='backup')process.exit(86);return result;};
        fs.rmSync=(file,...rest)=>{const result=remove(file,...rest);if(phase==='cleanup'&&file===${JSON.stringify(f.item?.fullPath || '')})process.exit(86);return result;};
        const mod=require('./src/modules/image-host/trash');
        ${f.operation}.catch(e=>{console.error(e);process.exit(87);});
      `], { cwd: root, encoding: 'utf8', timeout: 10000 });
      assert.equal(child.status, 86, child.stderr);
      const committed = ['after-publish', 'index', 'cleanup'].includes(phase);
      // The public path exists even before recovery runs.
      assert.equal(fs.readFileSync(f.target, 'utf8'), committed ? f.newBytes : f.oldBytes);
      recoverPendingTrash(); getShaIndex();
      assert.equal(fs.readFileSync(f.target, 'utf8'), committed ? f.newBytes : f.oldBytes);
      assert.equal(pathToShaMap.get(`${year}/${month}/${f.filename}`).sha256, hash(committed ? f.newBytes : f.oldBytes));
      assert.equal(pathToShaMap.get(`${year}/${month}/${f.filename}`).baselineSha256, hash(committed ? f.newBytes : f.oldBytes));
      assert.equal(readCriticalJsonData('asset_mutation', null, () => true), null);
      const trash = listTrashEntries().filter(i => i.filename === f.filename);
      assert.equal(trash.length, committed || restore ? 1 : 0);
      if (trash.length) assert.equal(fs.readFileSync(trash[0].fullPath, 'utf8'), committed ? f.oldBytes : f.newBytes);
    });
  }
}

test('A transient metadata failure after publication finishes recovery and returns the committed result', async () => {
  const f = await fixture('transient-index', false), rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to, ...rest) => {
    if (!injected && to.endsWith('/sha_index.json') && fs.readFileSync(f.target, 'utf8') === f.newBytes) {
      injected = true;
      throw Object.assign(new Error('Transient index write failure'), { code: 'EIO' });
    }
    return rename(from, to, ...rest);
  };
  let result;
  try { result = await f.run(); }
  finally { fs.renameSync = rename; }
  assert.equal(injected, true);
  assert.equal(result.replaced, true);
  assert.equal(readCriticalJsonData('asset_mutation', null, () => true), null);
  assert.equal(pathToShaMap.get(`${year}/${month}/${f.filename}`).sha256, hash(f.newBytes));
});

test('Long Unicode filenames can be replaced, trashed and restored without overflowing storage filenames', async () => {
  const filename = '长'.repeat(78) + '.txt', target = seed(filename, 'long-old');
  await replaceAsset(year, month, filename, { buffer: Buffer.from('long-new') }, hash('long-new'), { expectedSha256: hash('long-old') });
  assert.equal(fs.readFileSync(target, 'utf8'), 'long-new');
  const backup = listTrashEntries().find(i => i.filename === filename);
  assert.equal(fs.readFileSync(backup.fullPath, 'utf8'), 'long-old');
  await trashAsset(year, month, filename);
  assert.equal(listTrashEntries().filter(i => i.filename === filename).length, 2);
  await restoreTrash(backup.id, { conflictStrategy: 'rename', filename: 'unicode-restored.txt' });
  assert.equal(fs.readFileSync(path.join(RAW_DIR, year, month, 'unicode-restored.txt'), 'utf8'), 'long-old');
  assert.equal(readCriticalJsonData('asset_mutation', null, () => true), null);
});
