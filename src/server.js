const express = require('express');
const path = require('node:path');
const {
  getConfig,
  getRawConfigYaml,
  saveRawConfigYaml,
  updateConfigPreservingComments
} = require('./core/config');
const {
  getClientIp,
  checkIpBan,
  recordLoginFailure,
  clearLoginFailures,
  generateTotpSecret,
  verifyTotp,
  createSessionToken,
  isAdminAuthenticated,
  requireAdmin
} = require('./core/security');
const { collectRuntimeMetrics } = require('./core/metrics');
const { registerImageHostModule } = require('./modules/image-host');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ================= 1. Platform Authentication and Status APIs =================
app.get('/api/platform/status', (req, res) => {
  const cfg = getConfig();
  const authenticated = isAdminAuthenticated(req);
  res.json({
    siteName: cfg.site_name,
    authenticated,
    username: authenticated ? cfg.username : null,
    totpEnabled: Boolean(cfg.totp_secret),
    endpoints: {
      port: cfg.port,
      baseUrl: cfg.base_url,
      uploadUrl: `${cfg.base_url}/api/image/upload`,
      localUploadUrl: `http://127.0.0.1:${cfg.port}/api/image/upload`,
      apiToken: cfg.api_token,
      rawSecretPath: cfg.image_host.raw_secret_path,
      adminPath: cfg.admin_path
    }
  });
});

app.post('/api/platform/login', (req, res) => {
  const ip = getClientIp(req);
  const ban = checkIpBan(ip);
  if (ban.banned) {
    return res.status(403).json({
      error: `Your IP is locked by the security system. Try again in ${ban.hoursLeft} hours.`
    });
  }

  const cfg = getConfig();
  const { username, password, totpCode, rememberMe } = req.body || {};

  const userOk = String(username || '').trim() === cfg.username;
  const passOk = String(password || '') === cfg.password;
  const totpOk = verifyTotp(cfg.totp_secret, totpCode);

  if (!userOk || !passOk || !totpOk) {
    const remaining = recordLoginFailure(ip);
    if (remaining === 0) {
      return res.status(403).json({
        error: 'Maximum login attempts exceeded. Your IP has been banned for 24 hours.'
      });
    }
    return res.status(401).json({
      error: `Invalid credentials or 2FA code (${remaining} attempts remaining)`
    });
  }

  clearLoginFailures(ip);
  const token = createSessionToken(cfg);
  const maxAgeAttr = rememberMe ? `; Max-Age=${30 * 24 * 60 * 60}` : '';
  res.setHeader(
    'Set-Cookie',
    `filemaster_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${maxAgeAttr}`
  );
  res.json({ success: true });
});

app.post('/api/platform/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'filemaster_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ success: true });
});

app.post('/api/platform/totp-generate', requireAdmin, (req, res) => {
  const cfg = getConfig();
  const secret = generateTotpSecret(16);
  const issuer = encodeURIComponent(cfg.site_name || 'FileMaster');
  const user = encodeURIComponent(cfg.username || 'admin');
  const otpauthUri = `otpauth://totp/${issuer}:${user}?secret=${secret}&issuer=${issuer}`;
  res.json({ secret, otpauthUri });
});

app.get('/api/platform/metrics', requireAdmin, (req, res) => {
  res.json(collectRuntimeMetrics());
});

app.get('/api/platform/config', requireAdmin, (req, res) => {
  res.json({
    config: getConfig(),
    rawYaml: getRawConfigYaml()
  });
});

app.put('/api/platform/config', requireAdmin, (req, res) => {
  try {
    const oldAdminPath = getConfig().admin_path;
    const { mode, rawYaml, patch } = req.body || {};

    let updatedCfg;
    if (mode === 'raw') {
      updatedCfg = saveRawConfigYaml(rawYaml);
    } else {
      updatedCfg = updateConfigPreservingComments(patch || {});
    }

    // Re-issue session cookie so password or admin path change doesn't break current session
    const newToken = createSessionToken(updatedCfg);
    res.setHeader(
      'Set-Cookie',
      `filemaster_session=${encodeURIComponent(newToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`
    );

    res.json({
      success: true,
      config: updatedCfg,
      rawYaml: getRawConfigYaml(),
      adminPathChanged: oldAdminPath !== updatedCfg.admin_path,
      newAdminPath: updatedCfg.admin_path
    });
  } catch (err) {
    res.status(400).json({ error: 'Failed to save configuration: ' + err.message });
  }
});

// ================= 2. Mount Platform Modules =================
// Module 1: Image Host & Asset Manager
registerImageHostModule(app);

// Additional modules (Countdowns, File Share, etc.) can be mounted here

// ================= 3. Stealth Admin Console & Scanner Blocker =================
app.get('/:customAdminPath', (req, res, next) => {
  const cfg = getConfig();
  if (req.params.customAdminPath === cfg.admin_path) {
    const ip = getClientIp(req);
    const ban = checkIpBan(ip);
    if (ban.banned) {
      return res.status(403).send(`IP is currently banned. Try again in ${ban.hoursLeft} hours.`);
    }
    return res.sendFile(path.join(__dirname, 'public/console.html'));
  }
  next();
});

// Any requests to /, /admin, /login, or unmapped routes return generic 404 to avoid scanner detection
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// ================= 4. Server Initialization =================
const initialCfg = getConfig();
const PORT = process.env.PORT || initialCfg.port || 3000;

app.listen(PORT, () => {
  const cfg = getConfig();
  console.log(`🚀 ${cfg.site_name} is running!`);
  console.log(`🔒 Stealth Console: ${cfg.base_url}/${cfg.admin_path}`);
  console.log(`🖼️ Raw Asset Route: ${cfg.base_url}/${cfg.image_host.raw_secret_path}/YYYY/MM/filename.ext`);
  console.log(`🌐 Public WebP Route: ${cfg.base_url}/pub/YYYY/MM/filename.webp`);
});
