const crypto = require('node:crypto');
const multer = require('multer');
const { UPLOAD_TMP_DIR } = require('../../core/config');
const { ensureDirs } = require('./asset-paths');

// Multer disk-backed streaming upload handler (avoids memory exhaustion on large files)
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDirs();
    cb(null, UPLOAD_TMP_DIR);
  },
  filename: (req, file, cb) => {
    const rand = crypto.randomBytes(12).toString('hex');
    cb(null, `upload_${Date.now()}_${rand}.tmp`);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 10, parts: 11 }
});

const acceptSingleUpload = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message });
    }
    return next(err);
  });
};

module.exports = { acceptSingleUpload };
