const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const root = fs.realpathSync(path.resolve(__dirname,'..'));
assert.equal(process.env.FILE_MASTER_TEST_ROOT,root,'Run npm test: monitoring requires an isolated project');
const config = require('../src/core/config');
const {createHealthReporter,cachedCollector} = require('../src/core/monitoring');

test('Monitoring defaults to off, validates selections and stays in site settings', async()=>{
  assert.equal(config.getConfig().monitoring.enabled,false);
  const prepared=config.prepareConfigPatch({monitoring:{enabled:true,sections:{files:true}}});
  assert.equal(prepared.config.monitoring.sections.files,true);
  assert.equal(prepared.config.monitoring.sections.service,true);
  assert.deepEqual(Object.keys(prepared.config.monitoring),['enabled','sections']);
  for(const monitoring of [null,[],{enabled:'true'},{sections:{files:'true'}},{sections:{private:true}}])assert.throws(()=>config.prepareConfigPatch({monitoring}));
  const {sectionValues,sectionPatch}=await import('../src/public/assets/admin/features/settings-schema.mjs');
  const values=sectionValues('site',prepared.config);
  const patch=sectionPatch('site',values);
  assert.equal(patch.monitoring.enabled,true);assert.equal(patch.monitoring.sections.files,true);
  assert.ok(!Object.keys(patch).some(key=>key.startsWith('monitor_')));
});

test('Polling caches concurrent work, refreshes after TTL and retries failures',async()=>{
  let now=0,calls=0,release;
  const collect=cachedCollector(()=>{calls++;return new Promise(resolve=>{release=resolve;});},100,()=>now);
  const first=collect(),second=collect();
  assert.equal(first,second);await Promise.resolve();assert.equal(calls,1);
  release({count:4});assert.equal((await first).count,4);
  now=99;await collect();assert.equal(calls,1);
  now=100;const fresh=collect();await Promise.resolve();assert.equal(calls,2);release({count:5});assert.equal((await fresh).count,5);
  let attempts=0;
  const retry=cachedCollector(()=>{if(++attempts===1)throw Error('private path');return {count:1};},100,()=>now);
  await assert.rejects(retry());await assert.rejects(retry());assert.equal(attempts,1);
  now+=1000;assert.equal((await retry()).count,1);
});

test('Only selected groups are collected; warning and unavailable states remain honest',async()=>{
  let selected={service:true,resources:false,files:true,storage:false,backup:true},files=0,backup=0,ready=true;
  const report=createHealthReporter({config:()=>({monitoring:{sections:selected}}),checkReadiness:()=>ready,sources:{
    files:async()=>{files++;return {originalCount:3,trashCount:1};},
    backup:async()=>{backup++;return {status:'failed',lastSuccessAt:null};},
    storage:()=>{throw Error('/secret/config.yaml');},
    resources:()=>assert.fail('unselected resources must not run'),
  }});
  const [one,two]=await Promise.all([report(),report()]);
  assert.equal(one.httpStatus,200);assert.equal(one.data.status,'warning');assert.deepEqual(one.data.warnings,['backup_failed']);
  assert.equal(one.data.storage,undefined);assert.equal(one.data.files.originalCount,3);assert.equal(files,1);assert.equal(backup,1);
  assert.equal(one.data.files.collectedAt,two.data.files.collectedAt);
  selected={service:false,storage:true};
  const unknown=await report();assert.equal(unknown.data.storage.status,'unknown');assert.equal(unknown.data.storage.collectedAt,null);
  assert.ok(!JSON.stringify(unknown).includes('/secret/'));assert.equal(unknown.data.service,undefined);
  ready=false;const down=await report();assert.equal(down.httpStatus,503);assert.equal(down.data.status,'error');
});

test('Backup monitor distinguishes disabled, never run, success, partial and failure without private details',()=>{
  const {getBackupMonitorState}=require('../src/core/backup-service');
  const statusFile=path.join(config.DATA_DIR,'backup_status.json');
  const cfg=config.getConfig();
  try {
    config.setConfigOverride({...cfg,backup:{enabled:true,schedule:'03:00'}});
    assert.equal(getBackupMonitorState().status,'never_run');
    const completedAt='2026-11-01T03:00:00.000Z';
    for(const [record,status] of [[{success:true},'success'],[{success:true,rcloneSuccess:false},'partial'],[{success:false},'failed']]) {
      fs.writeFileSync(statusFile,JSON.stringify({...record,completedAt,lastSuccessAt:completedAt,archivePath:'/secret/path',logs:['private']}));
      const result=getBackupMonitorState();assert.equal(result.status,status);assert.equal(result.lastSuccessAt,completedAt);
      assert.ok(!JSON.stringify(result).includes('private'));assert.ok(!JSON.stringify(result).includes('/secret'));
    }
    config.setConfigOverride({...cfg,backup:{enabled:false}});assert.equal(getBackupMonitorState().status,'disabled');assert.equal(getBackupMonitorState().nextRunAt,null);
    fs.writeFileSync(statusFile,'broken');assert.throws(()=>getBackupMonitorState());
  } finally {config.setConfigOverride(null);fs.rmSync(statusFile,{force:true});}
});

test('HTTP health endpoint is public when enabled, read-only and exposes only selected groups',async(t)=>{
  const {app}=require('../src/server');
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base='http://127.0.0.1:'+server.address().port;
  let cookie;
  const call=async(url,{json,headers,...options}={})=>{
    const res=await fetch(base+url,{...options,headers:{...(json?{'Content-Type':'application/json'}:{}),...headers},...(json?{body:JSON.stringify(json)}:{}),signal:AbortSignal.timeout(10000)});
    const text=await res.text();return {status:res.status,headers:res.headers,text,data:res.headers.get('content-type')?.includes('application/json')?JSON.parse(text):null};
  };
  assert.equal((await call('/api/health')).status,404);
  const uploadToken='test-upload-token-only';
  const setup=await call('/api/platform/setup',{method:'POST',json:{username:'monitor-tester',password:'test-password-only',api_token:uploadToken,base_url:base}});
  assert.equal(setup.status,200,setup.text);cookie=setup.headers.get('set-cookie').split(';')[0];
  const patch=async(value)=>{
    const res=await call('/api/platform/config',{method:'PUT',headers:{Cookie:cookie,Origin:base},json:{mode:'form',patch:value}});
    assert.equal(res.status,200,res.text);cookie=res.headers.get('set-cookie')?.split(';')[0]||cookie;
  };
  await patch({monitoring:{enabled:true,sections:{service:true,files:true,storage:true,backup:true}}});
  assert.equal((await call('/api/platform/health-preview')).status,401);
  assert.equal((await call('/api/platform/config')).status,401);
  assert.equal((await call('/api/image/upload',{method:'POST'})).status,401);
  const {RAW_DIR,CACHE_DIR}=require('../src/modules/image-host/asset-paths');
  const originals=path.join(RAW_DIR,'2026','11');fs.mkdirSync(originals,{recursive:true});fs.writeFileSync(path.join(originals,'private-name.png'),'test-image-bytes');
  fs.mkdirSync(CACHE_DIR,{recursive:true});fs.writeFileSync(path.join(CACHE_DIR,'private-cache.webp'),'cache');
  const dataBefore=fs.readdirSync(config.DATA_DIR).sort();
  const health=await call('/api/health');
  assert.equal(health.status,200,health.text);assert.equal(health.headers.get('cache-control'),'no-store');
  assert.equal(health.data.status,'ok');assert.equal(health.data.files.originalCount,1);assert.equal(health.data.files.trashCount,0);
  assert.equal(health.data.storage.originalBytes,16);assert.equal(health.data.storage.cacheBytes,5);
  assert.equal(health.data.backup.status,'never_run');assert.equal(health.data.resources,undefined);
  assert.deepEqual(fs.readdirSync(config.DATA_DIR).sort(),dataBefore,'Polling must not create indexes or alias state');
  for(const secret of [uploadToken,'private-name','private-cache',root,'archivePath','rclone_target'])assert.ok(!health.text.includes(secret),secret);
  const preview=await call('/api/platform/health-preview',{headers:{Cookie:cookie}});assert.equal(preview.status,200);assert.equal(preview.data.httpStatus,200);assert.equal(preview.data.data.files.originalCount,1);
  await patch({monitoring:{sections:{files:false,storage:false,backup:false,service:false}}});
  const minimal=await call('/api/health');assert.equal(minimal.status,200);
  assert.deepEqual(Object.keys(minimal.data).sort(),['checkedAt','schemaVersion','status','warnings']);
  try {
    fs.renameSync(RAW_DIR,RAW_DIR+'-offline');
    const unavailable=await call('/api/health');assert.equal(unavailable.status,503);assert.equal(unavailable.data.status,'error');
  } finally {fs.renameSync(RAW_DIR+'-offline',RAW_DIR);}
  await patch({monitoring:{enabled:false}});assert.equal((await call('/api/health')).status,404);
});
