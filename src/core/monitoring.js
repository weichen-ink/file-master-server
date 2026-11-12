const fs = require('node:fs');
const { getConfig, STORAGE_DIR, DATA_DIR } = require('./config');
const { normalizeMonitoring, MONITOR_SECTIONS } = require('./monitor-config');
const { collectResourceMetrics, getDiskUsage, getDirSize } = require('./metrics');
const { getBackupMonitorState } = require('./backup-service');
const { getStorageHealth } = require('../modules/image-host/storage-health');
const { RAW_DIR, CACHE_DIR } = require('../modules/image-host/asset-paths');
const { TRASH_DIR } = require('./config');
const { walkOriginalFiles } = require('../modules/image-host/asset-files');
const { listTrashEntries } = require('../modules/image-host/trash');
const { cachedCatalogSummary } = require('../modules/image-host/catalog');
const version = require('../../package.json').version;
const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

// Cache shared work and coalesce concurrent polls; failures are briefly cached too.
function cachedCollector(collect, ttl, now = Date.now) {
  let entry;
  return () => {
    if (!entry || now() >= entry.expiresAt) {
      const current = { expiresAt:Infinity };
      current.promise = Promise.resolve().then(collect).then(value => {
        current.expiresAt = now() + ttl;
        return { collectedAt:new Date(now()).toISOString(), ...value };
      }, error => { current.expiresAt=now()+1000; throw error; });
      entry=current;
    }
    return entry.promise;
  };
}
const originalSummary = cachedCollector(async () => {
  const existing=cachedCatalogSummary();
  if(existing)return {count:existing.totalCount, bytes:existing.totalRawBytes};
  let count=0,bytes=0;
  // Count originals without hashing content, generating thumbnails or updating indexes.
  for await(const file of walkOriginalFiles(RAW_DIR,{checkCollisions:false})) {count++; bytes+=file.stat.size;}
  return {count,bytes};
},60000);
async function readiness() {
  const health=getStorageHealth();
  if(!health.checked || !health.atomicUploads)return false;
  try {
    await Promise.all([RAW_DIR,DATA_DIR].map(dir=>fs.promises.access(dir,fs.constants.R_OK|fs.constants.W_OK)));
    return true;
  } catch {return false;}
}
const collectors = {
  resources:async()=>{
    const {cpu,memory}=await collectResourceMetrics();
    return {cpu:{usagePercent:cpu.usagePercent,cores:cpu.cores},memory:{totalBytes:memory.total,usedBytes:memory.used,availableBytes:memory.free,usagePercent:memory.usagePercent},processMemoryBytes:process.memoryUsage().rss};
  },
  storage:async()=>{
    const disk=getDiskUsage(STORAGE_DIR);
    if(!disk)throw new Error('Disk statistics unavailable');
    const [raw,cacheBytes,trashBytes]=await Promise.all([originalSummary(),getDirSize(CACHE_DIR),getDirSize(TRASH_DIR)]);
    return {filesystem:{totalBytes:disk.total,availableBytes:disk.free,usedBytes:disk.used,usagePercent:disk.usagePercent},originalBytes:raw.bytes,cacheBytes,trashBytes};
  },
  files:async()=>({originalCount:(await originalSummary()).count,trashCount:listTrashEntries().length}),
  backup:async()=>getBackupMonitorState()
};

function createHealthReporter({config=getConfig, checkReadiness=readiness, sources=collectors, now=Date.now}={}) {
  const cached=Object.fromEntries(Object.entries(sources).map(([key,collect])=>[key,cachedCollector(collect,key==='resources'?15000:key==='backup'?5000:60000,now)]));
  return async function report() {
    const cfg=normalizeMonitoring(config().monitoring);
    const ready=await Promise.resolve().then(checkReadiness).catch(()=>false);
    const data={schemaVersion:1,status:ready?'ok':'error',checkedAt:new Date(now()).toISOString(),warnings:[]};
    if(!ready)data.warnings.push('service_unavailable');
    if(cfg.sections.service)data.service={status:ready?'ok':'error',version,startedAt,uptimeSeconds:Math.floor(process.uptime())};
    await Promise.all(MONITOR_SECTIONS.filter(key=>key!=='service' && cfg.sections[key]).map(async key=>{
      try {
        const snapshot=await cached[key]();
        data[key]=snapshot;
        if(key==='backup' && ['failed','partial','unknown'].includes(snapshot.status))data.warnings.push('backup_'+snapshot.status);
        if(key==='resources' && snapshot.cpu.usagePercent===null)data.warnings.push('cpu_unavailable');
      } catch {
        data[key]={status:'unknown',collectedAt:null};
        data.warnings.push(key+'_unavailable');
      }
    }));
    data.warnings.sort();
    if(ready && data.warnings.length)data.status='warning';
    return {httpStatus:ready?200:503,data};
  };
}
const reportHealth=createHealthReporter();
function registerMonitoringRoutes(app,requireAdmin) {
  const guarded=handler=>async(req,res)=>{
    try { await handler(req,res); }
    catch { res.status(503).json({schemaVersion:1,status:'error',checkedAt:new Date().toISOString(),warnings:['service_unavailable']}); }
  };
  app.get('/api/health',guarded(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    const monitoring=normalizeMonitoring(getConfig().monitoring);
    if(!monitoring.enabled)return res.status(404).json({error:'Not found'});
    const {httpStatus,data}=await reportHealth();res.status(httpStatus).json(data);
  }));
  app.get('/api/platform/health-preview',requireAdmin,guarded(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    const {httpStatus,data}=await reportHealth();res.json({httpStatus,data});
  }));
}
module.exports={createHealthReporter,registerMonitoringRoutes,cachedCollector};
