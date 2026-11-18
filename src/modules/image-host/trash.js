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
const { TRASH_DIR, getConfig, readCriticalJsonData, writeJsonData, isRecord } = require('../../core/config');
const { RAW_DIR, hasSiblingWithSameBasename, resolveExactRawFilename } = require('./asset-paths');
const { getFileCategory, isAllowedAttachmentFile, isValidYearSeg, isValidMonthSeg, isPathWithin, sanitizeUploadFilename, buildAssetUrlsAndMeta } = require('../../core/file-security');
const { updateShaIndex, getShaIndex, pathToShaMap, removeShaIndex } = require('./sha-index');
const { getProtectedMap, isItemLocked } = require('./protection');
const { removeAssetStats } = require('./stats');
const { invalidateAssetCache } = require('./asset-cache');
const { assertNameAvailable, inspectNameAvailability, syncAssetNameIdentity } = require('./asset-names');

function buildConflictDetails(cfg, year, month, issue) {
  const filename = issue.existingFilename;
  const destPath = path.join(RAW_DIR, year, month, filename);
  const exists = fs.existsSync(destPath);
  const stat = exists ? fs.statSync(destPath) : null;
  const hasCollision = exists ? hasSiblingWithSameBasename(year, month, filename) : false;
  const assetMeta = exists
    ? buildAssetUrlsAndMeta(cfg, {
        year,
        month,
        filename,
        originalName: filename,
        hasBasenameCollision: hasCollision
      })
    : {};
  return {
    code: issue.code,
    year,
    month,
    filename,
    size: stat ? stat.size : 0,
    mtimeMs: stat ? stat.mtimeMs : 0,
    sha256: exists ? checkedHash(destPath, RAW_DIR) : null,
    locked: exists ? isItemLocked(year, month, filename) : false,
    ...assetMeta
  };
}

function trashMetadata(target, asset) {
  fs.writeFileSync(target + '.json', JSON.stringify(asset), {flag:'wx'});
}

function newTrashRel(year, month, filename, deletedAt) {
  // Exact names live in the sidecar; bounded storage names also leave room for its .json suffix.
  const stem = crypto.createHash('sha256').update(filename).digest('hex').slice(0, 16);
  return `${new Date(deletedAt).toISOString().slice(0,10)}/${year}/${month}/${stem}_${deletedAt}_${crypto.randomBytes(4).toString('hex')}${path.extname(filename)}`;
}

function hasPendingTrash() {
  return Boolean(readCriticalJsonData('asset_mutation', null, validPending));
}

/** Old trash entries remain visible; new sidecars preserve exact names and integrity baselines. */
function listTrashEntries(options = {}) {
  if (options?.skipRecovery) {
    readCriticalJsonData('asset_mutation', null, validPending);
  } else {
    recoverPendingTrash();
  }
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
  pruneExpiredTrash();
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
  const validTrashRel = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}\/\d{4}\/\d{2}\/[^/]+$/.test(value) &&
    value.split('/')[1] === record.year && value.split('/')[2] === record.month &&
    isPathWithin(path.resolve(TRASH_DIR,value),TRASH_DIR);
  return record === null || (isRecord(record) && record.version === 1 && ['delete','restore','replace'].includes(record.kind) &&
    isValidYearSeg(record.year) && isValidMonthSeg(record.month) && typeof record.filename === 'string' &&
    path.basename(record.filename) === record.filename && isAllowedAttachmentFile(record.filename) &&
    validTrashRel(record.trashRel) && validSha(record.sha256) && validSha(record.baselineSha256) && Number.isFinite(record.deletedAt) &&
    (record.kind !== 'replace' || (validSha(record.oldSha256) && validSha(record.oldBaselineSha256) &&
      /^\.replace-[a-f0-9-]{36}\.tmp$/.test(record.stagedName) &&
      (!record.restoreTrashRel || validTrashRel(record.restoreTrashRel)))));
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

function replacementPaths(record) {
  const target = path.join(RAW_DIR, record.year, record.month, record.filename);
  return { target, staged: path.join(path.dirname(target), record.stagedName), backup: path.join(TRASH_DIR, record.trashRel) };
}

/** Atomic rename is the commit point. Replay never guesses whether to publish new bytes. */
function recoverReplacement(record) {
  const { target, staged, backup } = replacementPaths(record);
  const actual = checkedHash(target, RAW_DIR);
  if (actual !== record.sha256 && actual !== record.oldSha256) throw changed('Replacement target changed; recovery stopped');
  if (actual === record.sha256) {
    if (checkedHash(backup, TRASH_DIR) !== record.oldSha256) throw changed('Replacement backup changed; recovery stopped');
    const stat = fs.statSync(target), rel = `${record.year}/${record.month}/${record.filename}`;
    const known = pathToShaMap.get(rel);
    if (known) removeShaIndex(known.sha256, rel, false);
    updateShaIndex(record.sha256, { year: record.year, month: record.month, filename: record.filename,
      size: stat.size, mtimeMs: stat.mtimeMs, baselineSha256: record.baselineSha256 });
    syncAssetNameIdentity(record.year, record.month, record.filename, record.sha256);
    removeAssetStats(record.year, record.month, record.filename);
    if (record.restoreTrashRel) {
      const restored = path.join(TRASH_DIR, record.restoreTrashRel);
      if (fs.existsSync(restored) && checkedHash(restored, TRASH_DIR) !== record.sha256) throw changed('Restored trash file changed; cleanup stopped');
      fs.rmSync(restored, { force: true });
      fs.rmSync(restored + '.json', { force: true });
    }
  } else {
    // The original is still online, including when backup creation or publication failed.
    fs.rmSync(backup, { force: true });
    fs.rmSync(backup + '.json', { force: true });
  }
  invalidateAssetCache(record.year, record.month, record.filename);
  fs.rmSync(staged, { force: true });
  writeJsonData('asset_mutation', null);
}

/** Both upload and restore replace a complete inode while keeping the old URL continuously readable. */
async function replaceAsset(year, month, filename, file, sha256, { expectedSha256, baselineSha256 = sha256, restoreTrashRel = null } = {}) {
  recoverPendingTrash();
  getShaIndex(); getProtectedMap();
  if (isItemLocked(year, month, filename)) throw Object.assign(new Error('The existing file is protected and cannot be overwritten.'), { status: 403, code: 'FILE_LOCKED' });
  const target = path.join(RAW_DIR, year, month, filename);
  const oldSha256 = checkedHash(target, RAW_DIR);
  if (oldSha256 !== expectedSha256) throw Object.assign(new Error('The target file changed; review and confirm again.'), { status: 409, code: 'CONFLICT_TARGET_CHANGED' });
  if (oldSha256 === sha256) {
    if (restoreTrashRel) {
      const restored = path.resolve(TRASH_DIR, restoreTrashRel);
      if (!isPathWithin(restored, TRASH_DIR)) throw changed('Invalid restore trash path; cleanup stopped');
      if (fs.existsSync(restored) && checkedHash(restored, TRASH_DIR) !== sha256) throw changed('Restored trash file changed; cleanup stopped');
      fs.rmSync(restored, { force: true });
      fs.rmSync(restored + '.json', { force: true });
    }
    return { filename, stat: fs.statSync(target), deduplicated: true, replaced: false };
  }
  const known = pathToShaMap.get(`${year}/${month}/${filename}`), deletedAt = Date.now();
  const record = { version: 1, kind: 'replace', year, month, filename, sha256, baselineSha256,
    oldSha256, oldBaselineSha256: known?.baselineSha256 || known?.sha256 || oldSha256, deletedAt,
    trashRel: newTrashRel(year, month, filename, deletedAt),
    stagedName: `.replace-${crypto.randomUUID()}.tmp`, restoreTrashRel };
  const { staged, backup } = replacementPaths(record);
  let journaled = false;
  try {
    if (file.buffer) await fs.promises.writeFile(staged, file.buffer, { flag: 'wx' });
    else await fs.promises.copyFile(file.path, staged, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    if (checkedHash(staged, RAW_DIR) !== sha256) throw changed('Replacement integrity check failed');
    if (checkedHash(target, RAW_DIR) !== oldSha256) throw changed('Replacement target changed before publication');
    writeJsonData('asset_mutation', record);
    journaled = true;
    checkParent(backup, TRASH_DIR);
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    if (checkedHash(backup, TRASH_DIR) !== oldSha256 || checkedHash(target, RAW_DIR) !== oldSha256) throw changed('Replacement source changed before publication');
    trashMetadata(backup, { year, month, filename, deletedAt, sha256: oldSha256, baselineSha256: record.oldBaselineSha256 });
    fs.renameSync(staged, target);
    recoverPendingTrash();
    return { filename, stat: fs.statSync(target), deduplicated: false, replaced: true };
  } catch (error) {
    if (journaled) {
      try { recoverPendingTrash(); }
      catch (recoveryError) {
        console.error('[ImageHost] Replacement recovery pending:', recoveryError.message);
        throw Object.assign(new Error('Replacement recovery is pending; retry after storage is available.', { cause: recoveryError }), { status: 503, code: 'RECOVERY_PENDING' });
      }
      if (checkedHash(target, RAW_DIR) === sha256) {
        return { filename, stat: fs.statSync(target), deduplicated: false, replaced: true };
      }
    }
    throw error;
  } finally {
    // A pending journal owns its staged bytes until recovery, including after a process restart.
    if (!journaled) fs.rmSync(staged, { force: true });
  }
}
/** A durable intent precedes byte changes; replay finishes metadata before any scan can establish a new baseline. */
function recoverPendingTrash() {
  const record = readCriticalJsonData('asset_mutation', null, validPending);
  if (!record) return;
  const {year,month,filename,sha256,baselineSha256} = record;
  const source = path.join(RAW_DIR,year,month,filename), trash = path.join(TRASH_DIR,record.trashRel);
  getShaIndex(); getProtectedMap(); // Fail before touching bytes if critical state is unreadable.
  if (record.kind === 'replace') return recoverReplacement(record);
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
  const actualFilename = resolveExactRawFilename(year, month, filename) || filename;
  if (isItemLocked(year,month,actualFilename)) throw Object.assign(new Error('File is locked against deletion'),{status:403});
  getShaIndex();
  const source = path.join(RAW_DIR,year,month,actualFilename), rel = `${year}/${month}/${actualFilename}`;
  if (!fs.existsSync(source) || !resolveExactRawFilename(year, month, actualFilename)) {
    if (expectedSha256) throw Object.assign(new Error('File no longer exists'),{status:412});
    const known = pathToShaMap.get(rel); if (known) removeShaIndex(known.sha256,rel);
    removeAssetStats(year,month,actualFilename); invalidateAssetCache(year,month,actualFilename);
    return {size:0,sha256:null};
  }
  const sha256 = checkedHash(source,RAW_DIR), stat = fs.statSync(source);
  if (expectedSha256 && sha256 !== expectedSha256) throw Object.assign(new Error('Attachment changed; refresh before deleting'),{status:412});
  const known = pathToShaMap.get(rel), deletedAt = Date.now();
  const trashRel = newTrashRel(year, month, actualFilename, deletedAt);
  writeJsonData('asset_mutation',{version:1,kind:'delete',year,month,filename:actualFilename,trashRel,sha256,
    baselineSha256:known?.baselineSha256 || known?.sha256 || sha256,deletedAt});
  recoverPendingTrash();
  const trashId = crypto.createHash('sha256').update(trashRel).digest('hex');
  return {size:stat.size,sha256,trashRel,trashId,filename:actualFilename};
}
async function restoreTrash(id, options = {}) {
  recoverPendingTrash();
  const item = findTrash(id);
  const sha256 = checkedHash(item.fullPath, TRASH_DIR);
  if (item.sha256 && item.sha256 !== sha256) throw changed('Trash file integrity check failed');

  const strategy = String(options?.conflictStrategy || '').trim().toLowerCase();
  const origExt = path.extname(item.filename).toLowerCase();
  let targetFilename = item.filename;
  if (options?.filename) {
    const safe = sanitizeUploadFilename(String(options.filename));
    if (safe) {
      const safeExt = path.extname(safe).toLowerCase();
      const base = safeExt ? safe.slice(0, -safeExt.length) : safe;
      targetFilename = `${base}${origExt || safeExt}`;
    }
  }

  const targetDir = path.join(RAW_DIR, item.year, item.month);
  if (strategy === 'replace' && targetFilename !== item.filename) {
    const originalIssue = inspectNameAvailability(targetDir, item.year, item.month, item.filename, { restoreSha256: sha256 });
    const conflict = originalIssue ? buildConflictDetails(getConfig(), item.year, item.month, originalIssue) : null;
    throw Object.assign(new Error('Restore can only overwrite the original filename. Choose an unused name to restore a separate file.'), {
      status: 409, code: 'CONFLICT_TARGET_CHANGED', ...(conflict ? { conflict } : {})
    });
  }
  let target = path.join(targetDir, targetFilename);
  checkParent(target, RAW_DIR);

  let issue = inspectNameAvailability(targetDir, item.year, item.month, targetFilename, { restoreSha256: sha256 });
  if (strategy === 'replace') {
    const conflict = issue ? buildConflictDetails(getConfig(), item.year, item.month, issue) : null;
    const expected = options?.conflictTarget;
    if (!conflict || conflict.code !== 'NAME_CONFLICT' || !expected ||
        expected.year !== item.year || expected.month !== item.month || expected.filename !== conflict.filename || expected.sha256 !== conflict.sha256) {
      throw Object.assign(new Error('The target file changed; review and confirm again.'), {
        status: 409, code: 'CONFLICT_TARGET_CHANGED', ...(conflict ? { conflict } : {})
      });
    }
    targetFilename = conflict.filename;
    await replaceAsset(item.year, item.month, targetFilename, { path: item.fullPath }, sha256, {
      expectedSha256: expected.sha256, baselineSha256: item.baselineSha256 || sha256,
      restoreTrashRel: path.relative(TRASH_DIR, item.fullPath).split(path.sep).join('/')
    });
    return { year: item.year, month: item.month, filename: targetFilename, restored: true, cleanupPending: false };
  }
  if (issue) {
    if (strategy === 'rename' && !options?.filename) {
      const base = origExt ? item.filename.slice(0, -origExt.length) : item.filename;
      let idx = 1;
      while (idx < 1000) {
        const candidate = `${base}_${idx}${origExt}`;
        if (!inspectNameAvailability(targetDir, item.year, item.month, candidate, { restoreSha256: sha256 })) {
          targetFilename = candidate;
          target = path.join(targetDir, targetFilename);
          issue = null;
          break;
        }
        idx++;
      }
    }
  }

  if (issue) {
    const err = new Error(
      issue.code === 'NAME_RESERVED'
        ? 'This name is temporarily reserved for a recently renamed file.'
        : 'A file with this name already exists.'
    );
    err.status = 409;
    err.code = issue.code;
    err.conflict = buildConflictDetails(getConfig(), item.year, item.month, issue);
    throw err;
  }

  assertNameAvailable(targetDir, item.year, item.month, targetFilename, { restoreSha256: sha256 });
  getShaIndex();
  getProtectedMap();
  writeJsonData('asset_mutation', {
    version: 1,
    kind: 'restore',
    year: item.year,
    month: item.month,
    filename: targetFilename,
    trashRel: path.relative(TRASH_DIR, item.fullPath).split(path.sep).join('/'),
    sha256,
    baselineSha256: item.baselineSha256 || sha256,
    deletedAt: item.deletedAt
  });
  recoverPendingTrash();
  return { year: item.year, month: item.month, filename: targetFilename, restored: true, cleanupPending: false };
}
function deleteTrashEntry(item) {
  if (!item || !item.fullPath) throw Object.assign(new Error('Trash item not found'), { status: 404 });
  if (!fs.existsSync(item.fullPath)) throw Object.assign(new Error('Trash item not found'), { status: 404 });
  if (!isPathWithin(fs.realpathSync(item.fullPath), fs.realpathSync(TRASH_DIR))) {
    throw Object.assign(new Error('Invalid trash path'), { status: 403 });
  }
  fs.unlinkSync(item.fullPath);
  fs.rmSync(item.fullPath + '.json', { force: true });
  return { success: true };
}
function deleteTrash(id, preloadedById = null) {
  recoverPendingTrash();
  if (!/^[a-f0-9]{64}$/.test(String(id))) throw Object.assign(new Error('Invalid trash identifier'), { status: 400 });
  const item = preloadedById ? preloadedById.get(id) : findTrash(id);
  if (!item) throw Object.assign(new Error('Trash item not found'), { status: 404 });
  return deleteTrashEntry(item);
}
function pruneExpiredTrash(now = Date.now()) {
  const days = Number(getConfig().image_host?.trash_retention_days || 0);
  if (!Number.isFinite(days) || days <= 0) return 0;
  const cutoff = now - days * 86400000;
  let removed = 0;
  for (const item of listTrashEntries()) {
    if (Number.isFinite(item.deletedAt) && item.deletedAt <= cutoff) {
      fs.rmSync(item.fullPath, { force: true });
      fs.rmSync(item.fullPath + '.json', { force: true });
      removed++;
    }
  }
  return removed;
}
Object.assign(module.exports,{trashAsset,replaceAsset,recoverPendingTrash,hasPendingTrash,trashMetadata,listTrashEntries,publicTrashEntries,findTrash,restoreTrash,deleteTrash,deleteTrashEntry,pruneExpiredTrash,buildConflictDetails});
