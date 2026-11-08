const path = require('node:path');

// Extensions safe for inline browser display (excludes .svg, .html, .xml to prevent stored XSS)
const INLINE_SAFE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.avif',
  '.bmp',
  '.ico',
  '.heic',
  '.heif',
  '.tif',
  '.tiff',
  '.pdf',
  '.mp4',
  '.webm',
  '.mov',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.flac',
  '.txt'
]);

// Processable raster image extensions (convertible to WebP + watermark via sharp)
const PROCESSABLE_IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.avif',
  '.tiff',
  '.tif',
  '.heic',
  '.heif'
]);

// Passthrough image extensions (served directly without sharp re-encoding)
const PASSTHROUGH_IMAGE_EXTS = new Set(['.svg', '.bmp', '.ico']);

// Extensions that browsers (Chrome/Edge/Firefox) cannot render natively in <img> tags
const NEEDS_TRANSCODE_EXTS = new Set(['.heic', '.heif', '.tif', '.tiff']);

// Non-image document & media extensions supported by FileMaster unified attachment storage
const DOCUMENT_AND_MEDIA_EXTS = new Set([
  '.pdf',
  '.mp4',
  '.webm',
  '.mov',
  '.mkv',
  '.avi',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.flac',
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.csv',
  '.txt',
  '.json',
  '.md',
  '.excalidraw',
  '.canvas'
]);

const ALL_ALLOWED_EXTS = new Set([
  ...PROCESSABLE_IMAGE_EXTS,
  ...PASSTHROUGH_IMAGE_EXTS,
  ...DOCUMENT_AND_MEDIA_EXTS
]);

function getFileCategory(ext) {
  const e = String(ext || '').toLowerCase();
  if (PROCESSABLE_IMAGE_EXTS.has(e) || PASSTHROUGH_IMAGE_EXTS.has(e)) return 'image';
  if (e === '.pdf') return 'pdf';
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(e)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(e)) return 'audio';
  if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(e)) return 'archive';
  return 'document';
}

function isAllowedAttachmentFile(filename) {
  if (!filename || filename.startsWith('.')) return false;
  const ext = path.extname(filename).toLowerCase();
  return ALL_ALLOWED_EXTS.has(ext);
}

/**
 * Verifies that targetPath resolves strictly inside baseDir to prevent path traversal.
 */
function isPathWithin(targetPath, baseDir) {
  const resolvedBase = path.resolve(baseDir) + path.sep;
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase);
}

/**
 * Sets strict Content-Security-Policy and Content-Disposition headers on served files.
 */
function setSecurityFileHeaders(res, filePath, forceDownloadName = null) {
  const ext = path.extname(filePath).toLowerCase();
  const filename = forceDownloadName || path.basename(filePath);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"
  );
  if (forceDownloadName || !INLINE_SAFE_EXTS.has(ext)) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
  } else {
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
  }
}

function sanitizeSegment(seg) {
  let decoded = String(seg || '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}
  return path.basename(decoded).replace(/[\/\\?%*:|"<>#\0]/g, '_').trim();
}

/**
 * Sanitizes uploaded filenames: preserves CJK characters while replacing spaces
 * and brackets with underscores for clean Markdown readability.
 */
function sanitizeUploadFilename(seg) {
  const base = sanitizeSegment(seg);
  return base.replace(/[\s()[\]]+/g, '_').replace(/_+/g, '_');
}

function isValidYearSeg(y) {
  return /^\d{4}$/.test(y) || y === 'protected';
}

function isValidMonthSeg(m) {
  return /^\d{2}$/.test(m) || m === 'keep';
}

/**
 * Formats a filename segment for URL output while preserving readable CJK/Unicode characters.
 */
function formatReadableUrlSegment(filename) {
  return String(filename || '')
    .replace(/\s+/g, '_')
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\[/g, '%5B')
    .replace(/\]/g, '%5D');
}

/**
 * Builds consistent URLs, preview paths, and Markdown snippets for a stored asset.
 */
function buildAssetUrlsAndMeta(cfg, { year, month, filename, originalName = null, hasBasenameCollision = false }) {
  const ext = path.extname(filename).toLowerCase();
  const isProcessableImage = PROCESSABLE_IMAGE_EXTS.has(ext);
  const category = getFileCategory(ext);
  const baseName = path.parse(filename).name;

  const readableFileUrlSeg = formatReadableUrlSegment(filename);
  const readableBaseUrlSeg = formatReadableUrlSegment(baseName);
  const relPath = `${year}/${month}/${readableFileUrlSeg}`;
  const pubWebpSeg = hasBasenameCollision ? `${readableFileUrlSeg}.webp` : `${readableBaseUrlSeg}.webp`;
  const pubRelPath = isProcessableImage ? `${year}/${month}/${pubWebpSeg}` : relPath;

  const rawSecret = cfg.image_host?.raw_secret_path || 'raw';
  const pubSecret = cfg.image_host?.pub_secret_path || 'pub';
  const optimizationEnabled = cfg.image_host?.enable_optimization !== false;

  const rawUrl = `${cfg.base_url}/${rawSecret}/${relPath}`;
  const pubUrl = `${cfg.base_url}/${pubSecret}/${pubRelPath}`;
  const rawPreviewPath = `/${rawSecret}/${relPath}`;
  const pubPreviewPath = `/${pubSecret}/${pubRelPath}`;

  const titleSource = originalName || filename;
  const cleanTitle = path.basename(titleSource, path.extname(titleSource));
  const markdown = category === 'image' ? `![](${rawUrl})` : `[📎 ${cleanTitle}${ext}](${rawUrl})`;

  return {
    ext,
    category,
    isImage: category === 'image',
    isProcessableImage,
    optimizationEnabled,
    rawUrl,
    pubUrl,
    rawPreviewPath,
    pubPreviewPath,
    markdown
  };
}

module.exports = {
  INLINE_SAFE_EXTS,
  PROCESSABLE_IMAGE_EXTS,
  PASSTHROUGH_IMAGE_EXTS,
  NEEDS_TRANSCODE_EXTS,
  DOCUMENT_AND_MEDIA_EXTS,
  ALL_ALLOWED_EXTS,
  getFileCategory,
  isAllowedAttachmentFile,
  isPathWithin,
  setSecurityFileHeaders,
  sanitizeSegment,
  sanitizeUploadFilename,
  isValidYearSeg,
  isValidMonthSeg,
  formatReadableUrlSegment,
  buildAssetUrlsAndMeta
};

