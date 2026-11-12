const fs = require('node:fs');
const path = require('node:path');
const {CACHE_DIR,getWebpCacheFilePath,getLegacyWebpCacheFilePath,getRawPreviewCacheFilePath,hasSiblingWithSameBasename} = require('./asset-paths');
const {invalidateProcessingCache} = require('./processor');
function assetCachePaths(year,month,filename) {
  const paths = [getWebpCacheFilePath(year,month,filename),
    ...['clean','image','text','tile'].map(variant => getWebpCacheFilePath(year,month,filename,variant)),
    getRawPreviewCacheFilePath(year,month,filename),
    path.join(CACHE_DIR,year,month,`${filename}.thumb.webp`),
    path.join(CACHE_DIR,year,month,`${filename}.thumb.webp.preview.jpg`)];
  if (!hasSiblingWithSameBasename(year,month,filename)) paths.push(getLegacyWebpCacheFilePath(year,month,filename),
    path.join(CACHE_DIR,year,month,`${path.parse(filename).name}.raw_preview.jpg`));
  for (const file of [...paths]) if (file.endsWith('.webp')) paths.push(path.join(path.dirname(file),`${path.parse(file).name}.raw_preview.jpg`));
  return [...new Set(paths)];
}
function invalidateAssetCache(year,month,filename) {
  // Invalidate queued and running jobs before removing output, so stale jobs cannot republish it.
  invalidateProcessingCache();
  for (const file of assetCachePaths(year,month,filename)) {
    fs.rmSync(file,{force:true}); fs.rmSync(file+'.source',{force:true});
  }
}
module.exports = {assetCachePaths,invalidateAssetCache};
