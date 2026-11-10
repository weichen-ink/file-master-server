const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const { isPathWithin } = require('./file-security');

const ROOT_DIR = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.yaml');
const EXAMPLE_CONFIG_PATH = path.join(ROOT_DIR, 'config.example.yaml');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STORAGE_DIR = path.join(ROOT_DIR, 'storage');
const TRASH_DIR = path.join(STORAGE_DIR, 'trash');
const UPLOAD_TMP_DIR = path.join(STORAGE_DIR, 'tmp');
const OFFICIAL_UPSTREAM_REPO = 'https://github.com/weichen-ink/file-master-server.git';

let cachedConfig = null;
let lastMtimeMs = 0;

function isConfigInitialized() {
  return fs.existsSync(CONFIG_PATH);
}

function hashPasswordString(plainPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(plainPassword), salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function getExampleConfigTemplate() {
  if (fs.existsSync(EXAMPLE_CONFIG_PATH)) {
    return fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8');
  }
  return `site_name: File Master Server
port: 3210
base_url: http://localhost:3210
trust_proxy: loopback
hot_update: true
upstream_repo: ${OFFICIAL_UPSTREAM_REPO}
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
  pub_secret_path: pub
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
  watermark_image: ./wm-light.png
  watermark_image_dark: ./wm-dark.png
  watermark_auto_contrast: true
  watermark_text: "© File Master"
  watermark_color: "#ffffff"
  watermark_color_dark: "#111827"
  watermark_font: system
`;
}

let cachedTemplateDefaults = null;
function getTemplateDefaults() {
  if (!cachedTemplateDefaults) {
    try {
      cachedTemplateDefaults = YAML.parse(getExampleConfigTemplate()) || {};
    } catch {
      cachedTemplateDefaults = {};
    }
  }
  return cachedTemplateDefaults;
}

function validateWatermarkImagePath(wmImage, defaultVal = './wm-light.png') {
  const rel = String(wmImage || defaultVal).trim() || defaultVal;
  const resolved = path.resolve(ROOT_DIR, rel);
  if (!isPathWithin(resolved, ROOT_DIR)) {
    throw new Error('Invalid watermark_image path: must reside within the server root directory');
  }
  return rel;
}

function normalizeParsedConfig(parsed = {}, needsSetup = false) {
  const defaults = getTemplateDefaults();
  const defImg = defaults.image_host || {};
  const img = parsed.image_host || {};
  const rawWatermarkImg = img.watermark_image || defImg.watermark_image || './wm-light.png';
  let safeWatermarkImg = './wm-light.png';
  try {
    safeWatermarkImg = validateWatermarkImagePath(rawWatermarkImg, './wm-light.png');
  } catch {
    safeWatermarkImg = './wm-light.png';
  }

  const rawWatermarkDark = img.watermark_image_dark || defImg.watermark_image_dark || './wm-dark.png';
  let safeWatermarkDark = './wm-dark.png';
  try {
    safeWatermarkDark = validateWatermarkImagePath(rawWatermarkDark, './wm-dark.png');
  } catch {
    safeWatermarkDark = './wm-dark.png';
  }

  return {
    needsSetup,
    site_name: parsed.site_name || defaults.site_name || 'File Master Server',
    port: Number(parsed.port) || Number(defaults.port) || 3210,
    base_url: String(parsed.base_url || defaults.base_url || 'http://localhost:3210').replace(/\/+$/, ''),
    trust_proxy:
      parsed.trust_proxy !== undefined
        ? parsed.trust_proxy
        : defaults.trust_proxy !== undefined
          ? defaults.trust_proxy
          : 'loopback',
    hot_update: parsed.hot_update !== false,
    upstream_repo: OFFICIAL_UPSTREAM_REPO,
    upstream_mirror: String(parsed.upstream_mirror ?? defaults.upstream_mirror ?? '').trim(),
    upstream_branch: String(parsed.upstream_branch || defaults.upstream_branch || 'main').trim() || 'main',
    admin_path: String(parsed.admin_path || defaults.admin_path || 'admin').replace(/^\/+|\/+$/g, '') || 'admin',
    username: String(parsed.username || defaults.username || 'admin'),
    password: String(parsed.password || ''),
    max_login_attempts: Number(parsed.max_login_attempts) || Number(defaults.max_login_attempts) || 3,
    totp_secret: String(parsed.totp_secret || '').trim(),
    api_token: String(parsed.api_token || ''),
    image_host: {
      ...defImg,
      ...img,
      raw_secret_path:
        String(img.raw_secret_path || defImg.raw_secret_path || 'raw')
          .trim()
          .replace(/^\/+|\/+$/g, '') || 'raw',
      pub_secret_path:
        String(img.pub_secret_path || defImg.pub_secret_path || 'pub')
          .trim()
          .replace(/^\/+|\/+$/g, '') || 'pub',
      enable_optimization: img.enable_optimization !== false,
      watermark_image: safeWatermarkImg,
      watermark_image_dark: safeWatermarkDark,
      watermark_auto_contrast: img.watermark_auto_contrast !== false
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

  const siteName = String(setupData.site_name || 'File Master Server').trim() || 'File Master Server';
  const port = Number(setupData.port) || 3210;
  const baseUrl = String(setupData.base_url || `http://localhost:${port}`).trim().replace(/\/+$/, '');
  const adminPath = String(setupData.admin_path || 'admin').trim().replace(/^\/+|\/+$/g, '') || 'admin';
  const username = String(setupData.username || 'admin').trim() || 'admin';
  const plainPassword = String(setupData.password || '').trim();
  if (!plainPassword) {
    throw new Error('Password cannot be empty');
  }

  const hashedPassword = hashPasswordString(plainPassword);
  const apiToken =
    String(setupData.api_token || '').trim() || 'fm_' + crypto.randomBytes(16).toString('hex');
  const rawPath =
    String(setupData.raw_secret_path || 'raw').trim().replace(/^\/+|\/+$/g, '') || 'raw';
  const pubPath =
    String(setupData.pub_secret_path || 'pub').trim().replace(/^\/+|\/+$/g, '') || 'pub';
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
  doc.setIn(['image_host', 'pub_secret_path'], pubPath);
  doc.setIn(['image_host', 'enable_optimization'], enableOptimization);
  doc.setIn(['image_host', 'webp_quality'], webpQuality);
  doc.setIn(['image_host', 'max_width'], maxWidth);
  doc.setIn(['image_host', 'watermark_enable'], watermarkEnable);

  return saveRawConfigYaml(doc.toString());
}

let configOverride = null;

function setConfigOverride(override) {
  configOverride = override;
}

/**
 * Dynamically loads and caches config.yaml from the root directory.
 * If config.yaml does not exist yet, returns uninitialized defaults for setup wizard mode.
 */
function getConfig() {
  if (configOverride) {
    return configOverride;
  }
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
 * Produces a desensitized config object and rawYaml for browser responses.
 * By default, password, api_token, and totp_secret are stripped from both config and rawYaml.
 * When revealSecrets is true, api_token and totp_secret are included (password hash is never exposed).
 */
function redactConfigForClient(cfg, rawYaml, revealSecrets = false) {
  const safeConfig = {
    ...cfg,
    password: '',
    api_token: revealSecrets ? cfg.api_token : '',
    totp_secret: revealSecrets ? cfg.totp_secret : '',
    hasPassword: Boolean(cfg.password),
    hasTotp: Boolean(cfg.totp_secret),
    hasApiToken: Boolean(cfg.api_token)
  };

  let safeRawYaml = String(rawYaml || '');
  try {
    const doc = YAML.parseDocument(safeRawYaml);
    if (doc.has('password')) doc.set('password', '');
    if (!revealSecrets) {
      if (doc.has('api_token')) doc.set('api_token', '');
      if (doc.has('totp_secret')) doc.set('totp_secret', '');
    }
    safeRawYaml = doc.toString();
  } catch {}

  return {
    config: safeConfig,
    rawYaml: safeRawYaml
  };
}

/**
 * Prepares config.yaml content without writing it, enforcing security invariants
 * (password scrypt hashing, preserving existing secrets when blanked by redacted editor,
 * locking upstream_repo, and validating watermark_image path boundaries).
 */
function prepareRawConfigYaml(rawText, { clearTotp = false } = {}) {
  const doc = YAML.parseDocument(String(rawText));
  if (doc.errors.length > 0) throw doc.errors[0];
  const parsed = doc.toJS();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid YAML format: root element must be a key-value object');
  }
  if (parsed.image_host !== undefined &&
    (!parsed.image_host || typeof parsed.image_host !== 'object' || Array.isArray(parsed.image_host))) {
    throw new Error('Invalid YAML format: image_host must be a key-value object');
  }

  const existingCfg = isConfigInitialized() ? getConfig() : null;

  // 1. Enforce password hashing & preserve existing password if submitted blank on an initialized server
  const rawPass = parsed.password !== undefined ? String(parsed.password).trim() : '';
  if (!rawPass) {
    if (existingCfg && existingCfg.password) {
      doc.set('password', existingCfg.password);
    }
  } else if (!rawPass.startsWith('scrypt:')) {
    doc.set('password', hashPasswordString(rawPass));
  }

  // 2. Preserve existing api_token if submitted blank on an initialized server
  const rawToken = parsed.api_token !== undefined ? String(parsed.api_token).trim() : '';
  if (!rawToken && existingCfg && existingCfg.api_token) {
    doc.set('api_token', existingCfg.api_token);
  }

  // 3. Preserve existing totp_secret if submitted blank in raw mode unless explicitly cleared via form
  const rawTotp = parsed.totp_secret !== undefined ? String(parsed.totp_secret).trim() : '';
  if (clearTotp) {
    doc.set('totp_secret', '');
  } else if (!rawTotp && existingCfg && existingCfg.totp_secret) {
    doc.set('totp_secret', existingCfg.totp_secret);
  }

  // 4. Lock upstream_repo to official repository if present
  if (doc.has('upstream_repo')) {
    doc.set('upstream_repo', OFFICIAL_UPSTREAM_REPO);
  }

  // 5. Validate watermark_image path boundary
  if (parsed.image_host && parsed.image_host.watermark_image !== undefined) {
    const safeWm = validateWatermarkImagePath(parsed.image_host.watermark_image, './wm-light.png');
    doc.setIn(['image_host', 'watermark_image'], safeWm);
  }
  if (parsed.image_host && parsed.image_host.watermark_image_dark !== undefined) {
    const safeWmDark = validateWatermarkImagePath(parsed.image_host.watermark_image_dark, './wm-dark.png');
    doc.setIn(['image_host', 'watermark_image_dark'], safeWmDark);
  }

  return {
    yaml: doc.toString(),
    config: normalizeParsedConfig(doc.toJS(), false)
  };
}

function writePreparedConfig(prepared) {
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, prepared.yaml, 'utf8');
  fs.renameSync(tmpPath, CONFIG_PATH);
  lastMtimeMs = 0;
  return getConfig();
}

function saveRawConfigYaml(rawText) {
  return writePreparedConfig(prepareRawConfigYaml(rawText));
}

const IMAGE_PROCESSING_CONFIG_KEYS = [
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
  'watermark_image_dark',
  'watermark_auto_contrast',
  'watermark_text',
  'watermark_color',
  'watermark_color_dark',
  'watermark_font'
];

/**
 * Updates specific config fields via AST nodes, preserving existing comments and structure.
 */
function prepareConfigPatch(patch = {}) {
  const raw = getRawConfigYaml();
  const doc = YAML.parseDocument(raw);

  const topKeys = [
    'site_name',
    'port',
    'base_url',
    'trust_proxy',
    'hot_update',
    'upstream_mirror',
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
      if ((key === 'password' || key === 'api_token' || key === 'totp_secret') && patch[key] === '') {
        continue;
      }
      doc.set(key, patch[key]);
    }
  }

  if (patch.clear_totp === true) {
    doc.set('totp_secret', '');
  }

  if (patch.image_host && typeof patch.image_host === 'object') {
    const imgKeys = [
      'raw_secret_path',
      'pub_secret_path',
      ...IMAGE_PROCESSING_CONFIG_KEYS
    ];
    for (const k of imgKeys) {
      if (patch.image_host[k] !== undefined) {
        doc.setIn(['image_host', k], patch.image_host[k]);
      }
    }
  }

  return prepareRawConfigYaml(doc.toString(), { clearTotp: patch.clear_totp === true });
}

function updateConfigPreservingComments(patch = {}) {
  return writePreparedConfig(prepareConfigPatch(patch));
}

module.exports = {
  ROOT_DIR,
  CONFIG_PATH,
  EXAMPLE_CONFIG_PATH,
  OFFICIAL_UPSTREAM_REPO,
  DATA_DIR,
  STORAGE_DIR,
  TRASH_DIR,
  UPLOAD_TMP_DIR,
  isConfigInitialized,
  initializeConfigFromSetup,
  getConfig,
  setConfigOverride,
  getRawConfigYaml,
  redactConfigForClient,
  validateWatermarkImagePath,
  prepareRawConfigYaml,
  prepareConfigPatch,
  writePreparedConfig,
  saveRawConfigYaml,
  updateConfigPreservingComments,
  IMAGE_PROCESSING_CONFIG_KEYS,
  readJsonData,
  writeJsonData
};
