const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createFixture, openFixture } = require('./helpers/updater-fixture');

function assertAssets(f) {
  assert.equal(f.read('watermark.png'), 'custom watermark');
  assert.match(f.read('config.yaml'), /password: user-secret/);
  assert.equal(f.updater.isUpdateInProgress(), false);
}

test('Update success preserves assets, merges defaults and installs changed dependencies in order', async (t) => {
  const f = createFixture(t);
  f.faults.changeDeps = true;
  const result = await f.updater.performHotUpdate();
  assert.equal(result.success, true);
  assert.equal(result.depsUpdated, true);
  assert.equal(result.version, '1.0.2');
  assertAssets(f);
  assert.match(f.read('config.yaml'), /# user comment/);
  assert.match(f.read('config.yaml'), /new_default: enabled/);
  assert.match(f.read('config.yaml'), /webp_quality: 80/);
  assert.equal(f.pending(), false);
  assert.equal(fs.existsSync(path.join(f.rootDir, 'data/config.backup.yaml')), false);
  const commands = f.calls.map((call) => call[1]);
  assert.ok(commands.indexOf('fetch') < commands.indexOf('reset'));
  assert.ok(commands.indexOf('reset') < commands.indexOf('install'));
});

test('Unchanged dependencies skip npm and concurrent requests share one update lock', async (t) => {
  const f = createFixture(t);
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const updater = openFixture(f.rootDir, async (cmd, args) => {
    if (args[0] === 'fetch') { entered(); await gate; }
    return { stdout: args[0] === 'rev-parse' && args.includes('FETCH_HEAD^{commit}') ? 'a'.repeat(40) : 'same', stderr: '' };
  });
  const first = updater.performHotUpdate();
  await started;
  assert.equal(updater.isUpdateInProgress(), true);
  assert.equal((await updater.getUpdateStatus()).updateInProgress, true);
  await assert.rejects(updater.performHotUpdate(), /already in progress/);
  release();
  assert.equal((await first).depsUpdated, false);
  assert.equal(updater.isUpdateInProgress(), false);
});

for (const command of ['fetch', 'reset']) {
  test(`${command} failure restores assets and preserves any uncertain install obligation`, async (t) => {
    const f = createFixture(t);
    f.faults.fail = command;
    await assert.rejects(f.updater.performHotUpdate(), new RegExp(`simulated ${command} failure`));
    assertAssets(f);
    assert.equal(f.read('config.yaml'), f.original);
    assert.equal(f.pending(), command === 'reset');
  });
}

test('Dependency installation failure reports failure and preserves user assets without claiming code rollback', async (t) => {
  const f = createFixture(t);
  f.faults.changeDeps = true;
  f.faults.install = true;
  f.faults.duringInstall = () => {
    assert.equal(f.pending(), true);
    assert.equal(fs.existsSync(path.join(f.rootDir, 'data/config.backup.yaml')), true);
  };
  await assert.rejects(f.updater.performHotUpdate(), /dependency install failure/);
  assertAssets(f);
  assert.equal(JSON.parse(f.read('package.json')).version, '1.0.2');
});

test('Config restoration failure keeps durable backups and supports a later recovery attempt', async (t) => {
  const f = createFixture(t);
  f.faults.afterReset = () => { f.faults.save = true; };
  await assert.rejects(f.updater.performHotUpdate(), /config restore failure/);
  assert.equal(f.pending(), true);
  assert.equal(f.updater.isUpdateInProgress(), false);
  assert.equal(f.updater.recoverInterruptedUpdate().success, true);
  assertAssets(f);
  assert.equal(f.read('config.yaml'), f.original);
});

test('Watermark write failure preserves the marker until complete disk recovery succeeds', async (t) => {
  const f = createFixture(t);
  f.faults.afterReset = () => {
    fs.unlinkSync(path.join(f.rootDir, 'watermark.png'));
    fs.mkdirSync(path.join(f.rootDir, 'watermark.png'));
  };
  await assert.rejects(f.updater.performHotUpdate(), /watermark files/);
  assert.equal(f.pending(), true);
  assert.equal(f.updater.isUpdateInProgress(), false);
  assert.equal(f.updater.recoverInterruptedUpdate().success, false);
  assert.equal(f.pending(), true);
  fs.rmdirSync(path.join(f.rootDir, 'watermark.png'));
  assert.equal(f.updater.recoverInterruptedUpdate().success, true);
  assertAssets(f);
});

test('A process exit immediately after reset leaves backups recoverable in a fresh process', (t) => {
  const f = createFixture(t);
  const helper = path.join(__dirname, 'helpers/updater-fixture.js');
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs'), path = require('node:path');
    const { openFixture } = require(process.env.FM_UPDATER_HELPER);
    const root = process.env.FM_UPDATER_ROOT;
    openFixture(root, async (cmd, args) => {
      if (args[0] === 'reset') {
        fs.writeFileSync(path.join(root, 'config.yaml'), 'port: 9999\\n');
        fs.writeFileSync(path.join(root, 'watermark.png'), 'upstream');
        process.exit(27);
      }
      return { stdout: args[0] === 'rev-parse' ? 'a'.repeat(40) : 'before', stderr: '' };
    }).performHotUpdate().catch(() => process.exit(1));
  `], { env: { ...process.env, FM_UPDATER_HELPER: helper, FM_UPDATER_ROOT: f.rootDir }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 27, child.stderr);
  assert.equal(f.pending(), true);
  assert.equal(f.read('watermark.png'), 'upstream');
  const fresh = openFixture(f.rootDir, async () => { throw new Error('recovery must not invoke git or npm'); });
  assert.equal(fresh.recoverInterruptedUpdate().success, true);
  assertAssets(f);
  assert.equal(f.pending(), true, 'a reset interrupted before hash comparison requires dependency installation');
  assert.equal(fresh.recoverInterruptedUpdate().dependenciesPending, true);
});

test('Offline Git integration fetches a local upstream and restores tracked custom watermarks after reset', async (t) => {
  const f = createFixture(t);
  fs.rmSync(path.join(f.rootDir, '.git'), { recursive: true });
  const upstream = path.join(f.rootDir, 'upstream');
  fs.mkdirSync(upstream);
  const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(upstream, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(upstream, 'package.json'), '{"version":"2.0.0"}');
  fs.writeFileSync(path.join(upstream, 'config.example.yaml'), 'port: 9999\nnew_default: enabled\n');
  fs.writeFileSync(path.join(upstream, 'watermark.png'), 'upstream watermark');
  git(upstream, ['add', '.']);
  git(upstream, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'upstream']);
  const updater = openFixture(f.rootDir, async (cmd, args) => {
    if (cmd !== 'git') return { stdout: '', stderr: '' };
    const actual = [...args];
    if (args[0] === 'fetch') actual[actual.length - 2] = upstream;
    return { stdout: git(f.rootDir, actual), stderr: '' };
  }, {}, async () => git(upstream,['rev-parse','HEAD']));
  assert.equal((await updater.performHotUpdate()).success, true);
  assert.equal(git(f.rootDir, ['rev-parse', 'HEAD']), git(upstream, ['rev-parse', 'HEAD']));
  assertAssets(f);
  assert.equal(updater.readPackageVersion(), '2.0.0');
});


test('Failed install survives restart and retries npm even when dependency hashes are unchanged', async (t) => {
  const f = createFixture(t);
  f.faults.changeDeps = true;
  f.faults.install = true;
  f.faults.duringInstall = () => {
    assert.equal(f.pending(), true);
    assert.equal(fs.existsSync(path.join(f.rootDir, 'data/config.backup.yaml')), true);
  };
  await assert.rejects(f.updater.performHotUpdate(), /dependency install failure/);
  assert.equal(f.pending(), true);
  assert.match(f.read('config.yaml'), /new_default: enabled/, 'install failure must not undo a successful config merge');
  assert.equal((await f.updater.getUpdateStatus()).dependenciesPending, true);
  const edited = f.read('config.yaml').replace('user-secret', 'new-secret');
  f.write('config.yaml', edited);
  const fresh = openFixture(f.rootDir, async () => ({ stdout: 'same', stderr: '' }));
  assert.equal(fresh.recoverInterruptedUpdate().dependenciesPending, true);
  assert.equal(f.read('config.yaml'), edited, 'restart must not overwrite post-recovery user edits');
  assert.equal((await fresh.getUpdateStatus()).dependenciesPending, true);
  f.faults.install = false;
  const installsBefore = f.calls.filter(([cmd]) => cmd.startsWith('npm')).length;
  assert.equal((await f.updater.performHotUpdate()).depsUpdated, true);
  assert.equal(f.calls.filter(([cmd]) => cmd.startsWith('npm')).length, installsBefore + 1);
  assert.equal(f.pending(), false);
  assert.equal((await f.updater.getUpdateStatus()).dependenciesPending, false);
  assert.match(f.read('config.yaml'), /new-secret/);
});

test('Unrecoverable assets block a new update before it overwrites the durable backups', async (t) => {
  const f = createFixture(t);
  fs.mkdirSync(path.join(f.rootDir, 'data'));
  f.write('data/update_pending_restore.flag', 'pending');
  await assert.rejects(f.updater.performHotUpdate(), /Cannot update until user assets are recovered/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.pending(), true);
  assert.equal(f.updater.isUpdateInProgress(), false);
});


test('Malformed update state blocks updates and preserves backup evidence', async (t) => {
  const f = createFixture(t);
  fs.mkdirSync(path.join(f.rootDir, 'data'));
  f.write('data/config.backup.yaml', 'saved evidence');
  f.write('data/update_pending_restore.flag', '{invalid');
  await assert.rejects(f.updater.performHotUpdate(), /Cannot update until user assets are recovered/);
  assert.equal(f.read('data/config.backup.yaml'), 'saved evidence');
  assert.equal(f.calls.length, 0);
});

test('Update check includes remote version and separate multiline commit bodies',async t=>{
  const f=createFixture(t),hash='a'.repeat(40),other='b'.repeat(40);
  const updater=openFixture(f.rootDir,async(cmd,args)=>{
    let stdout='';
    if(args[0]==='log'&&args.includes('HEAD..FETCH_HEAD'))stdout=`${hash}\0优化预览\0支持拖动与缩放。\n\n保留第二段说明。\0\n${other}\0修复导航\0\0\n`;
    else if(args[0]==='log')stdout=args.includes('FETCH_HEAD')?`${hash}|aaaaaaa|优化预览|2026-11-11`:'old|old|旧版|2026-11-10';
    else if(args[0]==='show')stdout='{"version":"1.2.0"}';
    else if(args[0]==='rev-list')stdout='2';
    else if(args[0]==='rev-parse')stdout=hash;
    return {stdout,stderr:''};
  });
  const data=await updater.getUpdateStatus({fetchRemote:true});
  assert.equal(data.remoteVersion,'1.2.0');assert.equal(data.hasUpdate,true);assert.equal(data.commitsBehind,2);
  assert.deepEqual(data.incomingChanges,[{hash,title:'优化预览',body:'支持拖动与缩放。\n\n保留第二段说明。'},{hash:other,title:'修复导航',body:''}]);
  assert.deepEqual(data.incomingCommits,['aaaaaaa 优化预览','bbbbbbb 修复导航']);
});

test('An untrusted mirror cannot install a different commit, even with the same short prefix',async t=>{
  const f=createFixture(t);f.faults.fetchedCommit='a'.repeat(7)+'b'.repeat(33);
  await assert.rejects(f.updater.performHotUpdate({upstream_mirror:'https://untrusted.example'}),/does not match the official branch/);
  assert.ok(!f.calls.some(call=>call[1]==='reset'));assert.ok(!f.calls.some(call=>call[0].startsWith('npm')));
  assertAssets(f);assert.equal(f.pending(),false);
});
test('Official verification failure blocks fetching and installation without insecure fallback',async t=>{
  const f=createFixture(t);
  const updater=openFixture(f.rootDir,async(cmd,args)=>{f.calls.push([cmd,...args]);return {stdout:'',stderr:''};},{},async()=>{throw new Error('official source unreachable');});
  await assert.rejects(updater.performHotUpdate({upstream_mirror:'https://untrusted.example'}),/official source unreachable/);
  assert.ok(!f.calls.some(call=>['fetch','reset'].includes(call[1])));assertAssets(f);
});
