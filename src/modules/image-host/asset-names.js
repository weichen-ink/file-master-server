const fs = require('node:fs');
const path = require('node:path');
const { formatReadableUrlSegment } = require('../../core/file-security');
const { DATA_DIR, writeJsonData, getConfig, dataRevision, readCriticalJsonData, isRecord } = require('../../core/config');

const keyOf = (year, month, filename) => `${year}/${month}/${filename}`;
// The public resolver treats spaces and underscores as equivalent too.
const foldName = name => String(name).normalize('NFC').toLowerCase().replace(/[\s_]+/g, '_');
const conflict = (message, code = 'NAME_CONFLICT') => Object.assign(new Error(message), { status: 409, code });
let cached;
let loadedRevision;
const aliasRetentionDays = () => getConfig().image_host.rename_alias_days;
const canonicalRoutes = (kind, filename) => kind === 'raw' ? [filename,filename.replace(/[\s_]+/g,'_')] : routeNames(filename);
function pruneExpiredAliases(state, now = Date.now()) {
  let changed = false;
  for (const kind of ['raw','pub']) {
    for (const [key,expiresAt] of Object.entries(state.aliasExpirations[kind])) {
      if (expiresAt <= now) {
        delete state[kind][key];
        delete state.aliasExpirations[kind][key];
        changed = true;
      }
    }
  }
  if (changed) saveNameState(state);
  return state;
}
const validateNameState = value => isRecord(value) && value.version === 1 &&
    ['raw','pub','identities','operations'].every(key => isRecord(value[key])) &&
    ['raw','pub'].every(key => Object.values(value[key]).every(name => typeof name === 'string' && !/[\\/]/.test(name))) &&
    (value.aliasExpirations == null || ['raw','pub'].every(key => isRecord(value.aliasExpirations[key]) && Object.values(value.aliasExpirations[key]).every(Number.isFinite)));
function readNameState() {
  const revision = dataRevision('asset_names');
  if (cached && revision === loadedRevision) return pruneExpiredAliases(cached);
  const file = path.join(DATA_DIR, 'asset_names.json');
  if (!fs.existsSync(file)) { loadedRevision = revision; return (cached = { version: 1, raw: {}, pub: {}, aliasExpirations:{raw:{},pub:{}}, identities: {}, operations: {}, pending: null }); }
  const state = readCriticalJsonData('asset_names', null, validateNameState);
  loadedRevision = revision;
  if (!state.aliasExpirations) {
    // Existing installations get a full grace period from their first upgraded start.
    state.aliasExpirations = {raw:{},pub:{}};
    const expiresAt = Date.now() + aliasRetentionDays() * 86400000;
    for (const kind of ['raw','pub']) {
      for (const [key,target] of Object.entries(state[kind])) {
        if (!canonicalRoutes(kind,target).includes(key.split('/').pop())) state.aliasExpirations[kind][key] = expiresAt;
      }
    }
    // Older operation records used aliases to find their latest canonical name.
    for (const record of Object.values(state.operations)) record.canonicalFilename = state.raw[keyOf(record.year,record.month,record.newFilename)] || record.newFilename;
    saveNameState(state);
  }
  return pruneExpiredAliases(cached = state);
}
function saveNameState(state) {
  readCriticalJsonData('asset_names', null, validateNameState);
  writeJsonData('asset_names', state);
  loadedRevision = dataRevision('asset_names');
  cached = state;
}
function resolveAlias(year, month, filename, optimized) {
  const map = readNameState()[optimized ? 'pub' : 'raw'];
  return map[keyOf(year, month, filename)] || null;
}
const routeNames = filename => [...new Set([filename, `${filename}.webp`, `${path.parse(filename).name}.webp`]
  .flatMap(name => [name, name.replace(/[\s_]+/g, '_')]))];

/** One namespace check for uploads, renames and restores. Content deduplication runs before this. */
function assertNameAvailable(directory, year, month, filename, { owner = null, restoreSha256 = null } = {}) {
  const state = readNameState(), bucket = `${year}/${month}/`;
  const proposed = new Set([filename, `${filename}.webp`].map(foldName));
  const allowed = target => target === owner || (target === filename && restoreSha256 && state.identities[bucket + target] === restoreSha256);
  for (const [key, target] of [...Object.entries(state.raw), ...Object.entries(state.pub)]) {
    if (key.startsWith(bucket) && proposed.has(foldName(key.slice(bucket.length))) && !allowed(target)) {
      throw conflict('This name belongs to an existing or renamed file. Choose another name.', 'NAME_RESERVED');
    }
  }
  for (const name of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
    if (name !== owner && foldName(name) === foldName(filename)) {
      throw conflict('A different file already uses this name. Choose another name.');
    }
  }
}
function hasOptimizedNameConflict(year, month, filename) {
  const requested = `${path.parse(filename).name}.webp`, bucket = `${year}/${month}/`;
  return Object.entries(readNameState().pub).some(([key, target]) => key.startsWith(bucket) && foldName(key.slice(bucket.length)) === foldName(requested) && target !== filename);
}
/** All known public URL bases for an asset, shared by listing and rename previews. */
function assetLinkMappings(cfg, year, month, filename, item, state = readNameState()) {
  const bucket = `${year}/${month}/`, result = new Map();
  for (const [kind, prefixes, to] of [
    ['raw', [cfg.image_host?.raw_secret_path || 'raw'], item.rawUrl],
    ['pub', [cfg.image_host?.pub_secret_path || 'pub'], item.pubUrl]
  ]) {
    for (const [key, target] of Object.entries(state[kind])) {
      if (!key.startsWith(bucket) || target !== filename) continue;
      for (const prefix of prefixes) result.set(`${cfg.base_url}/${prefix}/${bucket}${formatReadableUrlSegment(key.slice(bucket.length))}`, to);
    }
  }
  return [...result].map(([from, to]) => ({ from, to }));
}
function assetReferenceUrls(cfg, year, month, filename, item) {
  const urls = new Set([item.rawUrl, item.pubUrl, ...assetLinkMappings(cfg, year, month, filename, item).map(mapping => mapping.from)]);
  return [...urls];
}
module.exports = { aliasRetentionDays, assetLinkMappings, assetReferenceUrls, hasOptimizedNameConflict, keyOf, foldName, conflict, routeNames, readNameState, saveNameState, resolveAlias, assertNameAvailable };
