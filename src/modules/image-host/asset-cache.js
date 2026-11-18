const fs = require('node:fs');
const path = require('node:path');
const {CACHE_DIR,getWebpCacheFilePath,getLegacyWebpCacheFilePath,getRawPreviewCacheFilePath,hasSiblingWithSameBasename} = require('./asset-paths');
const {invalidateProcessingPaths} = require('./processor');

function assetCachePaths(year, month, filename, hasCollision = null) {
  const paths = [getWebpCacheFilePath(year,month,filename),
    ...['clean','image','text','tile'].map(variant => getWebpCacheFilePath(year,month,filename,variant)),
    getRawPreviewCacheFilePath(year,month,filename),
    path.join(CACHE_DIR,year,month,`${filename}.thumb.webp`),
    path.join(CACHE_DIR,year,month,`${filename}.thumb.webp.preview.jpg`)];
  const collision = typeof hasCollision === 'boolean' ? hasCollision : hasSiblingWithSameBasename(year,month,filename);
  if (!collision) paths.push(getLegacyWebpCacheFilePath(year,month,filename),
    path.join(CACHE_DIR,year,month,`${path.parse(filename).name}.raw_preview.jpg`));
  for (const file of [...paths]) if (file.endsWith('.webp')) paths.push(path.join(path.dirname(file),`${path.parse(file).name}.raw_preview.jpg`));
  return [...new Set(paths)];
}

function invalidateAssetCache(year,month,filename) {
  // Invalidate queued and running jobs for this specific asset before removing output,
  // without aborting unrelated concurrent image requests across the site.
  const paths = assetCachePaths(year,month,filename);
  invalidateProcessingPaths(paths);
  for (const file of paths) {
    fs.rmSync(file,{force:true}); fs.rmSync(file+'.source',{force:true});
  }
}
module.exports = {assetCachePaths,invalidateAssetCache};
