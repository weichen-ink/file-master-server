const fs = require('node:fs');

// Open without following a final symlink; chmod the descriptor before writing.
function openPrivateFile(file, flags) {
  const fd = fs.openSync(file, flags | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0), 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Private state path is not a regular file: ${file}`);
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function ensurePrivateFile(file) {
  let fd;
  try { fd = openPrivateFile(file, fs.constants.O_RDONLY); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fs.closeSync(fd);
}

function writePrivateFile(file, content, { append = false } = {}) {
  const fd = openPrivateFile(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | (append ? fs.constants.O_APPEND : 0));
  try {
    if (!append) fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, 'utf8');
  } finally { fs.closeSync(fd); }
}

module.exports = { openPrivateFile, ensurePrivateFile, writePrivateFile };
