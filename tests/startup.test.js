const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const YAML = require('yaml');
const {startupMessage} = require('../src/core/startup-message');
const config = require('../src/core/config');
const root=fs.realpathSync(path.resolve(__dirname,'..'));
assert.equal(process.env.FILE_MASTER_TEST_ROOT,root,'Run npm test: startup requires an isolated project');
const options={port:43210,version:'1.1.5',networkAddress:'http://192.0.2.1:43210',initialized:true,storageDir:config.STORAGE_DIR};

test('Terminal language survives normalization, form saves and aliases',()=>{
  for(const [language,expected] of [['zh','zh'],['en','en'],['zh-CN','zh'],['en-US','en']]){
    assert.equal(config.prepareConfigPatch({language}).config.language,expected);
    assert.equal(config.prepareRawConfigYaml(YAML.stringify({language})).config.language,expected);
  }
  assert.equal(config.prepareRawConfigYaml('{}').config.language,'en');
  assert.throws(()=>config.prepareConfigPatch({language:'invalid'}),/Terminal language/);
});

test('Startup summary uses one language and prints health only when configured',()=>{
  const cfg={...config.getConfig(),base_url:'https://files.example',monitoring:{enabled:true}};
  const zh=startupMessage({...cfg,language:'zh'},options);
  assert.match(zh,/监控接口:\s+https:\/\/files.example\/api\/health/);
  assert.match(zh,/管理后台:/);assert.doesNotMatch(zh,/Admin:|Upload:|Storage:|Press Ctrl/);
  const en=startupMessage({...cfg,language:'en'},options);
  assert.match(en,/Health:\s+https:\/\/files.example\/api\/health/);assert.doesNotMatch(en,/[\u4e00-\u9fff]/);
  const disabled=startupMessage({...cfg,monitoring:{enabled:false}},options);assert.doesNotMatch(disabled,/api\/health/);
  const wizard=startupMessage({...cfg,language:'zh'},{...options,initialized:false});assert.match(wizard,/初始化/);assert.doesNotMatch(wizard,/api\/health/);
  const localhost=startupMessage({...cfg,base_url:'http://localhost:3210'},options);assert.match(localhost,/http:\/\/localhost:43210\/api\/health/);
});

test('Actual CLI startup follows config rather than OS locale and exposes the advertised health route',async()=>{
  for(const [language,enabled] of [['zh',true],['en',false]]) {
    fs.writeFileSync(config.CONFIG_PATH,config.prepareConfigPatch({language,monitoring:{enabled},backup:{enabled:false}}).yaml);
    const child=spawn(process.execPath,['src/server.js'],{cwd:root,env:{...process.env,PORT:'0',LANG:language==='zh'?'en_US.UTF-8':'zh_CN.UTF-8'},stdio:['ignore','pipe','pipe']});
    const exit=once(child,'exit');
    let output='',errors='';
    child.stderr.on('data',chunk=>errors+=chunk);
    try {
      await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Error('Startup timed out: '+output+errors)),10000);
        child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('Ctrl+C')){clearTimeout(timeout);resolve();}});
        child.once('exit',code=>{clearTimeout(timeout);reject(Error('Exited '+code+': '+errors));});
        child.once('error',error=>{clearTimeout(timeout);reject(error);});
      });
      if(language==='zh') {
        assert.match(output,/存储检查通过/);assert.match(output,/监控接口:/);assert.doesNotMatch(output,/Storage probe passed|Admin:/);
      } else {assert.match(output,/Storage probe passed/);assert.match(output,/Admin:/);assert.doesNotMatch(output,/api\/health|[\u4e00-\u9fff]/);}
      const base=output.match(/http:\/\/localhost:\d+/)?.[0];assert.ok(base,output);
      const response=await fetch(base+'/api/health',{signal:AbortSignal.timeout(5000)});
      assert.equal(response.status,enabled?200:404);
    } finally {child.kill('SIGTERM');await exit;}
  }
});
