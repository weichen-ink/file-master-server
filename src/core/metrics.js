const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT_DIR, DATA_DIR, getConfig } = require('./config');
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
    return { total: 0, free: 0, used: 0, usagePercent: 0 };
  }
}

/**
 * Recursively sums total file sizes in a directory.
 */
function getDirSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(fullPath);
    } else if (entry.isFile()) {
      total += fs.statSync(fullPath).size;
    }
  }
  return total;
}

/**
 * Collects runtime host metrics, process memory, and site storage stats.
 */
function collectRuntimeMetrics() {
  const cfg = getConfig();
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

  const disk = getDiskUsage(ROOT_DIR);
  const procMem = process.memoryUsage();
  const imgData = scanAllImages(cfg);
  const dataDirBytes = getDirSize(DATA_DIR);

  return {
    timestamp: Date.now(),
    host: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      uptimeSec: Math.floor(os.uptime()),
      cpu: {
        model: cpuModel,
        cores: cpuCount,
        loadAvg: loadAvg.map((n) => Number(n.toFixed(2))),
        loadPercent1m
      },
      memory: {
        total: memTotal,
        used: memUsed,
        free: memFree,
        usagePercent: memPercent
      },
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
        totpEnabled: Boolean(cfg.totp_secret),
        maxLoginAttempts: cfg.max_login_attempts
      },
      endpoints: {
        port: cfg.port,
        baseUrl: cfg.base_url,
        uploadUrl: `${cfg.base_url}/api/image/upload`,
        localUploadUrl: `http://127.0.0.1:${cfg.port}/api/image/upload`,
        apiToken: cfg.api_token,
        piclistHeaders: JSON.stringify({ Authorization: `Bearer ${cfg.api_token}` }),
        rawUrlPattern: `${cfg.base_url}/${cfg.image_host.raw_secret_path}/YYYY/MM/filename.ext`,
        pubUrlPattern: `${cfg.base_url}/pub/YYYY/MM/filename.webp`
      }
    }
  };
}

module.exports = {
  collectRuntimeMetrics
};
