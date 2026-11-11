const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, writeJsonData } = require('../../core/config');

const keyOf = (year, month, filename) => `${year}/${month}/${filename}`;
// The public resolver treats spaces and underscores as equivalent too.
const foldName = name => String(name).normalize('NFC').toLowerCase().replace(/[\s_]+/g, '_');
const conflict = (message, code = 'NAME_CONFLICT') => Object.assign(new Error(message), { status: 409, code });
let cached;
function readNameState() {
  if (cached) return cached;
  const file = path.join(DATA_DIR, 'asset_names.json');
  if (!fs.existsSync(file)) return (cached = { version: 1, raw: {}, pub: {}, identities: {}, operations: {}, pending: null });
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.version !== 1 || !['raw','pub','identities','operations'].every(key => state[key] && typeof state[key] === 'object' && !Array.isArray(state[key]))) {
    throw new Error('Invalid asset name registry; restore asset_names.json before modifying files');
  }
  return (cached = state);
}
function saveNameState(state) {
  writeJsonData('asset_names', state);
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
module.exports = { hasOptimizedNameConflict, keyOf, foldName, conflict, routeNames, readNameState, saveNameState, resolveAlias, assertNameAvailable };
