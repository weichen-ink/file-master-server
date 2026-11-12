const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=fs.realpathSync(path.resolve(__dirname,'..'));
assert.equal(process.env.FILE_MASTER_TEST_ROOT,root,'Use npm test with isolated fixtures');
const config=require('../src/core/config'),{RAW_DIR,ensureDirs}=require('../src/modules/image-host/asset-paths');
const {updateShaIndex,pathToShaMap,getShaIndex}=require('../src/modules/image-host/sha-index');
const {trashAsset,listTrashEntries,restoreTrash,recoverPendingTrash}=require('../src/modules/image-host/trash');
const {scanAllImages}=require('../src/modules/image-host/catalog');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
ensureDirs();
function crash(operation,phase) {
  const child=spawnSync(process.execPath,['-e',`
    const fs=require('node:fs');
    const rename=fs.renameSync,link=fs.linkSync,unlink=fs.rmSync;
    fs.renameSync=(from,to,...rest)=>{const result=rename(from,to,...rest);if(${JSON.stringify(phase)}==='move'&&to.includes('/trash/')&&!to.endsWith('.json'))process.exit(91);if(${JSON.stringify(phase)}==='index'&&to.endsWith('/sha_index.json'))process.exit(91);return result;};
    fs.linkSync=(from,to,...rest)=>{const result=link(from,to,...rest);if(${JSON.stringify(phase)}==='publish'&&to.includes('/raw/'))process.exit(91);return result;};
    fs.rmSync=(file,...rest)=>{const result=unlink(file,...rest);if(${JSON.stringify(phase)}==='cleanup'&&file.includes('/trash/')&&!file.endsWith('.json'))process.exit(91);return result;};
    ${operation}.catch(error=>{console.error(error);process.exit(92);});
  `],{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(child.status,91,child.stderr);
}
function add(name) {
  const file=path.join(RAW_DIR,'2026','11',name),bytes=Buffer.from('original-'+name),sha256=hash(bytes),baselineSha256='b'.repeat(64);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
  const stat=fs.statSync(file);updateShaIndex(sha256,{year:'2026',month:'11',filename:name,size:stat.size,mtimeMs:stat.mtimeMs,baselineSha256});
  return {file,bytes,sha256,baselineSha256};
}
for(const phase of ['move','index']) test(`Delete crash after ${phase} replays metadata and retains original bytes`,async()=>{
  const name=`delete-${phase}.png`,entry=add(name);
  crash(`require('./src/modules/image-host/trash').trashAsset('2026','11','${name}')`,phase);
  assert.equal(fs.existsSync(entry.file),false);
  recoverPendingTrash();getShaIndex();
  assert.equal(pathToShaMap.has('2026/11/'+name),false);
  const item=listTrashEntries().find(item=>item.filename===name);
  assert.ok(item);assert.deepEqual(fs.readFileSync(item.fullPath),entry.bytes);assert.equal(item.baselineSha256,entry.baselineSha256);
  assert.equal(config.readCriticalJsonData('asset_mutation',null,value=>value===null),null);
  recoverPendingTrash();
});
for(const phase of ['publish','index','cleanup']) test(`Restore crash after ${phase} preserves baseline and replays idempotently before scanning`,async()=>{
  const name=`restore-${phase}.png`,entry=add(name);
  await trashAsset('2026','11',name);
  const item=listTrashEntries().find(item=>item.filename===name);
  crash(`require('./src/modules/image-host/trash').restoreTrash('${item.id}')`,phase);
  assert.deepEqual(fs.readFileSync(entry.file),entry.bytes);
  await scanAllImages(config.getConfig(),true);
  assert.equal(pathToShaMap.get('2026/11/'+name).baselineSha256,entry.baselineSha256);
  assert.equal(listTrashEntries().some(entry=>entry.id===item.id),false);
  assert.ok(!fs.readdirSync(path.dirname(entry.file)).some(file=>file.startsWith('.restore-')));
  recoverPendingTrash();assert.deepEqual(fs.readFileSync(entry.file),entry.bytes);
});
test('Changed restore target blocks scans and does not overwrite bytes or reset integrity baseline',async()=>{
  const name='restore-conflict.png',entry=add(name);await trashAsset('2026','11',name);
  const item=listTrashEntries().find(item=>item.filename===name);
  crash(`require('./src/modules/image-host/trash').restoreTrash('${item.id}')`,'publish');
  fs.writeFileSync(entry.file,'changed-after-crash');
  await assert.rejects(scanAllImages(config.getConfig(),true),{code:'ASSET_CHANGED'});
  assert.equal(fs.readFileSync(entry.file,'utf8'),'changed-after-crash');
  assert.deepEqual(fs.readFileSync(item.fullPath),entry.bytes);
  assert.ok(config.readCriticalJsonData('asset_mutation',null));
  fs.writeFileSync(entry.file,entry.bytes);recoverPendingTrash();
  assert.equal(pathToShaMap.get('2026/11/'+name).baselineSha256,entry.baselineSha256);
});
test('Conditional duplicate deletion rejects changed server bytes',async()=>{
  const name='conditional-delete.png',entry=add(name);fs.writeFileSync(entry.file,'changed');
  await assert.rejects(trashAsset('2026','11',name,entry.sha256),{status:412});
  assert.equal(fs.readFileSync(entry.file,'utf8'),'changed');
  assert.ok(!listTrashEntries().some(item=>item.filename===name));
});
test('Malformed trash sidecar is never treated as a legacy entry',async()=>{
  const entry=add('broken-sidecar.png');await trashAsset('2026','11','broken-sidecar.png');
  const item=listTrashEntries().find(item=>item.filename==='broken-sidecar.png');
  const meta=fs.readFileSync(item.fullPath+'.json');fs.writeFileSync(item.fullPath+'.json','{bad');
  try { assert.throws(listTrashEntries,/trash metadata/);assert.deepEqual(fs.readFileSync(item.fullPath),entry.bytes); }
  finally {fs.writeFileSync(item.fullPath+'.json',meta);}
});
