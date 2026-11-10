const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isValidYearSeg, isValidMonthSeg, isAllowedAttachmentFile } = require('../../core/file-security');

function hashFileSha256(filename, options = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filename, options);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function* walkOriginalFiles(directory) {
  for (const year of await fs.promises.readdir(directory, { withFileTypes: true })) {
    if (!year.isDirectory() || !isValidYearSeg(year.name)) continue;
    const yearPath = path.join(directory, year.name);
    for (const month of await fs.promises.readdir(yearPath, { withFileTypes: true })) {
      if (!month.isDirectory() || !isValidMonthSeg(month.name)) continue;
      const monthPath = path.join(yearPath, month.name);
      const entries = (await fs.promises.readdir(monthPath, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && isAllowedAttachmentFile(entry.name));
      const counts = new Map();
      const basename = (name) => path.parse(name).name.replace(/[\s_]+/g, '_');
      for (const entry of entries) counts.set(basename(entry.name), (counts.get(basename(entry.name)) || 0) + 1);
      for (const entry of entries) {
        const fullPath = path.join(monthPath, entry.name);
        const stat = await fs.promises.stat(fullPath).catch((err) => {
          if (err.code === 'ENOENT') return null;
          throw err;
        });
        if (stat) yield { year: year.name, month: month.name, filename: entry.name, fullPath, stat,
          hasBasenameCollision: counts.get(basename(entry.name)) > 1 };
      }
    }
  }
}

/** Always reads original bytes. Never repairs or silently replaces expected hashes. */
async function verifyOriginalFiles(directory, expected, { signal, onProgress = () => {} } = {}) {
  const unseen = new Map(expected);
  const result = { checked: 0, matched: 0, issues: [] };
  for await (const file of walkOriginalFiles(directory)) {
    signal?.throwIfAborted();
    const rel = `${file.year}/${file.month}/${file.filename}`;
    const known = unseen.get(rel);
    unseen.delete(rel);
    try {
      const actual = await hashFileSha256(file.fullPath, { signal });
      const after = await fs.promises.stat(file.fullPath);
      if (after.size !== file.stat.size || after.mtimeMs !== file.stat.mtimeMs) {
        result.issues.push({ path: rel, type: 'changedDuringCheck' });
      } else if (!known?.sha256) {
        result.issues.push({ path: rel, type: 'unindexed', actual });
      } else if ((known.baselineSha256 || known.sha256) !== actual) {
        result.issues.push({ path: rel, type: 'mismatch', expected: known.baselineSha256 || known.sha256, actual });
      } else result.matched++;
    } catch (err) {
      if (signal?.aborted) throw err;
      result.issues.push({ path: rel, type: 'unreadable', error: err.code || err.message });
    }
    result.checked++;
    onProgress(result);
  }
  signal?.throwIfAborted();
  for (const rel of unseen.keys()) result.issues.push({ path: rel, type: 'missing' });
  return result;
}

// Filesystems that cannot hard-link (some Docker volumes, SMB/NFS, exFAT).
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS']);

/**
 * Atomically publish `staged` at `target` without overwriting. Prefers a hard link
 * (atomic, fails with EEXIST); falls back to an exclusive copy when links are unsupported.
 */
async function publishExclusive(staged, target) {
  try {
    await fs.promises.link(staged, target);
  } catch (err) {
    if (!LINK_UNSUPPORTED.has(err.code)) throw err;
    try {
      await fs.promises.copyFile(staged, target, fs.constants.COPYFILE_EXCL);
    } catch (copyErr) {
      // Never leave a partially written public file behind.
      if (copyErr.code !== 'EEXIST') await fs.promises.unlink(target).catch(() => {});
      throw copyErr;
    }
  }
}

/** Publish a complete file exclusively; existing names are never overwritten. */
async function persistUniqueUpload(file, directory, desiredName, sha256, disambiguate = false) {
  await fs.promises.mkdir(directory, { recursive: true });
  const ext = path.extname(desiredName);
  const base = path.basename(desiredName, ext);
  const staged = path.join(directory, `.upload-${crypto.randomUUID()}.tmp`);
  try {
    if (file.buffer) await fs.promises.writeFile(staged, file.buffer, { flag: 'wx' });
    else await fs.promises.copyFile(file.path, staged, fs.constants.COPYFILE_EXCL);
    for (let attempt = disambiguate ? 1 : 0; ; attempt++) {
      const suffix = attempt === 0 ? '' : attempt === 1 ? `_${sha256.slice(0, 8)}`
        : attempt === 2 ? `_${sha256}` : `_${sha256}_${crypto.randomUUID()}`;
      const filename = `${base}${suffix}${ext}`;
      const target = path.join(directory, filename);
      try {
        await publishExclusive(staged, target);
        return { filename, deduplicated: false, stat: await fs.promises.stat(target) };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (await hashFileSha256(target) === sha256) {
          return { filename, deduplicated: true, stat: await fs.promises.stat(target) };
        }
      }
    }
  } finally {
    await fs.promises.unlink(staged).catch(() => {});
  }
}

module.exports = { hashFileSha256, publishExclusive, persistUniqueUpload, walkOriginalFiles, verifyOriginalFiles };
