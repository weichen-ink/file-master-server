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
