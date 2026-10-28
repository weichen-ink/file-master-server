const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const ROOT_DIR = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.yaml');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STORAGE_DIR = path.join(ROOT_DIR, 'storage');

let cachedConfig = null;
let lastMtimeMs = 0;

/**
 * Dynamically loads and caches config.yaml from the root directory.
 * Reloads automatically when the file mtime changes to support hot updates.
 */
function getConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (!cachedConfig || stat.mtimeMs !== lastMtimeMs) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = YAML.parse(raw) || {};
      cachedConfig = {
        site_name: parsed.site_name || 'FileMaster Server',
        port: Number(parsed.port) || 3000,
        base_url: String(parsed.base_url || 'http://localhost:3000').replace(/\/+$/, ''),
        upstream_repo: String(
          parsed.upstream_repo || 'https://github.com/weichen-ink/file-master-server.git'
        ).trim(),
        upstream_branch: String(parsed.upstream_branch || 'main').trim() || 'main',
        admin_path: String(parsed.admin_path || 'panel-9x7k2m').replace(/^\/+|\/+$/g, ''),
        username: String(parsed.username || 'admin'),
        password: String(parsed.password || 'admin-password-123'),
        max_login_attempts: Number(parsed.max_login_attempts) || 3,
        totp_secret: String(parsed.totp_secret || '').trim(),
        api_token: String(parsed.api_token || ''),
        image_host: {
          raw_secret_path: 'raw-8f9a2b',
          webp_quality: 82,
          max_width: 1920,
          watermark_enable: true,
          watermark_type: 'image',
          watermark_pos: 'bottom-right',
          watermark_opacity: 0.65,
          watermark_scale: 0.16,
          watermark_margin: 24,
          watermark_min_width: 320,
          watermark_image: './watermark.png',
          watermark_text: '© FileMaster',
          watermark_color: '#ffffff',
          ...(parsed.image_host || {})
        }
      };
      lastMtimeMs = stat.mtimeMs;
    }
    return cachedConfig;
  } catch (err) {
    console.error('[Config] Failed to read config.yaml:', err.message);
    if (cachedConfig) return cachedConfig;
    throw err;
  }
}

/**
 * Reads module-specific JSON data from data/<moduleName>.json.
 */
function readJsonData(moduleName, defaultData = []) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const filePath = path.join(DATA_DIR, `${moduleName}.json`);
  if (!fs.existsSync(filePath)) return defaultData;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[Data] Failed to parse ${moduleName}.json:`, err.message);
    return defaultData;
  }
}

/**
 * Atomically writes data to data/<moduleName>.json using a temporary file.
 */
function writeJsonData(moduleName, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const filePath = path.join(DATA_DIR, `${moduleName}.json`);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Returns raw config.yaml string including comments and formatting.
 */
function getRawConfigYaml() {
  return fs.readFileSync(CONFIG_PATH, 'utf8');
}

/**
 * Validates and atomically saves raw config.yaml content.
 */
function saveRawConfigYaml(rawText) {
  const parsed = YAML.parse(String(rawText));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid YAML format: root element must be a key-value object');
  }
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, String(rawText), 'utf8');
  fs.renameSync(tmpPath, CONFIG_PATH);
  lastMtimeMs = 0;
  return getConfig();
}

/**
 * Updates specific config fields via AST nodes, preserving existing comments and structure.
 */
function updateConfigPreservingComments(patch) {
  const raw = getRawConfigYaml();
  const doc = YAML.parseDocument(raw);

  const topKeys = [
    'site_name',
    'port',
    'base_url',
    'upstream_repo',
    'upstream_branch',
    'admin_path',
    'username',
    'password',
    'max_login_attempts',
    'totp_secret',
    'api_token'
  ];

  for (const key of topKeys) {
    if (patch[key] !== undefined) {
      doc.set(key, patch[key]);
    }
  }

  if (patch.image_host && typeof patch.image_host === 'object') {
    const imgKeys = [
      'raw_secret_path',
      'webp_quality',
      'max_width',
      'watermark_enable',
      'watermark_type',
      'watermark_pos',
      'watermark_opacity',
      'watermark_scale',
      'watermark_margin',
      'watermark_min_width',
      'watermark_image',
      'watermark_text',
      'watermark_color'
    ];
    for (const k of imgKeys) {
      if (patch.image_host[k] !== undefined) {
        doc.setIn(['image_host', k], patch.image_host[k]);
      }
    }
  }

  return saveRawConfigYaml(doc.toString());
}

module.exports = {
  ROOT_DIR,
  CONFIG_PATH,
  DATA_DIR,
  STORAGE_DIR,
  getConfig,
  getRawConfigYaml,
  saveRawConfigYaml,
  updateConfigPreservingComments,
  readJsonData,
  writeJsonData
};
