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
const { TRASH_DIR } = require('../../core/config');
const { RAW_DIR } = require('./asset-paths');
const { getFileCategory, isAllowedAttachmentFile, isValidYearSeg, isValidMonthSeg, isPathWithin } = require('../../core/file-security');
const { updateShaIndex } = require('./sha-index');
const { publishExclusive } = require('./asset-files');
const { assertNameAvailable } = require('./asset-names');

function trashMetadata(target, asset) {
  fs.writeFileSync(target + '.json', JSON.stringify(asset), {flag:'wx'});
}

/** Old trash entries remain visible; new sidecars preserve exact names and integrity baselines. */
function listTrashEntries() {
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
        try { saved = JSON.parse(fs.readFileSync(fullPath+'.json','utf8')); } catch {}
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
async function restoreTrash(id) {
  const item = findTrash(id);
  const target = path.join(RAW_DIR,item.year,item.month,item.filename);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  if (!isPathWithin(fs.realpathSync(path.dirname(target)),fs.realpathSync(RAW_DIR))) throw Object.assign(new Error('Invalid restore path'),{status:403});
  if (fs.existsSync(target)) throw Object.assign(new Error('A file with this name already exists. The original was not overwritten.'),{status:409});
  const sha256 = await hashFileSha256(item.fullPath);
  if (item.sha256 && item.sha256 !== sha256) throw Object.assign(new Error('Trash file integrity check failed'),{status:409});
  assertNameAvailable(path.dirname(target), item.year, item.month, item.filename, { restoreSha256: sha256 });
  const staged = path.join(path.dirname(target),`.restore-${crypto.randomUUID()}.tmp`);
  let published = false, cleanupPending = false;
  try {
    fs.copyFileSync(item.fullPath,staged,fs.constants.COPYFILE_EXCL);
    if (await hashFileSha256(staged) !== sha256) throw new Error('Restore copy verification failed');
    await publishExclusive(staged,target);
    published = true;
    const stat = fs.statSync(target);
    try { updateShaIndex(sha256,{year:item.year,month:item.month,filename:item.filename,size:stat.size,mtimeMs:stat.mtimeMs,baselineSha256:item.baselineSha256 || sha256}); }
    catch(error) { fs.unlinkSync(target); published=false; throw error; }
    try { fs.unlinkSync(item.fullPath); fs.rmSync(item.fullPath+'.json',{force:true}); }
    catch(error) { cleanupPending = true; console.warn('[Trash] Restored file; cleanup remains:', error.message); }
  } finally { fs.rmSync(staged,{force:true}); }
  return {year:item.year,month:item.month,filename:item.filename,restored:published,cleanupPending};
}
function deleteTrash(id) {
  const item = findTrash(id);
  fs.unlinkSync(item.fullPath);
  fs.rmSync(item.fullPath+'.json',{force:true});
  return {success:true};
}
Object.assign(module.exports,{trashMetadata,listTrashEntries,publicTrashEntries,findTrash,restoreTrash,deleteTrash});
