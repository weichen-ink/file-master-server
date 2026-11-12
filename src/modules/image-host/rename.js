const fs = require('node:fs');
const path = require('node:path');
const { getConfig, writeJsonData } = require('../../core/config');
const { isAllowedAttachmentFile, isValidYearSeg, isValidMonthSeg, isPathWithin, sanitizeSegment, buildAssetUrlsAndMeta } = require('../../core/file-security');
const { RAW_DIR, findRawFile, hasSiblingWithSameBasename } = require('./asset-paths');
const { hashFileSha256 } = require('./asset-files');
const { getShaIndex, pathToShaMap, updateShaIndex, removeShaIndex, writeShaIndex } = require('./sha-index');
const { getProtectedMap } = require('./protection');
const { getSharesMap, saveSharesMap } = require('../share');
const { moveAssetStats } = require('./stats');
const { invalidateAssetCache } = require('./asset-cache');
const { invalidateScanCache } = require('./catalog');
const { aliasRetentionDays, assetLinkMappings, keyOf, foldName, conflict, routeNames, readNameState, saveNameState, assertNameAvailable } = require('./asset-names');
const badInput = message => Object.assign(new Error(message), { status: 400 });

function validateInput(input) {
  const { year, month, filename, newFilename, expectedSha256 } = input;
  if (typeof year !== 'string' || typeof month !== 'string' || !isValidYearSeg(year) || !isValidMonthSeg(month)) throw badInput('Invalid file directory');
  for (const name of [filename, newFilename]) {
    if (typeof name !== 'string' || sanitizeSegment(name) !== name || !isAllowedAttachmentFile(name) || /[.\s]$/.test(name) || Buffer.byteLength(name) > 240 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw badInput('Use a valid filename without path separators or reserved characters');
  }
  if (newFilename !== newFilename.normalize('NFC')) throw badInput('Use a Unicode-normalized filename');
  if (path.extname(filename).toLowerCase() !== path.extname(newFilename).toLowerCase()) throw badInput('The file extension must stay the same');
  if (foldName(filename) === foldName(newFilename)) throw badInput('Enter a different filename');
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw badInput('Refresh the file list before renaming');
}
function metadata(year, month, filename, sha256, files = null) {
  const stat = fs.statSync(path.join(RAW_DIR, year, month, filename));
  return { year, month, filename, size: stat.size, sha256,
    ...buildAssetUrlsAndMeta(getConfig(), { year, month, filename, hasBasenameCollision: hasSiblingWithSameBasename(year, month, filename, files) }) };
}
function resultFor(record, state) {
  const { year, month } = record;
  const canonical = record.canonicalFilename || state.raw[keyOf(year, month, record.newFilename)] || record.newFilename;
  const item = metadata(year, month, canonical, record.expectedSha256);
  return { success: true, operationId: record.operationId, oldFilename: record.filename, item, aliasRetentionDays:record.aliasRetentionDays, aliasExpiresAt:record.aliasExpiresAt, linkMappings: assetLinkMappings(getConfig(), year, month, canonical, item, state) };
}
async function collectAliases(state, year, month, files, source) {
  for (const filename of files) {
    if (filename === source) {
      state.raw[keyOf(year, month, filename)] = filename;
      state.raw[keyOf(year, month, filename.replace(/[\s_]+/g, '_'))] = filename;
    }
    state.identities[keyOf(year, month, filename)] = await hashFileSha256(path.join(RAW_DIR, year, month, filename));
    for (const requested of routeNames(filename)) {
      const resolved = findRawFile(year, month, requested);
      if (resolved && path.basename(resolved) === filename) state.pub[keyOf(year, month, requested)] = filename;
    }
  }
}

/** Replay one journaled rename before any later mutation. Every metadata move is idempotent. */
function recoverPendingRename() {
  const state = readNameState(), record = state.pending;
  if (!record) return;
  const { year, month, filename, newFilename, expectedSha256 } = record;
  const sourceKey = keyOf(year, month, filename), targetKey = keyOf(year, month, newFilename);
  const source = path.join(RAW_DIR, sourceKey), target = path.join(RAW_DIR, targetKey);
  const sourceStat = fs.existsSync(source) ? fs.lstatSync(source) : null;
  if (!fs.existsSync(target)) {
    if (!sourceStat || !sourceStat.isFile() || sourceStat.ino !== record.ino || sourceStat.dev !== record.dev || sourceStat.size !== record.size || sourceStat.mtimeMs !== record.mtimeMs) throw conflict('The source file changed during rename');
    fs.linkSync(source, target); // Exclusive publication: never overwrite an existing file.
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.ino !== record.ino || stat.dev !== record.dev || stat.size !== record.size || stat.mtimeMs !== record.mtimeMs || (sourceStat && (sourceStat.ino !== stat.ino || sourceStat.dev !== stat.dev))) throw conflict('The rename target changed; automatic recovery stopped');
  invalidateAssetCache(year,month,filename);
  invalidateAssetCache(year,month,newFilename);
  getShaIndex();
  const previous = pathToShaMap.get(sourceKey);
  if (previous) removeShaIndex(previous.sha256, sourceKey, false);
  updateShaIndex(expectedSha256, { year, month, filename: newFilename, size: stat.size, mtimeMs: stat.mtimeMs, baselineSha256: record.baselineSha256 }, false);
  writeShaIndex();
  const protectedFiles = getProtectedMap();
  if (protectedFiles[sourceKey]) { protectedFiles[targetKey] = protectedFiles[sourceKey]; delete protectedFiles[sourceKey]; writeJsonData('protected_files', protectedFiles); }
  const shares = getSharesMap();
  let sharesChanged = false;
  for (const share of Object.values(shares)) {
    if (share.year === year && share.month === month && share.filename === filename) { share.filename = newFilename; sharesChanged = true; }
  }
  if (sharesChanged) saveSharesMap(shares);
  moveAssetStats(sourceKey, targetKey);
  // Preserve all previous aliases, pointing directly at the latest file, including its new name.
  for (const kind of ['raw', 'pub']) {
    Object.assign(state[kind], record.aliases[kind]);
    Object.assign(state.aliasExpirations[kind], record.aliases.aliasExpirations?.[kind]);
    for (const [key, targetName] of Object.entries(state[kind])) {
      if (key.startsWith(`${year}/${month}/`) && targetName === filename) state[kind][key] = newFilename;
    }
    // New canonical routes never expire, including a reclaimed name owned by this file.
    for (const key of Object.keys(state.aliasExpirations[kind])) {
      if (key.startsWith(`${year}/${month}/`) && !record.aliases.aliasExpirations?.[kind]?.[key]) delete state.aliasExpirations[kind][key];
    }
  }
  Object.assign(state.identities, record.aliases.identities);
  delete state.identities[sourceKey];
  state.identities[targetKey] = expectedSha256;
  saveNameState(state); // Old URLs resolve correctly before the old directory entry is removed.
  if (sourceStat) fs.unlinkSync(source);
  for (const operation of Object.values(state.operations)) {
    if (operation.year===year && operation.month===month && (operation.canonicalFilename || operation.newFilename)===filename) operation.canonicalFilename=newFilename;
  }
  state.operations[record.operationId] = { year, month, filename, newFilename, canonicalFilename:newFilename, expectedSha256, operationId: record.operationId, aliasRetentionDays:record.aliasRetentionDays, aliasExpiresAt:record.aliasExpiresAt };
  state.pending = null;
  saveNameState(state);
  invalidateScanCache();
}

async function renameAsset(input, { preview = false } = {}) {
  validateInput(input);
  const state = readNameState(), { year, month, filename, newFilename, expectedSha256, operationId } = input;
  if (!preview && (typeof operationId !== 'string' || !/^[a-zA-Z0-9-]{12,100}$/.test(operationId))) throw badInput('A valid operation ID is required');
  const previous = state.operations[operationId];
  if (!preview && previous) {
    if (['year','month','filename','newFilename','expectedSha256'].some(key => previous[key] !== input[key])) throw conflict('This operation ID belongs to a different rename');
    return resultFor(previous, state);
  }
  const directory = path.join(RAW_DIR, year, month), source = path.join(directory, filename);
  if (!fs.existsSync(source)) throw Object.assign(new Error('File not found. Refresh the file list.'), { status: 404 });
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || !isPathWithin(fs.realpathSync(source), fs.realpathSync(RAW_DIR))) throw badInput('Invalid source file');
  assertNameAvailable(directory, year, month, newFilename, { owner: filename });
  const actual = await hashFileSha256(source), after = fs.statSync(source);
  if (actual !== expectedSha256 || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw conflict('The file changed. Refresh the file list and try again.', 'SOURCE_CHANGED');
  getShaIndex();
  const known = pathToShaMap.get(keyOf(year, month, filename));
  const projected = structuredClone(state);
  const retentionDays = aliasRetentionDays(), expiresAt = Date.now() + retentionDays * 86400000;
  const files = fs.readdirSync(directory).filter(name => isAllowedAttachmentFile(name));
  const bases = new Set([path.parse(filename).name, path.parse(newFilename).name].map(foldName));
  await collectAliases(projected, year, month, files.filter(name => bases.has(foldName(path.parse(name).name))), filename);
  for (const kind of ['raw','pub']) {
    for (const [key, target] of Object.entries(projected[kind])) {
      if (key.startsWith(`${year}/${month}/`) && target === filename) {
        projected[kind][key] = newFilename;
        projected.aliasExpirations[kind][key] ??= expiresAt;
      }
    }
  }
  projected.raw[keyOf(year, month, newFilename)] = newFilename;
  projected.raw[keyOf(year, month, newFilename.replace(/[\s_]+/g, '_'))] = newFilename;
  // Explicit full-name optimized links cannot change when another extension is added later.
  projected.pub[keyOf(year, month, `${newFilename}.webp`)] = newFilename;
  const futureFiles = files.filter(name => name !== filename).concat(newFilename);
  if (!hasSiblingWithSameBasename(year, month, newFilename, futureFiles)) projected.pub[keyOf(year, month, `${path.parse(newFilename).name}.webp`)] = newFilename;
  for (const kind of ['raw','pub']) {
    const canonicalNames = kind==='raw' ? [newFilename,newFilename.replace(/[\s_]+/g,'_')] : routeNames(newFilename);
    for (const name of canonicalNames) delete projected.aliasExpirations[kind][keyOf(year,month,name)];
  }
  const record = { ...input, ino: stat.ino, dev: stat.dev, size: stat.size, mtimeMs: stat.mtimeMs,
    aliasRetentionDays:retentionDays, aliasExpiresAt:expiresAt,
    baselineSha256: known?.baselineSha256 || known?.sha256 || actual,
    aliases: { raw: projected.raw, pub: projected.pub, aliasExpirations:projected.aliasExpirations, identities: projected.identities } };
  if (preview) {
    const oldItem = metadata(year, month, filename, actual);
    const item = { year, month, filename: newFilename, size: stat.size, sha256: actual,
      ...buildAssetUrlsAndMeta(getConfig(), { year, month, filename: newFilename, hasBasenameCollision: hasSiblingWithSameBasename(year, month, newFilename, files.filter(name => name !== filename).concat(newFilename)) }) };
    return { success: true, oldFilename: filename, oldItem, item, aliasRetentionDays:retentionDays, aliasExpiresAt:expiresAt, linkMappings: assetLinkMappings(getConfig(), year, month, newFilename, item, projected) };
  }
  // No side effects occur before this persistent intent record.
  state.pending = record;
  saveNameState(state);
  recoverPendingRename();
  return resultFor(record, state);
}
module.exports = { renameAsset, recoverPendingRename };
