const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const {
  ROOT_DIR,
  UPLOAD_TMP_DIR,
  isConfigInitialized,
  initializeConfigFromSetup,
  getConfig,
  getRawConfigYaml,
  saveRawConfigYaml,
  updateConfigPreservingComments
} = require('./core/config');
const {
  hashPassword,
  verifyPassword,
  getClientIp,
  checkIpBan,
  recordLoginFailure,
  clearLoginFailures,
  generateTotpSecret,
  verifyTotp,
  createSessionToken,
  SETUP_TOKEN,
  requireSetupToken,
  createSessionCookie,
  revokeSessionToken,
  isAdminAuthenticated,
  requireAdmin,
  createRateLimiter
} = require('./core/security');
const { collectRuntimeMetrics } = require('./core/metrics');
const {
  readPackageVersion,
  getUpdateStatus,
  performHotUpdate,
  restartServerProcess,
  validateGitMirror
} = require('./core/updater');
const { appendAuditLog } = require('./core/audit');
const { registerImageHostModule } = require('./modules/image-host');
const { registerShareModule } = require('./modules/share');

let httpServer = null;

const app = express();
const initCfg = getConfig();
if (initCfg.trust_proxy !== false) {
  app.set('trust proxy', initCfg.trust_proxy || 'loopback');
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Global Security Response Headers
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// CSRF Defense for state-changing administrative requests
app.use((req, res, next) => {
  const method = req.method.toUpperCase();
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          return res.status(403).json({ error: 'CSRF validation failed: Origin mismatch' });
        }
      } catch {
        return res.status(403).json({ error: 'CSRF validation failed: invalid Origin' });
      }
    }
  }
  next();
});

// ================= 1. Platform Authentication and Status APIs =================
// Public version contract for client plugin compatibility checks
app.get('/api/platform/version', (req, res) => {
  res.json({
    name: 'file-master-server',
    version: readPackageVersion(),
    apiVersion: 1,
    minPluginVersion: '1.0.0',
    features: {
      webp: true,
      watermark: true,
      shaDeduplication: true,
      protectedLocks: true,
      hotUpdate: true
    }
  });
});

app.get('/api/platform/status', (req, res) => {
  const cfg = getConfig();
  const needsSetup = !isConfigInitialized();
  const authenticated = !needsSetup && isAdminAuthenticated(req);
  res.json({
    siteName: cfg.site_name,
    needsSetup,
    optimizationEnabled: cfg.image_host?.enable_optimization !== false,
    authenticated,
    username: authenticated ? cfg.username : null,
    totpEnabled: Boolean(cfg.totp_secret),
    endpoints: authenticated
      ? {
          port: cfg.port,
          baseUrl: cfg.base_url,
          uploadUrl: `${cfg.base_url}/api/image/upload`,
          localUploadUrl: `http://127.0.0.1:${cfg.port}/api/image/upload`,
          apiToken: cfg.api_token,
          rawSecretPath: cfg.image_host.raw_secret_path,
          pubSecretPath: cfg.image_host.pub_secret_path || 'pub',
          adminPath: cfg.admin_path
        }
      : null
  });
});

// First-time Setup Wizard APIs (permanently locked once config.yaml exists)
app.get('/api/platform/setup-defaults', (req, res) => {
  if (isConfigInitialized()) {
    return res.status(403).json({ error: 'Server is already initialized' });
  }
  const cfg = getConfig();
  res.json({
    site_name: cfg.site_name,
    port: cfg.port,
    base_url: cfg.base_url,
    admin_path: cfg.admin_path || 'admin',
    username: cfg.username || 'admin',
    suggested_password: crypto.randomBytes(6).toString('hex'),
    suggested_api_token: 'fm_' + crypto.randomBytes(16).toString('hex'),
    raw_secret_path: cfg.image_host?.raw_secret_path || 'raw',
    pub_secret_path: cfg.image_host?.pub_secret_path || 'pub',
    enable_optimization: cfg.image_host?.enable_optimization !== false,
    webp_quality: cfg.image_host?.webp_quality ?? 82,
    max_width: cfg.image_host?.max_width ?? 1920,
    watermark_enable: cfg.image_host?.watermark_enable !== false
  });
});

app.post('/api/platform/setup', requireSetupToken, (req, res) => {
  if (isConfigInitialized()) {
    return res.status(403).json({ error: 'Server is already initialized' });
  }
  try {
    const newCfg = initializeConfigFromSetup(req.body || {});
    const token = createSessionToken(newCfg);
    res.setHeader(
      'Set-Cookie',
      createSessionCookie(req, token, `; Max-Age=${30 * 24 * 60 * 60}`)
    );
    appendAuditLog({
      action: 'initial_setup',
      ip: getClientIp(req),
      username: newCfg.username,
      adminPath: newCfg.admin_path,
      enableOptimization: newCfg.image_host.enable_optimization
    });
    res.json({
      success: true,
      redirectUrl: `/${newCfg.admin_path}`
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const loginRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many login requests from this IP. Please try again in a minute.'
});

app.post('/api/platform/login', loginRateLimiter, (req, res) => {
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
  const passOk = verifyPassword(password, cfg.password);
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
    createSessionCookie(req, token, maxAgeAttr)
  );
  res.json({ success: true });
});

app.post('/api/platform/logout', (req, res) => {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/filemaster_session=([^;]+)/);
  if (match) {
    try {
      revokeSessionToken(decodeURIComponent(match[1].trim()));
    } catch {}
  }
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
  const cfg = getConfig();
  // Sanitize sensitive credentials to prevent credential exposure in browser DevTools
  const safeConfig = {
    ...cfg,
    password: '',
    hasPassword: Boolean(cfg.password),
    hasTotp: Boolean(cfg.totp_secret)
  };
  res.json({
    config: safeConfig,
    rawYaml: getRawConfigYaml()
  });
});

app.put('/api/platform/config', requireAdmin, (req, res) => {
  try {
    const oldCfg = getConfig();
    const oldAdminPath = oldCfg.admin_path;
    const { mode, rawYaml, patch } = req.body || {};

    let updatedCfg;
    if (mode === 'raw') {
      updatedCfg = saveRawConfigYaml(rawYaml);
    } else {
      const cleanPatch = { ...(patch || {}) };
      // If password field is empty/unset, preserve existing password
      if (!cleanPatch.password) {
        delete cleanPatch.password;
      } else if (!cleanPatch.password.startsWith('scrypt:')) {
        cleanPatch.password = hashPassword(cleanPatch.password);
      }
      updatedCfg = updateConfigPreservingComments(cleanPatch);
    }

    // Re-issue session cookie so password or admin path change doesn't break current session
    const newToken = createSessionToken(updatedCfg);
    res.setHeader(
      'Set-Cookie',
      createSessionCookie(req, newToken, `; Max-Age=${30 * 24 * 60 * 60}`)
    );

    const safeConfig = {
      ...updatedCfg,
      password: '',
      hasPassword: Boolean(updatedCfg.password),
      hasTotp: Boolean(updatedCfg.totp_secret)
    };

    appendAuditLog({
      action: 'config_update',
      ip: getClientIp(req),
      mode,
      adminPathChanged: oldAdminPath !== updatedCfg.admin_path
    });

    res.json({
      success: true,
      config: safeConfig,
      rawYaml: getRawConfigYaml(),
      adminPathChanged: oldAdminPath !== updatedCfg.admin_path,
      newAdminPath: updatedCfg.admin_path
    });
  } catch (err) {
    res.status(400).json({ error: 'Failed to save configuration: ' + err.message });
  }
});

// ================= 1.5 Upstream Repository & Hot Update APIs =================
app.get('/api/platform/update/status', requireAdmin, async (req, res) => {
  try {
    const fetchRemote = req.query.fetch === '1' || req.query.fetch === 'true';
    const status = await getUpdateStatus({ fetchRemote });
    res.json(status);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/platform/update/pull', requireAdmin, async (req, res) => {
  try {
    const cfg = getConfig();
    if (cfg.hot_update === false) {
      return res.status(403).json({
        error: 'Hot update feature is explicitly disabled (hot_update: false) in config.yaml.'
      });
    }

    const { upstream_mirror, upstream_branch } = req.body || {};
    const patch = {};
    if (typeof upstream_mirror === 'string') {
      if (!validateGitMirror(upstream_mirror)) {
        return res.status(400).json({ error: 'Invalid mirror URL format' });
      }
      patch.upstream_mirror = upstream_mirror.trim();
    }
    if (typeof upstream_branch === 'string' && upstream_branch.trim()) {
      patch.upstream_branch = upstream_branch.trim();
    }
    if (Object.keys(patch).length > 0) {
      updateConfigPreservingComments(patch);
    }

    appendAuditLog({
      action: 'hot_update_pull',
      ip: getClientIp(req),
      upstream_mirror: patch.upstream_mirror ?? cfg.upstream_mirror ?? '',
      upstream_branch: patch.upstream_branch || cfg.upstream_branch || 'main'
    });

    const result = await performHotUpdate({
      upstream_mirror: patch.upstream_mirror,
      upstream_branch: patch.upstream_branch
    });
    res.on('finish', () => {
      setTimeout(() => {
        restartServerProcess(httpServer, __filename);
      }, 350);
    });
    res.json({
      ...result,
      restarting: true
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/platform/restart', requireAdmin, (req, res) => {
  res.on('finish', () => {
    setTimeout(() => {
      restartServerProcess(httpServer, __filename);
    }, 300);
  });
  res.json({ success: true, restarting: true });
});

// ================= 1.6 Backup & Archive Export API =================
app.get('/api/platform/backup/download', requireAdmin, (req, res) => {
  const scope = req.query.scope === 'full' ? 'full' : 'config';
  const dateStr = new Date().toISOString().slice(0, 10);
  const archiveName = `filemaster-backup-${scope}-${dateStr}.tar.gz`;
  fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
  const tmpArchivePath = path.join(UPLOAD_TMP_DIR, `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.tar.gz`);

  const targets = [];
  for (const candidate of ['config.yaml', 'config.example.yaml', 'watermark.png', 'data']) {
    if (fs.existsSync(path.join(ROOT_DIR, candidate))) {
      targets.push(candidate);
    }
  }
  if (scope === 'full' && fs.existsSync(path.join(ROOT_DIR, 'storage', 'raw'))) {
    targets.push('storage/raw');
  }

  if (targets.length === 0) {
    return res.status(400).json({ error: 'No backup targets found on disk' });
  }

  execFile('tar', ['-czf', tmpArchivePath, '-C', ROOT_DIR, ...targets], { timeout: 120000 }, (err) => {
    if (err || !fs.existsSync(tmpArchivePath)) {
      if (fs.existsSync(tmpArchivePath)) {
        try { fs.unlinkSync(tmpArchivePath); } catch {}
      }
      return res.status(500).json({ error: 'Failed to create tar.gz archive: ' + (err ? err.message : 'unknown error') });
    }

    appendAuditLog({
      action: 'backup_export',
      ip: getClientIp(req),
      scope
    });

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);
    const stream = fs.createReadStream(tmpArchivePath);
    stream.on('close', () => {
      try { if (fs.existsSync(tmpArchivePath)) fs.unlinkSync(tmpArchivePath); } catch {}
    });
    stream.pipe(res);
  });
});

// ================= 2. Mount Platform Modules =================
// Module 1: Image Host & Asset Manager
registerImageHostModule(app);
// Module 2: Lightweight Secure File Sharing with Expiring Links (/s/:shareId)
registerShareModule(app);

// Additional modules can be mounted here

// ================= 3. Setup Wizard & Admin Console Routing =================
app.use('/assets', express.static(path.join(__dirname, 'public/assets'), { maxAge: '1h' }));

app.get('/setup', (req, res) => {
  if (!isConfigInitialized()) {
    return res.sendFile(path.join(__dirname, 'public/setup.html'));
  }
  const cfg = getConfig();
  return res.redirect(`/${cfg.admin_path}`);
});

app.get('/', (req, res) => {
  if (!isConfigInitialized()) {
    return res.redirect('/setup');
  }
  const cfg = getConfig();
  return res.redirect(`/${cfg.admin_path}`);
});

app.get('/:customAdminPath', (req, res, next) => {
  if (!isConfigInitialized()) {
    return res.redirect('/setup');
  }
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

// Unmapped routes return 404
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// ================= 4. Server Initialization =================
const initialCfg = getConfig();
const PORT = process.env.PORT || initialCfg.port || 3000;

function startServer(port, retriesLeft = 6) {
  const srv = app.listen(port, () => {
    httpServer = srv;
    const cfg = getConfig();
    if (!isConfigInitialized()) {
      console.log('---------------------------------------------------------');
      console.log(`✨ [Setup Wizard] No config.yaml found! Visit http://localhost:${port}/setup to initialize.`);
      console.log(process.env.FILEMASTER_SETUP_TOKEN
        ? '[Setup Wizard] Use FILEMASTER_SETUP_TOKEN from the server environment to initialize.'
        : `[Setup Wizard] Initialization token for this server start: ${SETUP_TOKEN}`);
      console.log('---------------------------------------------------------');
    } else {
      console.log(`🚀 ${cfg.site_name} is running!`);
      console.log(`🔒 Admin Console: ${cfg.base_url}/${cfg.admin_path}`);
      console.log(`🖼️ Raw Original Route: ${cfg.base_url}/${cfg.image_host.raw_secret_path}/YYYY/MM/filename.ext`);
      if (cfg.image_host.enable_optimization !== false) {
        console.log(`⚡ Optimized WebP Route: ${cfg.base_url}/${cfg.image_host.pub_secret_path || 'pub'}/YYYY/MM/filename.webp`);
      }
    }
  });

  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && retriesLeft > 0) {
      console.warn(`[Server] Port ${port} busy during restart handoff, retrying in 350ms (${retriesLeft} left)...`);
      setTimeout(() => startServer(port, retriesLeft - 1), 350);
    } else {
      console.error(`[Server] Failed to bind port ${port}:`, err.message);
      process.exit(1);
    }
  });
}

startServer(PORT);
