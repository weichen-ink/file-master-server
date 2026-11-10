const path = require('node:path');
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

function registerImageHostModule(app) {
  ensureDirs();
  warmShaIndexAsync();
  const initCfg = getConfig();
  const requestedWmPath = path.resolve(ROOT_DIR, initCfg.image_host.watermark_image || './watermark.png');
  const wmPath = isPathWithin(requestedWmPath, ROOT_DIR)
    ? requestedWmPath
    : path.resolve(ROOT_DIR, './watermark.png');
  ensureDefaultWatermark(wmPath, initCfg.image_host.watermark_text).catch(() => {});

  // Registration order is preserved from the original module: API routes, then wildcard asset routes.
  registerUploadRoutes(app);
  registerPublicRoutes(app);
  registerManageRoutes(app);
}

module.exports = {
  acceptSingleUpload,
  moveFileToTrash,
  registerImageHostModule,
  scanAllImages,
  invalidateScanCache,
  getWebpCacheFilePath,
  findRawFile,
  clearCacheDir
};
