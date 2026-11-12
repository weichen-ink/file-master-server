const fs = require('node:fs');
const { hashFileSha256 } = require('./asset-files');

async function moveFileToTrash(source, target, expectedSha256) {
  try {
    fs.renameSync(source, target);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    try {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if ((await hashFileSha256(target)) !== expectedSha256) {
        throw new Error('Trash copy failed integrity check');
      }
      fs.unlinkSync(source);
    } catch (copyErr) {
      if (fs.existsSync(source) && fs.existsSync(target)) {
        try {
          fs.unlinkSync(target);
        } catch {}
      }
      throw copyErr;
    }
  }
}

module.exports = { moveFileToTrash };

const path = require('node:path');
const crypto = require('node:crypto');
const { TRASH_DIR, readCriticalJsonData, writeJsonData, isRecord } = require('../../core/config');
const { RAW_DIR } = require('./asset-paths');
const { getFileCategory, isAllowedAttachmentFile, isValidYearSeg, isValidMonthSeg, isPathWithin } = require('../../core/file-security');
const { updateShaIndex, getShaIndex, pathToShaMap, removeShaIndex } = require('./sha-index');
const { getProtectedMap, isItemLocked } = require('./protection');
const { removeAssetStats } = require('./stats');
const { invalidateAssetCache } = require('./asset-cache');
const { assertNameAvailable } = require('./asset-names');

function trashMetadata(target, asset) {
  fs.writeFileSync(target + '.json', JSON.stringify(asset), {flag:'wx'});
}

/** Old trash entries remain visible; new sidecars preserve exact names and integrity baselines. */
function listTrashEntries() {
  recoverPendingTrash();
  const entries = [];
  if (!fs.existsSync(TRASH_DIR)) return entries;
  const walk = (dir, parts = []) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && parts.length < 3) walk(fullPath, [...parts, entry.name]);
      else if (entry.isFile() && parts.length === 3 && /_\d{10,}_[a-f0-9]{8}\.[^.]+$/.test(entry.name)) {
        const [day, year, month] = parts;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isValidYearSeg(year) || !isValidMonthSeg(month)) continue;
        let saved = {};
        try { saved = JSON.parse(fs.readFileSync(fullPath+'.json','utf8'));
          if (!isRecord(saved) || saved.year !== year || saved.month !== month || !saved.filename ||
            !/^[a-f0-9]{64}$/.test(saved.sha256) || (saved.baselineSha256 != null && !/^[a-f0-9]{64}$/.test(saved.baselineSha256))) throw new Error('Invalid trash metadata');
        } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read trash metadata; restore its JSON sidecar before continuing', {cause:error}); }
        const filename = saved.filename || entry.name.replace(/_\d{10,}_[a-f0-9]{8}(?=\.[^.]+$)/, '');
        if (!isAllowedAttachmentFile(filename) || path.basename(filename) !== filename) continue;
        const stat = fs.lstatSync(fullPath);
        const rel = [...parts,entry.name].join('/');
        entries.push({id:crypto.createHash('sha256').update(rel).digest('hex'),year,month,filename,size:stat.size,
          deletedAt:saved.deletedAt || stat.mtimeMs, baselineSha256:saved.baselineSha256 || null,
          sha256:saved.sha256 || null, fullPath, legacy:!saved.filename});
      }
    }
  };
  walk(TRASH_DIR);
  return entries.sort((a,b) => b.deletedAt-a.deletedAt);
}
function publicTrashEntries() {
  return listTrashEntries().map(({fullPath,baselineSha256,sha256,...item}) => ({...item,isImage:getFileCategory(path.extname(item.filename)) === 'image'}));
}
function findTrash(id) {
  if (!/^[a-f0-9]{64}$/.test(String(id))) throw Object.assign(new Error('Invalid trash identifier'),{status:400});
  const item = listTrashEntries().find(item => item.id === id);
  if (!item) throw Object.assign(new Error('Trash item not found'),{status:404});
  if (!isPathWithin(fs.realpathSync(item.fullPath),fs.realpathSync(TRASH_DIR))) throw Object.assign(new Error('Invalid trash path'),{status:403});
  return item;
}
const validSha = value => /^[a-f0-9]{64}$/.test(value);
const changed = message => Object.assign(new Error(message),{status:409,code:'ASSET_CHANGED'});
function validPending(record) {
  return record === null || (isRecord(record) && record.version === 1 && ['delete','restore'].includes(record.kind) &&
    isValidYearSeg(record.year) && isValidMonthSeg(record.month) && typeof record.filename === 'string' &&
    path.basename(record.filename) === record.filename && isAllowedAttachmentFile(record.filename) &&
    typeof record.trashRel === 'string' && /^\d{4}-\d{2}-\d{2}\/\d{4}\/\d{2}\/[^/]+$/.test(record.trashRel) &&
    record.trashRel.split('/')[1] === record.year && record.trashRel.split('/')[2] === record.month &&
    isPathWithin(path.resolve(TRASH_DIR,record.trashRel),TRASH_DIR) &&
    validSha(record.sha256) && validSha(record.baselineSha256) && Number.isFinite(record.deletedAt));
}
function checkedHash(file, root) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || !isPathWithin(fs.realpathSync(file),fs.realpathSync(root))) throw changed('Invalid attachment path; recovery stopped');
  const descriptor = fs.openSync(file,'r'), hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let length;
    while ((length = fs.readSync(descriptor,buffer,0,buffer.length,null)) > 0) hash.update(buffer.subarray(0,length));
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}
function checkParent(file, root) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if (!isPathWithin(fs.realpathSync(path.dirname(file)),fs.realpathSync(root))) throw changed('Invalid attachment directory; recovery stopped');
}
/** A durable intent precedes byte changes; replay finishes metadata before any scan can establish a new baseline. */
function recoverPendingTrash() {
  const record = readCriticalJsonData('asset_mutation', null, validPending);
  if (!record) return;
  const {year,month,filename,sha256,baselineSha256} = record;
  const source = path.join(RAW_DIR,year,month,filename), trash = path.join(TRASH_DIR,record.trashRel);
  getShaIndex(); getProtectedMap(); // Fail before touching bytes if critical state is unreadable.
  checkParent(source,RAW_DIR); checkParent(trash,TRASH_DIR);
  if (record.kind === 'delete') {
    if (fs.existsSync(source) && checkedHash(source,RAW_DIR) !== sha256) throw changed('The original file changed; deletion recovery stopped');
    if (fs.existsSync(trash) && checkedHash(trash,TRASH_DIR) !== sha256) throw changed('The trash file changed; deletion recovery stopped');
    if (!fs.existsSync(source) && !fs.existsSync(trash)) throw changed('The pending attachment is missing; recovery stopped');
    if (!fs.existsSync(trash+'.json')) trashMetadata(trash,{year,month,filename,deletedAt:record.deletedAt,sha256,baselineSha256});
    else {
      const meta = JSON.parse(fs.readFileSync(trash+'.json','utf8'));
      if (meta.sha256 !== sha256 || meta.baselineSha256 !== baselineSha256 || meta.filename !== filename) throw changed('Trash metadata changed; recovery stopped');
    }
    if (!fs.existsSync(trash)) {
      try { fs.renameSync(source,trash); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        fs.copyFileSync(source,trash,fs.constants.COPYFILE_EXCL);
        if (checkedHash(trash,TRASH_DIR) !== sha256) throw changed('Trash copy verification failed');
        fs.unlinkSync(source);
      }
    } else if (fs.existsSync(source)) fs.unlinkSync(source);
    const rel = `${year}/${month}/${filename}`, known = pathToShaMap.get(rel);
    if (known) removeShaIndex(known.sha256,rel);
    removeAssetStats(year,month,filename);
  } else {
    if (fs.existsSync(trash) && checkedHash(trash,TRASH_DIR) !== sha256) throw changed('The trash file changed; restore recovery stopped');
    const staged = path.join(path.dirname(source),`.restore-${crypto.createHash('sha256').update(record.trashRel).digest('hex')}.tmp`);
    if (!fs.existsSync(source)) {
      if (!fs.existsSync(trash)) throw changed('The pending attachment is missing; recovery stopped');
      fs.rmSync(staged,{force:true}); // A previous interrupted copy was never published.
      try {
        fs.copyFileSync(trash,staged,fs.constants.COPYFILE_EXCL);
        if (checkedHash(staged,RAW_DIR) !== sha256) throw changed('Restore copy verification failed');
        fs.linkSync(staged,source); // Atomic, exclusive publication; never overwrite a newer upload.
      } finally { fs.rmSync(staged,{force:true}); }
    }
    fs.rmSync(staged,{force:true});
    if (checkedHash(source,RAW_DIR) !== sha256) throw changed('The restored file changed; restore recovery stopped');
    const stat = fs.statSync(source);
    updateShaIndex(sha256,{year,month,filename,size:stat.size,mtimeMs:stat.mtimeMs,baselineSha256});
    fs.rmSync(trash,{force:true}); fs.rmSync(trash+'.json',{force:true});
  }
  invalidateAssetCache(year,month,filename);
  writeJsonData('asset_mutation',null);
}
async function trashAsset(year,month,filename,expectedSha256 = null) {
  recoverPendingTrash();
  if (isItemLocked(year,month,filename)) throw Object.assign(new Error('File is locked against deletion'),{status:403});
  getShaIndex();
  const source = path.join(RAW_DIR,year,month,filename), rel = `${year}/${month}/${filename}`;
  if (!fs.existsSync(source)) {
    if (expectedSha256) throw Object.assign(new Error('File no longer exists'),{status:412});
    const known = pathToShaMap.get(rel); if (known) removeShaIndex(known.sha256,rel);
    removeAssetStats(year,month,filename); invalidateAssetCache(year,month,filename);
    return {size:0,sha256:null};
  }
  const sha256 = checkedHash(source,RAW_DIR), stat = fs.statSync(source);
  if (expectedSha256 && sha256 !== expectedSha256) throw Object.assign(new Error('Attachment changed; refresh before deleting'),{status:412});
  const known = pathToShaMap.get(rel), parsed = path.parse(filename);
  const trashRel = `${new Date().toISOString().slice(0,10)}/${year}/${month}/${parsed.name}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${parsed.ext}`;
  writeJsonData('asset_mutation',{version:1,kind:'delete',year,month,filename,trashRel,sha256,
    baselineSha256:known?.baselineSha256 || known?.sha256 || sha256,deletedAt:Date.now()});
  recoverPendingTrash();
  return {size:stat.size,sha256};
}
async function restoreTrash(id) {
  recoverPendingTrash();
  const item = findTrash(id), target = path.join(RAW_DIR,item.year,item.month,item.filename);
  checkParent(target,RAW_DIR);
  if (fs.existsSync(target)) throw changed('A file with this name already exists. The original was not overwritten.');
  const sha256 = checkedHash(item.fullPath,TRASH_DIR);
  if (item.sha256 && item.sha256 !== sha256) throw changed('Trash file integrity check failed');
  assertNameAvailable(path.dirname(target),item.year,item.month,item.filename,{restoreSha256:sha256});
  getShaIndex(); getProtectedMap();
  writeJsonData('asset_mutation',{version:1,kind:'restore',year:item.year,month:item.month,filename:item.filename,
    trashRel:path.relative(TRASH_DIR,item.fullPath).split(path.sep).join('/'),sha256,
    baselineSha256:item.baselineSha256 || sha256,deletedAt:item.deletedAt});
  recoverPendingTrash();
  return {year:item.year,month:item.month,filename:item.filename,restored:true,cleanupPending:false};
}
function deleteTrash(id) {
  recoverPendingTrash();
  const item = findTrash(id);
  fs.unlinkSync(item.fullPath);
  fs.rmSync(item.fullPath+'.json',{force:true});
  return {success:true};
}
Object.assign(module.exports,{trashAsset,recoverPendingTrash,trashMetadata,listTrashEntries,publicTrashEntries,findTrash,restoreTrash,deleteTrash});
