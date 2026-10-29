const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const ROOT_DIR = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.yaml');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STORAGE_DIR = path.join(ROOT_DIR, 'storage');
const TRASH_DIR = path.join(STORAGE_DIR, 'trash');
const UPLOAD_TMP_DIR = path.join(STORAGE_DIR, 'tmp');

let cachedConfig = null;
let lastMtimeMs = 0;

function isConfigInitialized() {
  return fs.existsSync(CONFIG_PATH);
}

function getExampleConfigTemplate() {
  const examplePath = path.join(ROOT_DIR, 'config.example.yaml');
  if (fs.existsSync(examplePath)) {
    return fs.readFileSync(examplePath, 'utf8');
  }
  return `site_name: FileMaster Server
port: 3000
base_url: http://localhost:3000
trust_proxy: loopback
hot_update: true
upstream_repo: https://github.com/weichen-ink/file-master-server.git
upstream_mirror: ""
upstream_branch: main
admin_path: admin
username: admin
password: ""
max_login_attempts: 3
totp_secret: ""
api_token: ""
image_host:
  raw_secret_path: raw
  enable_optimization: true
  webp_quality: 82
  max_width: 1920
  watermark_enable: true
  watermark_type: image
  watermark_pos: bottom-right
  watermark_opacity: 0.65
  watermark_scale: 0.16
  watermark_margin: 24
  watermark_min_width: 320
  watermark_image: ./watermark.png
  watermark_text: "© FileMaster"
  watermark_color: "#ffffff"
`;
}

function normalizeParsedConfig(parsed, needsSetup = false) {
  const img = parsed.image_host || {};
  return {
    needsSetup,
    site_name: parsed.site_name || 'FileMaster Server',
    port: Number(parsed.port) || 3000,
    base_url: String(parsed.base_url || 'http://localhost:3000').replace(/\/+$/, ''),
    trust_proxy: parsed.trust_proxy !== undefined ? parsed.trust_proxy : 'loopback',
    hot_update: parsed.hot_update !== false,
    upstream_repo: String(
      parsed.upstream_repo || 'https://github.com/weichen-ink/file-master-server.git'
    ).trim(),
    upstream_mirror: String(parsed.upstream_mirror || '').trim(),
    upstream_branch: String(parsed.upstream_branch || 'main').trim() || 'main',
    admin_path: String(parsed.admin_path || 'admin').replace(/^\/+|\/+$/g, '') || 'admin',
    username: String(parsed.username || 'admin'),
    password: String(parsed.password || ''),
    max_login_attempts: Number(parsed.max_login_attempts) || 3,
    totp_secret: String(parsed.totp_secret || '').trim(),
    api_token: String(parsed.api_token || ''),
    image_host: {
      raw_secret_path: 'raw',
      enable_optimization: true,
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
      ...img,
      enable_optimization: img.enable_optimization !== false
    }
  };
}

/**
 * Initializes config.yaml from the web setup wizard based on config.example.yaml.
 */
function initializeConfigFromSetup(setupData = {}) {
  if (isConfigInitialized()) {
    throw new Error('Server is already initialized');
  }
  const template = getExampleConfigTemplate();
  const doc = YAML.parseDocument(template);

  const siteName = String(setupData.site_name || 'FileMaster Server').trim() || 'FileMaster Server';
  const port = Number(setupData.port) || 3000;
  const baseUrl = String(setupData.base_url || `http://localhost:${port}`).trim().replace(/\/+$/, '');
  const adminPath = String(setupData.admin_path || 'admin').trim().replace(/^\/+|\/+$/g, '') || 'admin';
  const username = String(setupData.username || 'admin').trim() || 'admin';
  const plainPassword = String(setupData.password || '').trim();
  if (!plainPassword) {
    throw new Error('Password cannot be empty');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plainPassword, salt, 64).toString('hex');
  const hashedPassword = `scrypt:${salt}:${derived}`;

  const apiToken =
    String(setupData.api_token || '').trim() || 'fm_' + crypto.randomBytes(16).toString('hex');
  const rawPath =
    String(setupData.raw_secret_path || 'raw').trim().replace(/^\/+|\/+$/g, '') || 'raw';
  const enableOptimization = setupData.enable_optimization !== false && setupData.enable_optimization !== 'false';
  const webpQuality = Number(setupData.webp_quality) || 82;
  const maxWidth = setupData.max_width !== undefined ? Number(setupData.max_width) : 1920;
  const watermarkEnable = setupData.watermark_enable !== false && setupData.watermark_enable !== 'false';

  doc.set('site_name', siteName);
  doc.set('port', port);
  doc.set('base_url', baseUrl);
  doc.set('admin_path', adminPath);
  doc.set('username', username);
  doc.set('password', hashedPassword);
  doc.set('api_token', apiToken);

  doc.setIn(['image_host', 'raw_secret_path'], rawPath);
  doc.setIn(['image_host', 'enable_optimization'], enableOptimization);
  doc.setIn(['image_host', 'webp_quality'], webpQuality);
  doc.setIn(['image_host', 'max_width'], maxWidth);
  doc.setIn(['image_host', 'watermark_enable'], watermarkEnable);

  return saveRawConfigYaml(doc.toString());
}

/**
 * Dynamically loads and caches config.yaml from the root directory.
 * If config.yaml does not exist yet, returns uninitialized defaults for setup wizard mode.
 */
function getConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const raw = getExampleConfigTemplate();
    const parsed = YAML.parse(raw) || {};
    return normalizeParsedConfig(parsed, true);
  }
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (!cachedConfig || stat.mtimeMs !== lastMtimeMs) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = YAML.parse(raw) || {};
      cachedConfig = normalizeParsedConfig(parsed, false);
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
  if (!fs.existsSync(CONFIG_PATH)) {
    return getExampleConfigTemplate();
  }
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
    'hot_update',
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
      'enable_optimization',
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
  TRASH_DIR,
  UPLOAD_TMP_DIR,
  isConfigInitialized,
  initializeConfigFromSetup,
  getConfig,
  getRawConfigYaml,
  saveRawConfigYaml,
  updateConfigPreservingComments,
  readJsonData,
  writeJsonData
};
