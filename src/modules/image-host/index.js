const path = require('node:path');
const { checkStorageHealth, getStorageHealth } = require('./storage-health');
const { ROOT_DIR, getConfig } = require('../../core/config');
const { isPathWithin } = require('../../core/file-security');
const { ensureDefaultWatermark } = require('./processor');
const { ensureDirs, getWebpCacheFilePath, findRawFile } = require('./asset-paths');
const { acceptSingleUpload } = require('./upload-middleware');
const { moveFileToTrash } = require('./trash');
const { scanAllImages, invalidateScanCache, clearCacheDir, warmShaIndexAsync } = require('./catalog');
const { registerUploadRoutes } = require('./routes/upload');
const { registerPublicRoutes } = require('./routes/public');
const { registerManageRoutes } = require('./routes/manage');

const { recoverPendingRename } = require('./rename');
const { setBeforeMutation, mutateAssets } = require('./mutation-queue');
const { appendAuditLog } = require('../../core/audit');

function registerImageHostModule(app) {
  checkStorageHealth();
  ensureDirs();
  const { recoverPendingTrash, pruneExpiredTrash } = require('./trash');
  const recover = () => { recoverPendingRename(); recoverPendingTrash(); };
  recover();
  setBeforeMutation(recover);
  const cleanupTrash = () => mutateAssets(() => {
    const removed = pruneExpiredTrash();
    if (removed) appendAuditLog({ action: 'prune_expired_trash', count: removed });
  }).catch(error => {
    console.error('[ImageHost] Trash cleanup failed:', error.message);
    appendAuditLog({ action: 'prune_expired_trash_failed', error: error.message });
  });
  cleanupTrash();
  setInterval(cleanupTrash, 3600000).unref();
  warmShaIndexAsync();
  const initCfg = getConfig();
  const requestedWmPath = path.resolve(ROOT_DIR, initCfg.image_host.watermark_image || './wm-light.png');
  const wmPath = isPathWithin(requestedWmPath, ROOT_DIR)
    ? requestedWmPath
    : path.resolve(ROOT_DIR, './wm-light.png');
  ensureDefaultWatermark(wmPath, initCfg.image_host.watermark_text).catch(() => { });

  // Registration order is preserved from the original module: API routes, then wildcard asset routes.
  registerUploadRoutes(app);
  registerPublicRoutes(app);
  registerManageRoutes(app);
}

module.exports = {
  getStorageHealth,
  acceptSingleUpload,
  moveFileToTrash,
  registerImageHostModule,
  scanAllImages,
  invalidateScanCache,
  getWebpCacheFilePath,
  findRawFile,
  clearCacheDir
};
