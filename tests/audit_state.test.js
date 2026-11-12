const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {DATA_DIR,readCriticalJsonData,writeJsonData,getConfig,setConfigOverride} = require('../src/core/config');
const {getProtectedMap,setItemLockState} = require('../src/modules/image-host/protection');
const {getShaIndex,updateShaIndex,pathToShaMap} = require('../src/modules/image-host/sha-index');
const {getSharesMap,saveSharesMap} = require('../src/modules/share');
const security = require('../src/core/security');
const file = name => path.join(DATA_DIR,name+'.json');
const response = () => ({statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}});

test('Corrupt locks and invalid schemas block mutations and preserve evidence',()=>{
  setItemLockState('2026','11','original.png',true);
  const original=fs.readFileSync(file('protected_files'));
  for(const broken of ['{bad','[]','{"2026/11/original.png":null}']) {
    fs.writeFileSync(file('protected_files'),broken);
    assert.throws(getProtectedMap,{code:'STATE_INVALID'});
    assert.throws(()=>setItemLockState('2026','11','new.png',true),{code:'STATE_INVALID'});
    assert.equal(fs.readFileSync(file('protected_files'),'utf8'),broken);
  }
  fs.writeFileSync(file('protected_files'),original);
  assert.ok(getProtectedMap()['2026/11/original.png']);
});

test('Corrupt SHA indexes cannot initialize or overwrite a cached integrity baseline',()=>{
  const sha='a'.repeat(64),baseline='b'.repeat(64);
  updateShaIndex(sha,{year:'2026',month:'11',filename:'baseline.png',size:1,mtimeMs:1,baselineSha256:baseline});
  const original=fs.readFileSync(file('sha_index'));
  for(const broken of ['{bad','{"version":2,"files":{"2026/11/baseline.png":{}}}']) {
    fs.writeFileSync(file('sha_index'),broken);
    assert.throws(getShaIndex,{code:'STATE_INVALID'});
    assert.throws(()=>updateShaIndex(sha,{year:'2026',month:'11',filename:'other.png',size:2,mtimeMs:2}),{code:'STATE_INVALID'});
    assert.equal(fs.readFileSync(file('sha_index'),'utf8'),broken);
  }
  fs.writeFileSync(file('sha_index'),original);getShaIndex();
  assert.equal(pathToShaMap.get('2026/11/baseline.png').baselineSha256,baseline);
});

test('Corrupt shares cannot return a stale authorization map or be overwritten by a delayed flush',()=>{
  saveSharesMap({});getSharesMap();
  fs.writeFileSync(file('shares'),'{bad');
  assert.throws(getSharesMap,{code:'STATE_INVALID'});
  assert.throws(()=>saveSharesMap({}),{code:'STATE_INVALID'});
  assert.equal(fs.readFileSync(file('shares'),'utf8'),'{bad');
  writeJsonData('shares',{});
});

test('Revocation corruption fails closed and never resets stored revocations',()=>{
  const cfg=getConfig(),token=security.createSessionToken(cfg);
  const original=fs.existsSync(file('revoked_sessions'))?fs.readFileSync(file('revoked_sessions')):null;
  try {
    for(const broken of ['{bad','{}']) {
      fs.writeFileSync(file('revoked_sessions'),broken);
      assert.throws(()=>security.verifySessionToken(token,cfg),{code:'STATE_INVALID'});
      assert.throws(()=>security.revokeSessionToken(token),{code:'STATE_INVALID'});
      assert.equal(fs.readFileSync(file('revoked_sessions'),'utf8'),broken);
    }
  } finally {if(original)fs.writeFileSync(file('revoked_sessions'),original);else fs.rmSync(file('revoked_sessions'),{force:true});}
});

test('Missing optional state is distinct from malformed existing JSON',()=>{
  assert.deepEqual(readCriticalJsonData('new_state',{}),{});
  fs.writeFileSync(file('new_state'),'null');
  assert.throws(()=>readCriticalJsonData('new_state',{}),{code:'STATE_INVALID'});
});

test('Anonymous API access does not ban IPs; invalid supplied tokens still do; valid sessions bypass that ban',()=>{
  const cfg=getConfig();setConfigOverride({...cfg,api_token:'test-api-token',max_login_attempts:3});
  const ip='192.0.2.37',req={ip,headers:{}};
  try {
    for(let i=0;i<8;i++) {const res=response();security.requireApiOrAdmin(req,res,()=>assert.fail('anonymous allowed'));assert.equal(res.statusCode,401);}
    assert.equal(security.checkIpBan(ip).banned,false);
    for(let i=0;i<3;i++) security.requireApiOrAdmin({...req,headers:{authorization:'Bearer wrong'}},response(),()=>assert.fail('invalid token allowed'));
    assert.equal(security.checkIpBan(ip).banned,true);
    const token=security.createSessionToken(getConfig()),admin={ip,headers:{cookie:'filemaster_session='+token}};
    for(const middleware of [security.requireAdmin,security.requireApiOrAdmin]) {
      let allowed=false;middleware(admin,response(),()=>{allowed=true;});assert.equal(allowed,true);
    }
    security.revokeSessionToken(token);
    let allowed=false;security.requireAdmin(admin,response(),()=>{allowed=true;});assert.equal(allowed,false);
  } finally {security.clearLoginFailures(ip);setConfigOverride(null);}
});

test('Corrupt name registry is detected after a warm cache and is not overwritten',()=>{
  const {readNameState,saveNameState}=require('../src/modules/image-host/asset-names');
  const saved=readNameState();saveNameState(saved);
  const original=fs.readFileSync(file('asset_names'));
  try {
    for(const broken of ['{bad','{"version":1}']) {
      fs.writeFileSync(file('asset_names'),broken);
      assert.throws(readNameState,{code:'STATE_INVALID'});assert.throws(()=>saveNameState(saved),{code:'STATE_INVALID'});
      assert.equal(fs.readFileSync(file('asset_names'),'utf8'),broken);
    }
  } finally {fs.writeFileSync(file('asset_names'),original);}
});
test('Corrupt persisted session salt blocks startup without replacing it',()=>{
  const {spawnSync}=require('node:child_process');
  const original=fs.readFileSync(file('security_meta'));
  try {
    fs.writeFileSync(file('security_meta'),'{bad');
    const child=spawnSync(process.execPath,['-e',"require('./src/core/security')"],{cwd:path.resolve(__dirname,'..'),encoding:'utf8'});
    assert.notEqual(child.status,0);assert.match(child.stderr,/security_meta.json/);
    assert.equal(fs.readFileSync(file('security_meta'),'utf8'),'{bad');
  } finally {fs.writeFileSync(file('security_meta'),original);}
});
