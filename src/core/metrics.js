const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT_DIR, STORAGE_DIR, DATA_DIR, getConfig } = require('./config');
const { sampleCpuUsage } = require('./cpu-usage');
const { getSecurityStats } = require('./security');
const { scanAllImages } = require('../modules/image-host');

const SERVER_START_TIME = Date.now();

/**
 * Retrieves disk usage stats using native fs.statfsSync (Node 18.15+).
 */
function getDiskUsage(dirPath) {
  try {
    const stats = fs.statfsSync(dirPath);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    const used = Math.max(0, total - free);
    const usagePercent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
    return { total, free, used, usagePercent };
  } catch {
    return null;
  }
}

/**
 * Recursively sums total file sizes in a directory.
 */
async function getDirSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await getDirSize(fullPath);
    } else if (entry.isFile()) {
      total += (await fs.promises.stat(fullPath).catch((err) => {
        if (err.code === 'ENOENT') return { size: 0 };
        throw err;
      })).size;
    }
  }
  return total;
}

async function collectResourceMetrics() {
  const cpuUsage = sampleCpuUsage();
  const cpus = os.cpus() || [];
  const cpuCount = cpus.length || 1;
  const cpuModel = cpus[0]?.model || 'Unknown CPU';
  const loadAvg = os.loadavg(); // [1m, 5m, 15m]
  const loadPercent1m = Math.min(100, Math.round((loadAvg[0] / cpuCount) * 1000) / 10);

  const memTotal = os.totalmem();
  let memFree = os.freemem();
  // On Linux, /proc/meminfo MemAvailable accurately reflects reclaimable page cache & buffers
  if (process.platform === 'linux' && fs.existsSync('/proc/meminfo')) {
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const availMatch = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (availMatch) {
        memFree = parseInt(availMatch[1], 10) * 1024;
      }
    } catch {}
  }
  const memUsed = Math.max(0, memTotal - memFree);
  const memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 1000) / 10 : 0;

  return {
    cpu:{model:cpuModel, cores:cpuCount, usagePercent:await cpuUsage, loadAvg:loadAvg.map(n=>Number(n.toFixed(2))), loadPercent1m},
    memory:{total:memTotal, used:memUsed, free:memFree, usagePercent:memPercent}
  };
}

/**
 * Collects runtime host metrics, process memory, and site storage stats.
 */
async function collectRuntimeMetrics(revealSecrets = false) {
  const cfg = getConfig();
  const resources = await collectResourceMetrics();
  const disk = getDiskUsage(fs.existsSync(STORAGE_DIR) ? STORAGE_DIR : ROOT_DIR) || {total:0, free:0, used:0, usagePercent:0};
  const procMem = process.memoryUsage();
  const imgData = await scanAllImages(cfg);
  const dataDirBytes = await getDirSize(DATA_DIR);

  return {
    timestamp: Date.now(),
    host: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      uptimeSec: Math.floor(os.uptime()),
      ...resources,
      disk
    },
    site: {
      siteName: cfg.site_name,
      baseUrl: cfg.base_url,
      port: cfg.port,
      nodeVersion: process.version,
      pid: process.pid,
      startedAt: SERVER_START_TIME,
      uptimeSec: Math.floor(process.uptime()),
      processMemory: {
        rss: procMem.rss,
        heapUsed: procMem.heapUsed,
        heapTotal: procMem.heapTotal
      },
      storage: {
        imageCount: imgData.stats.totalCount,
        rawBytes: imgData.stats.totalRawBytes,
        cacheBytes: imgData.stats.totalCacheBytes,
        dataJsonBytes: dataDirBytes,
        totalSiteBytes:
          imgData.stats.totalRawBytes + imgData.stats.totalCacheBytes + dataDirBytes
      },
      security: {
        ...getSecurityStats(),
        maxLoginAttempts: cfg.max_login_attempts
      },
      endpoints: {
        port: cfg.port,
        baseUrl: cfg.base_url,
        uploadUrl: `${cfg.base_url}/api/image/upload`,
        localUploadUrl: `http://127.0.0.1:${cfg.port}/api/image/upload`,
        apiToken: revealSecrets ? cfg.api_token : '',
        piclistHeaders: revealSecrets
          ? JSON.stringify({ Authorization: `Bearer ${cfg.api_token}` })
          : '',
        rawUrlPattern: `${cfg.base_url}/${cfg.image_host.raw_secret_path}/YYYY/MM/filename.ext`,
        pubUrlPattern: `${cfg.base_url}/pub/YYYY/MM/filename.webp`
      }
    }
  };
}

module.exports = {
  collectRuntimeMetrics, collectResourceMetrics, getDiskUsage, getDirSize
};
