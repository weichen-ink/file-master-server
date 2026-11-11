const test = require('node:test');
const assert = require('node:assert/strict');
const {cpuUsageBetween} = require('../src/core/cpu-usage');
const ui = name => import('../src/public/assets/admin/features/' + name + '.mjs');

test('CPU usage measures busy/idle tick deltas and rejects unavailable samples', () => {
  const cpu = (user, idle) => ({times:{user, idle, nice:0, sys:0, irq:0}});
  assert.equal(cpuUsageBetween([cpu(100,100)], [cpu(125,175)]),25);
  assert.equal(cpuUsageBetween([cpu(100,100)], [cpu(100,200)]),0);
  assert.equal(cpuUsageBetween([cpu(100,100)], [cpu(200,100)]),100);
  assert.equal(cpuUsageBetween([],[]),null);
  assert.equal(cpuUsageBetween([cpu(100,100)],[cpu(100,100)]),null);
  assert.equal(cpuUsageBetween([cpu(100,100)],[cpu(0,200)]),null);
  assert.equal(cpuUsageBetween([cpu(100,100)],[]),null);
});

test('Archive year/month hierarchy has stable order and aggregate counts', async () => {
  const {archiveGroups} = await ui('files');
  assert.deepEqual(archiveGroups([
    {year:'2026',month:'01'}, {year:'2025',month:'12'},
    {year:'2026',month:'11'}, {year:'2026',month:'11'},
  ]),[
    {key:'2026',count:3,months:[{key:'11',count:2},{key:'01',count:1}]},
    {key:'2025',count:1,months:[{key:'12',count:1}]},
  ]);
});

test('Disabling a mirror clears the effective URL; custom and preset URLs remain distinct', async () => {
  const {sectionValues,sectionPatch} = await ui('settings-schema');
  for(const upstream_mirror of ['', 'https://ghproxy.net/','https://mirror.example/']) {
    const values=sectionValues('updates',{upstream_mirror});
    assert.deepEqual(sectionPatch('updates',values),{upstream_mirror});
    assert.deepEqual(sectionPatch('updates',{...values,mirror_enabled:false}),{upstream_mirror:''});
  }
});

test('Unavailable resources stay unknown rather than becoming zero usage', async () => {
  const {resourceMeter} = await ui('operations');
  assert.match(resourceMeter('cpuUsage',null,''), /aria-valuetext=/);
  assert.doesNotMatch(resourceMeter('cpuUsage',null,''), /aria-valuenow=/);
  assert.match(resourceMeter('cpuUsage',0,''), /aria-valuenow="0"/);
});

test('Restart is submitted once and succeeds only after the service start changes', async () => {
  const {restartAndReconnect} = await ui('service-control');
  let posts=0,reads=0,refreshed=0;
  const progress=[];
  const ctx={api:{
    metrics:async()=>({site:{startedAt:++reads<3?100:200}}),
    restart:async()=>{posts++;return {};},
  },refreshStatus:async()=>refreshed++};
  await restartAndReconnect(ctx,new AbortController().signal,{wait:async()=>{},onProgress:text=>progress.push(text)});
  assert.equal(posts,1);assert.equal(reads,3);assert.equal(refreshed,1);
  assert.equal(progress.length,2);
});

test('A restart acknowledgement alone never reports successful reconnection', async () => {
  const {restartAndReconnect} = await ui('service-control');
  let posts=0,refreshed=0;
  const ctx={api:{metrics:async()=>({site:{startedAt:100}}),restart:async()=>{posts++;return {};}},refreshStatus:async()=>refreshed++};
  await assert.rejects(restartAndReconnect(ctx,new AbortController().signal,{wait:async()=>{}}));
  assert.equal(posts,1);assert.equal(refreshed,0);
});

test('Leaving a page aborts reconnect polling and cannot repeat an installation', async () => {
  const {restartAndReconnect} = await ui('service-control');
  const controller=new AbortController();
  let installs=0,reads=0;
  const ctx={api:{metrics:async()=>{reads++;return {site:{startedAt:100}};},install:async()=>{installs++;return {};}},refreshStatus:async()=>assert.fail('must not refresh')};
  await assert.rejects(restartAndReconnect(ctx,controller.signal,{install:true,wait:async()=>controller.abort()}),{name:'AbortError'});
  assert.equal(installs,1);assert.equal(reads,1);
});

test('Share states handle missing files, exact expiry, unlimited and exhausted downloads',async()=>{
  const {shareState}=await ui('operations');
  const item={expiresAt:1000,maxDownloads:3,downloads:2};
  assert.equal(shareState(item,999),'active');
  assert.equal(shareState(item,1000),'expired');
  assert.equal(shareState({...item,expiresAt:0,downloads:3},1000),'quotaUsed');
  assert.equal(shareState({...item,expiresAt:0,maxDownloads:0,downloads:999},1000),'active');
  assert.equal(shareState({...item,fileExists:false},999),'fileMissing');
});

test('Merged client routes and navigation share one settings entry',async()=>{
  const {parseRoute}=await import('../src/public/assets/admin/router.mjs');
  const {groups,routeHref}=await import('../src/public/assets/admin/navigation.mjs');
  for(const client of ['obsidian','piclist','http']){
    const route=parseRoute('#/integration?client='+client);
    assert.equal(route.page,'settings');assert.equal(route.section,'integration');
    assert.equal(routeHref(route),'#/settings/integration');
  }
  assert.equal(groups.flatMap(group=>group.children).filter(([,href])=>href.includes('integration')).length,1);
});

test('Release changes preserve title/body grouping and support older server responses',async()=>{
  const {releaseChanges}=await ui('operations');
  assert.deepEqual(releaseChanges({incomingChanges:[{title:'Preview',body:'first\n\nsecond',hash:'1234567890'}]}),[{title:'Preview',body:'first\n\nsecond',hash:'1234567'}]);
  assert.deepEqual(releaseChanges({incomingCommits:['abcdef0 Navigation']}),[{title:'Navigation',hash:'abcdef0',body:''}]);
});


test('Site settings own both credentials, preserve blanks and allow only their schema fields',async()=>{
  const {sectionValues,sectionPatch}=await ui('settings-schema');
  const cfg={site_name:'Test',base_url:'https://example.test',username:'admin',password:'masked',api_token:'masked',image_host:{raw_secret_path:'raw',pub_secret_path:'pub',enable_optimization:true,webp_quality:82}};
  const site=sectionValues('site',cfg);
  assert.equal(site.password,'');assert.equal(site.api_token,'');
  const patch=sectionPatch('site',{...site,unrelated:'must-not-send'});
  assert.ok(!('password' in patch));assert.ok(!('api_token' in patch));
  assert.equal(patch.username,'admin');assert.equal(patch.image_host.raw_secret_path,'raw');
  assert.ok(!('unrelated' in patch));
  const changed=sectionPatch('site',{...site,api_token:'new-test-token',password:'new-test-password'});
  assert.equal(changed.api_token,'new-test-token');assert.equal(changed.password,'new-test-password');
  assert.deepEqual(sectionPatch('media',{...sectionValues('media',cfg),webp_quality:70}).image_host.webp_quality,70);
});

test('Old settings and media bookmarks resolve to the consolidated pages',async()=>{
  const {parseRoute}=await import('../src/public/assets/admin/router.mjs');
  for(const url of ['#/settings/general','#/settings/security','#security']) assert.equal(parseRoute(url).section,'site');
  for(const url of ['#/media/compression','#/media/watermark','#media']) assert.deepEqual(parseRoute(url),{page:'settings',section:'media',query:{}});
});

test('Viewer presets, wheel zoom and dragging work below actual size and release listeners on navigation',async()=>{
  const {mountViewer}=await ui('viewer');
  const previous=global.ResizeObserver,controller=new AbortController();let disconnected=false;
  global.ResizeObserver=class {observe(){}disconnect(){disconnected=true;}};
  const target=extra=>({events:new Map(),style:{},classList:{toggle(){},add(){},remove(){}},addEventListener(type,fn,{signal}={}){this.events.set(type,fn);signal?.addEventListener('abort',()=>this.events.delete(type),{once:true});},...extra});
  const stage=target({clientWidth:832,clientHeight:632,setPointerCapture(){},getBoundingClientRect:()=>({left:0,top:0})});
  const image=target({naturalWidth:1600,naturalHeight:1200,complete:true}),scales=[];
  try {
    const viewer=mountViewer(stage,image,{signal:controller.signal,onScale:value=>scales.push(value)});
    assert.equal(scales.at(-1),50);viewer.setScale(25);assert.equal(scales.at(-1),25);
    stage.events.get('pointerdown')({button:0,pointerId:1,clientX:100,clientY:100});
    stage.events.get('pointermove')({pointerId:1,clientX:140,clientY:130});
    assert.match(image.style.transform,/translate\(40px,30px\) scale\(0.25\)/);
    stage.events.get('pointerup')();
    let prevented=false;stage.events.get('wheel')({deltaY:-100,clientX:416,clientY:316,preventDefault(){prevented=true;}});
    assert.equal(prevented,true);assert.equal(scales.at(-1),29);
    viewer.fit();assert.equal(scales.at(-1),50);assert.match(image.style.transform,/translate\(0px,0px\)/);
    controller.abort();assert.equal(disconnected,true);assert.equal(stage.events.size,0);
  } finally {controller.abort();global.ResizeObserver=previous;}
});

test('Theme preference follows system changes in auto mode and keeps an explicit choice',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),events={},root={dataset:{}};
  let saved='auto';const media={matches:false,addEventListener:(name,fn)=>events.media=fn};
  const window={matchMedia:()=>media,addEventListener:(name,fn)=>events[name]=fn};
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../src/public/assets/theme.js'),'utf8'),{window,document:{documentElement:root},localStorage:{getItem:()=>saved}});
  assert.equal(root.dataset.theme,'light');media.matches=true;events.media();assert.equal(root.dataset.theme,'dark');
  root.dataset.themePreference='light';events['filemaster-theme']();assert.equal(root.dataset.theme,'light');events.media();assert.equal(root.dataset.theme,'light');
  saved='dark';events.storage({key:'filemaster-theme'});assert.equal(root.dataset.themePreference,'dark');assert.equal(root.dataset.theme,'dark');
});


test('Update results distinguish version bumps from same-version commits and escape release notes',async()=>{
  const {releaseResult}=await ui('operations');
  const {setLocale}=await import('../src/public/assets/admin/locale.mjs');setLocale('zh');
  const data={version:'1.1.6',remoteVersion:'1.1.6',hasUpdate:true,incomingChanges:[{title:'<img onerror=unsafe>',body:'first\n\n<script>unsafe</script>',hash:'1234567890'}]};
  const same=releaseResult(data);
  assert.match(same,/有 1 项更新可用/);assert.doesNotMatch(same,/→/);
  assert.ok(!same.includes('<script>'));assert.ok(!same.includes('<img onerror='));assert.match(same,/&lt;script&gt;/);
  assert.equal((same.match(/data-action="install"/g)||[]).length,1);
  assert.match(releaseResult({...data,remoteVersion:'1.1.7'}),/release-target-version.*v1.1.7/);
  assert.match(releaseResult({...data,commitsBehind:20}),/有 20 项更新可用/);
  assert.doesNotMatch(same,/当前版本|更新内容|release-state-icon/);
  const latest=releaseResult({...data,hasUpdate:false});assert.ok(!latest.includes('data-action="install"'));assert.ok(!latest.includes('release-notes'));
});
