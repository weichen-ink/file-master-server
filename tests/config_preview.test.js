const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  CONFIG_PATH,
  prepareRawConfigYaml,
  prepareConfigPatch
} = require('../src/core/config');

test('Config preview validates and normalizes without writing config.yaml', () => {
  const writeFileSync = fs.writeFileSync;
  fs.writeFileSync = function (file, ...args) {
    if (file === CONFIG_PATH || file === `${CONFIG_PATH}.tmp`) {
      throw new Error('Config preview attempted to write config.yaml');
    }
    return writeFileSync.call(this, file, ...args);
  };

  try {
    assert.throws(() => prepareRawConfigYaml('invalid scalar'), /root element must be a key-value object/);
    assert.throws(() => prepareRawConfigYaml('image_host: invalid\n'), /image_host must be a key-value object/);
    assert.throws(
      () => prepareRawConfigYaml('image_host:\n  watermark_image: ../../outside.png\n'),
      /Invalid watermark_image path/
    );

    const prepared = prepareConfigPatch({ image_host: { max_width: 640 } });
    assert.equal(prepared.config.image_host.max_width, 640);
    assert.equal(prepared.config.image_host.webp_quality > 0, true);

    assert.equal(prepareConfigPatch({image_host:{rename_alias_days:14}}).config.image_host.rename_alias_days,14);
    for(const days of [0,-1,1.5,366,'seven']) assert.throws(()=>prepareConfigPatch({image_host:{rename_alias_days:days}}), /whole number/);

    const credentials = prepareConfigPatch({ password: 'new-password' });
    assert.match(credentials.config.password, /^scrypt:/);
  } finally {
    fs.writeFileSync = writeFileSync;
  }
});

test('Cold process rejects invalid initialized config without logging source credentials or reopening setup', () => {
  const path = require('node:path');
  const {execFileSync} = require('node:child_process');
  const root = fs.realpathSync(path.resolve(__dirname,'..'));
  assert.equal(process.env.FILE_MASTER_TEST_ROOT,root,'Run npm test: cold config tests require an isolated project');
  const file = path.join(root,'cold-invalid.yaml');
  const script = `const assert=require('node:assert/strict');
const config=require('./src/core/config');
assert.equal(config.isConfigInitialized(),true);
assert.throws(()=>config.getConfig(),error=>error.status===503 && error.code==='CONFIG_INVALID' && !error.message.includes('cold-secret'));
assert.throws(()=>config.initializeConfigFromSetup({password:'must-not-reinitialize'}),/already initialized/);
console.log('safe-failure');`;
  try {
    for(const raw of ['', '# comment', '123', '[a,b]', 'username: admin\napi_token: cold-secret', 'api_token: cold-secret: typo']) {
      fs.writeFileSync(file,raw);
      const out=execFileSync(process.execPath,['-e',script],{cwd:root,env:{...process.env,FILE_MASTER_CONFIG_PATH:file},encoding:'utf8',stdio:['ignore','pipe','pipe']});
      assert.equal(out.trim(),'safe-failure');
      assert.equal(fs.readFileSync(file,'utf8'),raw);
    }
  } finally {fs.rmSync(file,{force:true});}
});


test('Runtime config deletion does not silently remigrate a legacy file or reopen setup', () => {
  const path = require('node:path');
  const {execFileSync} = require('node:child_process');
  const root = fs.realpathSync(path.resolve(__dirname,'..'));
  assert.equal(process.env.FILE_MASTER_TEST_ROOT,root);
  const legacy=path.join(root,'config.yaml'), target=path.join(root,'migrated','config.yaml');
  fs.writeFileSync(legacy,'username: migration-test\npassword: synthetic-password\napi_token: synthetic-token\n');
  try {
    const out=execFileSync(process.execPath,['-e',`
const fs=require('node:fs'),assert=require('node:assert/strict'),config=require('./src/core/config');
const good=config.getConfig();
assert.equal(good.username,'migration-test');
fs.rmSync(config.CONFIG_PATH);
assert.deepEqual(config.getConfig(),good);
assert.equal(config.isConfigInitialized(),true);
assert.throws(()=>config.getRawConfigYaml(),{code:'CONFIG_INVALID'});
assert.equal(fs.existsSync(config.CONFIG_PATH),false);
console.log('safe-migration');
`],{cwd:root,env:{...process.env,FILE_MASTER_CONFIG_PATH:target},encoding:'utf8'});
    assert.equal(out.trim(),'safe-migration');
  } finally {fs.rmSync(legacy,{force:true});fs.rmSync(path.dirname(target),{recursive:true,force:true});}
});
