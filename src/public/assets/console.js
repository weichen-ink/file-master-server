let allImages = [];
let currentModalItem = null;
let selectedFolder = 'all';
let isOptimizationEnabled = true;
const collapsedYears = new Set();
const GALLERY_PAGE_SIZE = 60;
let galleryPage = 0;
let galleryFilterKey = '';
let uploadController = null;
let failedUploads = [];
let integrityReport = null;
let integrityPoll = null;

function changeGalleryPage(delta) {
  galleryPage = Math.max(0, galleryPage + delta);
  renderGallery();
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function fetchWithRetry(url, options = {}) {
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    let response;
    try {
      response = await fetch(url, options);
      if (attempt >= 4 || ![429, 500, 502, 503, 504].includes(response.status)) return response;
    } catch (err) {
      if (options.signal?.aborted || attempt >= 4) throw err;
    }
    const retryAfter = response?.headers.get('Retry-After');
    const delay = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000
      : retryAfter && Number.isFinite(Date.parse(retryAfter)) ? Math.max(0, Date.parse(retryAfter) - Date.now())
      : 1000 * (2 ** attempt) + Math.random() * 250;
    await waitForRetry(Math.min(120000, Math.max(250, delay)), options.signal);
  }
}

function showToast(msg) {
  const tEl = document.getElementById('toast');
  tEl.textContent = msg;
  tEl.classList.remove('hidden');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => tEl.classList.add('hidden'), 2400);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(i > 1 ? 2 : 1) + ' ' + sizes[i];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function jsArg(value) {
  return escapeHtml(JSON.stringify(String(value)));
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`✅ ${t('copied', { label })}`);
  } catch {
    prompt(t('copyManually'), text);
  }
}

async function toggleSecretField(id, button) {
  const input = document.getElementById(id);
  const showing = input.type === 'password';
  if (showing && !input.value) {
    try {
      const res = await fetch('/api/platform/config?reveal=1');
      if (res.ok) {
        const { config } = await res.json();
        if (id === 'f_api_token' && config.api_token) input.value = config.api_token;
        if (id === 'f_totp_secret' && config.totp_secret) input.value = config.totp_secret;
      }
    } catch {}
  }
  input.type = showing ? 'text' : 'password';
  button.dataset.i18n = showing ? 'btnHideSecret' : 'btnShowSecret';
  button.textContent = t(button.dataset.i18n);
}

async function toggleHeadersVisibility() {
  const value = document.getElementById('epHeadersJson');
  const button = document.getElementById('btnRevealHeaders');
  const showing = value.dataset.revealed !== 'true';
  if (showing && !value.dataset.value) {
    try {
      const res = await fetch('/api/platform/metrics?reveal=1');
      if (res.ok) {
        const m = await res.json();
        if (m?.site?.endpoints?.piclistHeaders) {
          value.dataset.value = m.site.endpoints.piclistHeaders;
        }
      }
    } catch {}
  }
  value.dataset.revealed = String(showing);
  value.textContent = showing ? (value.dataset.value || '-') : '••••••••';
  button.dataset.i18n = showing ? 'btnHideSecret' : 'btnShowSecret';
  button.textContent = t(button.dataset.i18n);
}

function maskSecrets() {
  for (const id of ['f_api_token', 'f_totp_secret']) {
    const input = document.getElementById(id);
    input.type = 'password';
    const button = input.parentElement.querySelector('button');
    button.dataset.i18n = 'btnShowSecret';
    button.textContent = t('btnShowSecret');
  }
  const headers = document.getElementById('epHeadersJson');
  headers.dataset.revealed = 'false';
  headers.textContent = '••••••••';
  const button = document.getElementById('btnRevealHeaders');
  button.dataset.i18n = 'btnShowSecret';
  button.textContent = t('btnShowSecret');
}

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const parts = [];
  if (d > 0) parts.push(t('durationDays', { count: d }));
  if (h > 0 || d > 0) parts.push(t('durationHours', { count: h }));
  if (m > 0 || h > 0 || d > 0) parts.push(t('durationMinutes', { count: m }));
  parts.push(t('durationSeconds', { count: r }));
  return parts.join(' ');
}

function getBarColor(pct) {
  if (pct >= 85) return 'var(--danger)';
  if (pct >= 70) return 'var(--warn)';
  return 'var(--primary)';
}

async function loadServerMetrics(manual = false) {
  const res = await fetch('/api/platform/metrics');
  if (!res.ok) return;
  const m = await res.json();
  const { host, site } = m;

  // 1. Dashboard summary cards
  document.getElementById('mCpuLoad').textContent = `${host.cpu.loadPercent1m}%`;
  const cpuBar = document.getElementById('mCpuBar');
  cpuBar.style.width = `${Math.min(100, host.cpu.loadPercent1m)}%`;
  cpuBar.style.background = getBarColor(host.cpu.loadPercent1m);
  document.getElementById('mCpuDetail').textContent = t('metricCpuDetail', { cores: host.cpu.cores, load: host.cpu.loadAvg[0] });

  document.getElementById('mRamUsage').textContent = `${host.memory.usagePercent}%`;
  const ramBar = document.getElementById('mRamBar');
  ramBar.style.width = `${Math.min(100, host.memory.usagePercent)}%`;
  ramBar.style.background = getBarColor(host.memory.usagePercent);
  document.getElementById('mRamDetail').textContent = t('metricUsedTotal', { used: formatBytes(host.memory.used), total: formatBytes(host.memory.total) });

  document.getElementById('mDiskUsage').textContent = `${host.disk.usagePercent}%`;
  const diskBar = document.getElementById('mDiskBar');
  diskBar.style.width = `${Math.min(100, host.disk.usagePercent)}%`;
  diskBar.style.background = getBarColor(host.disk.usagePercent);
  document.getElementById('mDiskDetail').textContent = t('metricAvailableTotal', { available: formatBytes(host.disk.free), total: formatBytes(host.disk.total) });

  // 2. Host specs
  document.getElementById('mHostName').textContent = host.hostname;
  document.getElementById('mOsPlatform').textContent = host.platform;
  document.getElementById('mCpuModel').textContent = host.cpu.model;
  document.getElementById('mCpuCores').textContent = t('metricCores', { count: host.cpu.cores });
  document.getElementById('mLoadAvg').textContent = host.cpu.loadAvg.join(' / ');
  document.getElementById('mMemSummary').textContent = t('metricTotalFree', { total: formatBytes(host.memory.total), free: formatBytes(host.memory.free) });
  document.getElementById('mDiskSummary').textContent = t('metricTotalFree', { total: formatBytes(host.disk.total), free: formatBytes(host.disk.free) });
  document.getElementById('mHostUptime').textContent = formatDuration(host.uptimeSec);

  // 3. Node process specs
  document.getElementById('mSitePort').textContent = `${site.port} (${site.baseUrl})`;
  document.getElementById('mSiteUptime').textContent = formatDuration(site.uptimeSec);
  document.getElementById('mSiteStartTime').textContent = new Date(site.startedAt).toLocaleString(currentLocale === 'zh' ? 'zh-CN' : 'en-US');
  document.getElementById('mNodePid').textContent = `${site.nodeVersion} (PID: ${site.pid})`;
  document.getElementById('mProcMem').textContent = `RSS ${formatBytes(site.processMemory.rss)} / Heap ${formatBytes(site.processMemory.heapUsed)}`;
  document.getElementById('mSiteRawBytes').textContent = t('metricRawFiles', { size: formatBytes(site.storage.rawBytes), count: site.storage.imageCount });
  document.getElementById('mSiteCacheBytes').textContent = formatBytes(site.storage.cacheBytes);
  document.getElementById('mSiteSec').textContent = t('metricSecurity', { count: site.security.activeBans, status: t(site.security.totpEnabled ? 'statusOn' : 'statusOff') });

  // 4. PicList endpoints
  if (site.endpoints) {
    document.getElementById('epPort').textContent = site.endpoints.port;
    document.getElementById('epLocalUrl').textContent = site.endpoints.localUploadUrl;
    document.getElementById('epUploadUrl').textContent = site.endpoints.uploadUrl;
    const headersEl = document.getElementById('epHeadersJson');
    headersEl.dataset.value = site.endpoints.piclistHeaders;
    headersEl.textContent = headersEl.dataset.revealed === 'true' ? site.endpoints.piclistHeaders : '••••••••';
    document.getElementById('epRawPattern').textContent = site.endpoints.rawUrlPattern;
    document.getElementById('epPubPattern').textContent = site.endpoints.pubUrlPattern;
  }

  if (manual) showToast('✅ ' + t('metricsRefreshed'));
}

function toggleMetricsTimer() {
  clearInterval(window.__metricsTimer);
  const isStatusVisible = !document.getElementById('tab-status').classList.contains('hidden');
  const autoOn = document.getElementById('autoRefreshMetrics')?.checked;
  if (isStatusVisible && autoOn) {
    window.__metricsTimer = setInterval(() => loadServerMetrics(false), 5000);
  }
}

function setMobileNav(open) {
  const layout = document.getElementById('appView');
  const menuButton = document.getElementById('mobileMenuButton');
  layout.classList.toggle('nav-open', open);
  menuButton.setAttribute('aria-expanded', String(open));
  if (!open && document.activeElement?.closest('.sidebar')) menuButton.focus();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.getElementById('appView').classList.contains('nav-open')) {
    setMobileNav(false);
  }
});

function switchTab(tabId, btnEl) {
  maskSecrets();
  document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
  const target = document.getElementById('tab-' + tabId);
  if (target) target.classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  setMobileNav(false);
  if (tabId === 'status') {
    loadServerMetrics(false);
  } else if (tabId === 'settings' || tabId === 'media' || tabId === 'integration' || tabId === 'security' || tabId === 'maintenance' || tabId === 'platform') {
    loadConfigForEdit();
    if (tabId === 'settings' || tabId === 'integration') loadServerMetrics(false);
  } else if (tabId === 'future-files') {
    loadShares();
  }
  toggleMetricsTimer();
}

function switchSettingsSubtab(subtabId, btnEl) {
  maskSecrets();
  document.querySelectorAll('.subtab-settings-content').forEach(s => s.classList.add('hidden'));
  const target = document.getElementById('subtab-settings-' + subtabId);
  if (target) target.classList.remove('hidden');
  document.querySelectorAll('#settingsTabPills .tab-pill').forEach(b => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
}

async function initApp() {
  applyLocaleToStaticDom();
  try {
    const res = await fetch('/api/platform/status');
    if (res && res.ok === false) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.needsSetup) {
      window.location.href = '/setup';
      return;
    }
    isOptimizationEnabled = data.optimizationEnabled !== false;
    document.title = (data.siteName || 'File Master') + ' - Console';
    const loginSite = document.getElementById('loginSiteName');
    if (loginSite) loginSite.textContent = data.siteName || 'File Master Server';
    const navSite = document.getElementById('navSiteName');
    if (navSite) navSite.textContent = data.siteName || 'File Master Server';
    const mobileSite = document.getElementById('mobileSiteName');
    if (mobileSite) mobileSite.textContent = data.siteName || 'File Master Server';

    const totpGroup = document.getElementById('totpGroup');
    if (totpGroup) {
      totpGroup.classList.toggle('hidden', !data.totpEnabled);
    }

    const storageWarning = document.getElementById('storageWarning');
    if (storageWarning) {
      storageWarning.classList.toggle('hidden', data.storageHealth?.atomicUploads === true);
    }

    const loginView = document.getElementById('loginView');
    const appView = document.getElementById('appView');

    if (data.authenticated) {
      if (loginView) loginView.classList.add('hidden');
      if (appView) appView.classList.remove('hidden');
      loadImages();
      loadShares();
    } else {
      if (loginView) loginView.classList.remove('hidden');
      if (appView) appView.classList.add('hidden');
      const savedUser = localStorage.getItem('filemaster_saved_username');
      const savedRem = localStorage.getItem('filemaster_remember_pref');
      const remEl = document.getElementById('rememberAccount');
      if (savedRem !== null && remEl) {
        remEl.checked = savedRem === '1';
      }
      const userEl = document.getElementById('loginUsername');
      const passEl = document.getElementById('loginPassword');
      if (savedUser && userEl) {
        userEl.value = savedUser;
        if (passEl) passEl.focus();
      } else if (userEl) {
        userEl.focus();
      }
    }
  } catch (err) {
    console.error('[InitApp] Initialization failed:', err);
    // Unhide login view as fallback so user is never left with an empty white screen
    const loginView = document.getElementById('loginView');
    if (loginView) loginView.classList.remove('hidden');
    const errBox = document.getElementById('loginError');
    if (errBox) {
      errBox.textContent = '无法连接服务，请检查后端运行状态或稍后刷新重试。';
      errBox.classList.remove('hidden');
    }
  }
}

function setCfgEditMode(mode) {
  const formPanel = document.getElementById('cfgFormPanel');
  const rawPanel = document.getElementById('cfgRawPanel');
  const btnForm = document.getElementById('btnCfgFormMode');
  const btnRaw = document.getElementById('btnCfgRawMode');

  if (mode === 'raw') {
    formPanel.classList.add('hidden');
    rawPanel.classList.remove('hidden');
    btnForm.className = 'btn btn-outline';
    btnRaw.className = 'btn btn-primary';
  } else {
    rawPanel.classList.add('hidden');
    formPanel.classList.remove('hidden');
    btnForm.className = 'btn btn-primary';
    btnRaw.className = 'btn btn-outline';
  }
}

async function loadConfigForEdit() {
  const res = await fetch('/api/platform/config');
  if (!res.ok) return;
  const { config, rawYaml } = await res.json();
  fillConfigForm(config, rawYaml);
  loadLocalUpdateStatus();
}

function toggleConsoleOptFields() {
  const optEnabled = document.getElementById('f_enable_optimization')?.value === 'true';
  const optWebpSec = document.getElementById('optWebpSection');
  if (optWebpSec) {
    optWebpSec.style.opacity = optEnabled ? '1' : '0.45';
    optWebpSec.style.pointerEvents = optEnabled ? 'auto' : 'none';
  }

  const wmEnabled = document.getElementById('f_watermark_enable')?.value === 'true';
  const wmSec = document.getElementById('wmConfigSection');
  if (wmSec) {
    wmSec.style.opacity = wmEnabled ? '1' : '0.45';
    wmSec.style.pointerEvents = wmEnabled ? 'auto' : 'none';
  }

  const wmType = document.getElementById('f_watermark_type')?.value || 'image';
  const gImage = document.getElementById('wmGroupImage');
  const gText = document.getElementById('wmGroupText');

  if (gImage) gImage.classList.toggle('hidden', wmType !== 'image');
  if (gText) gText.classList.toggle('hidden', wmType === 'image');

  const gPos = document.getElementById('groupWmPos');
  const gScale = document.getElementById('groupWmScale');
  const gMargin = document.getElementById('groupWmMargin');
  if (gPos) gPos.style.display = wmType === 'tile' ? 'none' : '';
  if (gScale) gScale.style.display = wmType === 'tile' ? 'none' : '';
  if (gMargin) gMargin.style.display = wmType === 'tile' ? 'none' : '';

  const isAutoContrast = document.getElementById('f_watermark_auto_contrast')?.value === 'true';
  const secSingle = document.getElementById('wmSingleImageSection');
  const secDual = document.getElementById('wmDualImageSection');
  if (secSingle) secSingle.classList.toggle('hidden', isAutoContrast);
  if (secDual) secDual.classList.toggle('hidden', !isAutoContrast);

  const secTextSingle = document.getElementById('wmTextSingleColorSection');
  const secTextDual = document.getElementById('wmTextDualColorSection');
  if (secTextSingle) secTextSingle.classList.toggle('hidden', isAutoContrast);
  if (secTextDual) secTextDual.classList.toggle('hidden', !isAutoContrast);
}

function toggleMirrorPresetSelect() {
  const isEnabled = document.getElementById('f_enable_mirror')?.value === 'true';
  const group = document.getElementById('group_mirror_preset');
  const sel = document.getElementById('f_upstream_mirror_preset');
  if (sel) sel.disabled = !isEnabled;
  if (group) {
    group.style.opacity = isEnabled ? '1' : '0.45';
    group.style.pointerEvents = isEnabled ? 'auto' : 'none';
  }
}

function getSelectedUpstreamMirror() {
  const isEnabled = document.getElementById('f_enable_mirror')?.value === 'true';
  if (!isEnabled) return '';
  return (document.getElementById('f_upstream_mirror_preset')?.value || '').trim();
}

function fillConfigForm(cfg, rawYaml) {
  maskSecrets();
  document.getElementById('rawYamlEditor').value = rawYaml || '';
  document.getElementById('f_site_name').value = cfg.site_name || '';
  document.getElementById('f_base_url').value = cfg.base_url || '';
  document.getElementById('f_port').value = cfg.port || 3210;
  
  const mirror = (cfg.upstream_mirror || '').trim();
  const enableMirrorEl = document.getElementById('f_enable_mirror');
  const mirrorPresetEl = document.getElementById('f_upstream_mirror_preset');
  if (enableMirrorEl && mirrorPresetEl) {
    if (mirror) {
      enableMirrorEl.value = 'true';
      let matched = false;
      for (const opt of mirrorPresetEl.options) {
        if (opt.value === mirror || mirror.includes(opt.value.replace(/^https?:\/\//, '').replace(/\/+$/, ''))) {
          mirrorPresetEl.value = opt.value;
          matched = true;
          break;
        }
      }
      if (!matched) {
        mirrorPresetEl.value = mirrorPresetEl.options[0]?.value || 'https://ghproxy.net/';
      }
    } else {
      enableMirrorEl.value = 'false';
    }
    toggleMirrorPresetSelect();
  }

  document.getElementById('f_admin_path').value = cfg.admin_path || '';
  document.getElementById('f_max_login_attempts').value = cfg.max_login_attempts || 3;
  document.getElementById('f_username').value = cfg.username || '';
  document.getElementById('f_password').value = cfg.password || '';
  document.getElementById('f_api_token').value = cfg.api_token || '';
  document.getElementById('f_totp_secret').value = cfg.totp_secret || '';

  const img = cfg.image_host || {};
  document.getElementById('f_raw_secret_path').value = img.raw_secret_path || 'raw';
  document.getElementById('f_pub_secret_path').value = img.pub_secret_path || 'pub';
  document.getElementById('f_enable_optimization').value = String(img.enable_optimization !== false);
  document.getElementById('f_webp_quality').value = img.webp_quality ?? 82;
  document.getElementById('f_max_width').value = img.max_width ?? 1920;
  document.getElementById('f_watermark_enable').value = String(Boolean(img.watermark_enable));
  document.getElementById('f_watermark_type').value = img.watermark_type || 'image';
  document.getElementById('f_watermark_pos').value = img.watermark_pos || 'bottom-right';
  document.getElementById('f_watermark_opacity').value = img.watermark_opacity ?? 0.65;
  document.getElementById('f_watermark_scale').value = img.watermark_scale ?? 0.16;
  document.getElementById('f_watermark_margin').value = img.watermark_margin ?? 24;
  document.getElementById('f_watermark_min_width').value = img.watermark_min_width ?? 320;
  const wmImg = img.watermark_image || './wm-light.png';
  document.getElementById('f_watermark_image').value = wmImg;
  const dualLightEl = document.getElementById('f_watermark_image_dual');
  if (dualLightEl) dualLightEl.value = wmImg;
  if (document.getElementById('f_watermark_image_dark')) {
    document.getElementById('f_watermark_image_dark').value = img.watermark_image_dark || './wm-dark.png';
  }
  const isAutoContrast = img.watermark_auto_contrast !== false;
  if (document.getElementById('f_watermark_auto_contrast')) {
    document.getElementById('f_watermark_auto_contrast').value = String(isAutoContrast);
  }
  if (document.getElementById('f_watermark_text_contrast')) {
    document.getElementById('f_watermark_text_contrast').value = String(isAutoContrast);
  }
  if (document.getElementById('f_watermark_font')) {
    document.getElementById('f_watermark_font').value = img.watermark_font || 'system';
  }
  document.getElementById('f_watermark_text').value = img.watermark_text || '';
  const wmColor = img.watermark_color || '#ffffff';
  document.getElementById('f_watermark_color').value = wmColor;
  if (document.getElementById('f_watermark_color_dual')) {
    document.getElementById('f_watermark_color_dual').value = wmColor;
  }
  if (document.getElementById('f_watermark_color_dark')) {
    document.getElementById('f_watermark_color_dark').value = img.watermark_color_dark || '#111827';
  }
  toggleConsoleOptFields();
}

async function saveConfigForm() {
  const patch = {
    site_name: document.getElementById('f_site_name').value.trim(),
    base_url: document.getElementById('f_base_url').value.trim().replace(/\/+$/, ''),
    port: Number(document.getElementById('f_port').value) || 3210,
    upstream_mirror: getSelectedUpstreamMirror(),
    upstream_branch: 'main',
    admin_path: document.getElementById('f_admin_path').value.trim().replace(/^\/+|\/+$/g, ''),
    max_login_attempts: Number(document.getElementById('f_max_login_attempts').value) || 3,
    username: document.getElementById('f_username').value.trim(),
    password: document.getElementById('f_password').value,
    api_token: document.getElementById('f_api_token').value.trim(),
    totp_secret: document.getElementById('f_totp_secret').value.trim(),
    image_host: {
      raw_secret_path: document.getElementById('f_raw_secret_path').value.trim().replace(/^\/+|\/+$/g, '') || 'raw',
      pub_secret_path: document.getElementById('f_pub_secret_path').value.trim().replace(/^\/+|\/+$/g, '') || 'pub',
      enable_optimization: document.getElementById('f_enable_optimization').value === 'true',
      webp_quality: Number(document.getElementById('f_webp_quality').value) || 82,
      max_width: Number(document.getElementById('f_max_width').value) || 0,
      watermark_enable: document.getElementById('f_watermark_enable').value === 'true',
      watermark_type: document.getElementById('f_watermark_type').value,
      watermark_pos: document.getElementById('f_watermark_pos').value,
      watermark_opacity: Number(document.getElementById('f_watermark_opacity').value) || 0.65,
      watermark_scale: Number(document.getElementById('f_watermark_scale').value) || 0.16,
      watermark_margin: Number(document.getElementById('f_watermark_margin').value) || 24,
      watermark_min_width: Number(document.getElementById('f_watermark_min_width').value) || 320,
      watermark_image: (
        (document.getElementById('f_watermark_auto_contrast')?.value === 'true'
          ? (document.getElementById('f_watermark_image_dual')?.value || document.getElementById('f_watermark_image')?.value)
          : document.getElementById('f_watermark_image')?.value)
        || './wm-light.png'
      ).trim(),
      watermark_image_dark: (document.getElementById('f_watermark_image_dark')?.value || './wm-dark.png').trim(),
      watermark_auto_contrast: document.getElementById('f_watermark_auto_contrast')?.value === 'true',
      watermark_font: document.getElementById('f_watermark_font')?.value || 'system',
      watermark_text: document.getElementById('f_watermark_text')?.value || '',
      watermark_color: (
        (document.getElementById('f_watermark_auto_contrast')?.value === 'true'
          ? (document.getElementById('f_watermark_color_dual')?.value || document.getElementById('f_watermark_color')?.value)
          : document.getElementById('f_watermark_color')?.value)
        || '#ffffff'
      ).trim(),
      watermark_color_dark: (document.getElementById('f_watermark_color_dark')?.value || '#111827').trim()
    }
  };

  const res = await fetch('/api/platform/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'form', patch })
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || t('errorSaveConfig'));
    return;
  }

  if (document.getElementById('f_auto_clear_cache').checked) {
    await fetch('/api/modules/image-host/cache/clear', { method: 'POST' });
  }

  fillConfigForm(data.config, data.rawYaml);
  document.getElementById('navSiteName').textContent = data.config.site_name;
  document.getElementById('mobileSiteName').textContent = data.config.site_name;
  showToast('✅ ' + t('configSaved'));

  if (data.adminPathChanged) {
    setTimeout(() => {
      window.location.href = '/' + data.newAdminPath;
    }, 800);
  } else {
    loadImages();
  }
}

async function saveConfigRaw() {
  const rawYaml = document.getElementById('rawYamlEditor').value;
  const res = await fetch('/api/platform/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'raw', rawYaml })
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || t('errorSaveYaml'));
    return;
  }
  fillConfigForm(data.config, data.rawYaml);
  document.getElementById('navSiteName').textContent = data.config.site_name;
  document.getElementById('mobileSiteName').textContent = data.config.site_name;
  showToast('✅ ' + t('rawSaved'));
  if (data.adminPathChanged) {
    setTimeout(() => {
      window.location.href = '/' + data.newAdminPath;
    }, 800);
  } else {
    loadImages();
  }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = document.getElementById('loginError');
  errBox.classList.add('hidden');

  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const totpCode = document.getElementById('loginTotp').value.trim();
  const rememberMe = document.getElementById('rememberAccount').checked;

  const res = await fetch('/api/platform/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, totpCode, rememberMe })
  });
  const data = await res.json();
  if (!res.ok) {
    errBox.textContent = data.error || t('errorLogin');
    errBox.classList.remove('hidden');
    return;
  }

  if (rememberMe) {
    localStorage.setItem('filemaster_saved_username', username);
    localStorage.setItem('filemaster_remember_pref', '1');
  } else {
    localStorage.removeItem('filemaster_saved_username');
    localStorage.setItem('filemaster_remember_pref', '0');
  }
  initApp();
});

async function logout() {
  await fetch('/api/platform/logout', { method: 'POST' });
  location.reload();
}

async function loadImages() {
  const res = await fetch('/api/modules/image-host/list');
  if (!res.ok) return;
  const data = await res.json();
  allImages = data.images || [];
  isOptimizationEnabled = data.optimizationEnabled !== false;

  document.getElementById('navImgCount').textContent = data.stats.totalCount;
  document.getElementById('statCount').textContent = data.stats.totalCount;
  document.getElementById('statRawSize').textContent = formatBytes(data.stats.totalRawBytes);
  document.getElementById('statCacheSize').textContent = isOptimizationEnabled
    ? formatBytes(data.stats.totalCacheBytes)
    : 'Off';

  const btnCache = document.getElementById('btnRebuildCache');
  if (btnCache) btnCache.style.display = isOptimizationEnabled ? '' : 'none';
  const hintEl = document.getElementById('statCacheHint');
  if (hintEl) {
    hintEl.textContent = isOptimizationEnabled
      ? t('statCacheOptimizedHint')
      : t('statCacheDisabledHint');
  }

  renderFolderTree();
  renderGallery();
}

function selectFolder(folderKey) {
  selectedFolder = folderKey;
  renderFolderTree();
  renderGallery();
  if (window.matchMedia('(max-width: 600px)').matches) toggleFolderPanel(false);
}

function toggleFolderPanel(force) {
  const panel = document.querySelector('.folder-panel');
  const button = document.getElementById('folderToggleBtn');
  const open = force ?? !panel.classList.contains('is-open');
  panel.classList.toggle('is-open', open);
  button.setAttribute('aria-expanded', String(open));
  button.dataset.i18nAriaLabel = open ? 'folderCollapse' : 'folderExpand';
  button.dataset.i18nTitle = button.dataset.i18nAriaLabel;
  button.setAttribute('aria-label', t(button.dataset.i18nAriaLabel));
  button.title = t(button.dataset.i18nTitle);
}

function toggleYearCollapse(year, ev) {
  ev.stopPropagation();
  if (collapsedYears.has(year)) {
    collapsedYears.delete(year);
  } else {
    collapsedYears.add(year);
  }
  renderFolderTree();
}

function renderFolderTree() {
  const treeEl = document.getElementById('folderTreeList');
  const yearMap = new Map();
  for (const img of allImages) {
    if (!yearMap.has(img.year)) {
      yearMap.set(img.year, { count: 0, bytes: 0, months: new Map() });
    }
    const yObj = yearMap.get(img.year);
    yObj.count += 1;
    yObj.bytes += img.size || 0;

    if (!yObj.months.has(img.month)) {
      yObj.months.set(img.month, { count: 0, bytes: 0 });
    }
    const mObj = yObj.months.get(img.month);
    mObj.count += 1;
    mObj.bytes += img.size || 0;
  }

  if (selectedFolder !== 'all') {
    const [selY, selM] = selectedFolder.split('/');
    if (!yearMap.has(selY) || (selM && !yearMap.get(selY).months.has(selM))) {
      selectedFolder = 'all';
    }
  }

  let totalFolders = 0;
  yearMap.forEach((v) => { totalFolders += v.months.size; });
  document.getElementById('folderCountHint').textContent = t('folderCountHint', { count: totalFolders });

  let html = `
    <button class="folder-btn ${selectedFolder === 'all' ? 'active' : ''}" onclick="selectFolder('all')">
      <span>🗂️ ${t('allAssets')}</span>
      <span class="folder-count">${allImages.length}</span>
    </button>
  `;

  const sortedYears = [...yearMap.keys()].sort((a, b) => b.localeCompare(a));
  for (const year of sortedYears) {
    const yData = yearMap.get(year);
    const isCollapsed = collapsedYears.has(year);
    const isYearActive = selectedFolder === year;
    const arrow = isCollapsed ? '▸' : '▾';
    const yearLabel = `📂 ${year}`;

    html += `
      <button class="folder-btn ${isYearActive ? 'active' : ''}" onclick="selectFolder('${year}')">
        <span style="display:flex; align-items:center; gap:6px;">
          <span onclick="toggleYearCollapse('${year}', event)" style="display:inline-block; width:14px; text-align:center; color:var(--muted);">${arrow}</span>
          <span>${yearLabel}</span>
        </span>
        <span class="folder-count">${yData.count}</span>
      </button>
    `;

    if (!isCollapsed) {
      const sortedMonths = [...yData.months.keys()].sort().reverse();
      for (const month of sortedMonths) {
        const mData = yData.months.get(month);
        const folderKey = `${year}/${month}`;
        const isMonthActive = selectedFolder === folderKey;
        const monthLabel = `📁 ${month} <span style="font-size:11px; color:var(--muted);">(${year}/${month})</span>`;
        html += `
          <button class="folder-btn month-node ${isMonthActive ? 'active' : ''}" onclick="selectFolder('${folderKey}')" title="${formatBytes(mData.bytes)}">
            <span>${monthLabel}</span>
            <span class="folder-count">${mData.count}</span>
          </button>
        `;
      }
    }
  }

  treeEl.innerHTML = html;
}

let currentSortField = 'time';
let currentSortOrder = 'desc';

function toggleSortField(field) {
  if (currentSortField === field) {
    currentSortOrder = (currentSortOrder === 'desc') ? 'asc' : 'desc';
  } else {
    currentSortField = field;
    currentSortOrder = (field === 'name') ? 'asc' : 'desc';
  }
  updateSortUI();
  galleryPage = 0;
  renderGallery();
}

function updateSortUI() {
  const fields = ['time', 'size', 'name', 'hits'];
  for (const f of fields) {
    const btn = document.querySelector(`.sort-tab[data-sort="${f}"]`);
    const arrow = document.getElementById(`sortArrow_${f}`);
    if (!btn || !arrow) continue;
    if (f === currentSortField) {
      btn.classList.add('active');
      arrow.textContent = currentSortOrder === 'asc' ? '↑' : '↓';
    } else {
      btn.classList.remove('active');
      arrow.textContent = '';
    }
  }
}

function renderGallery() {
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const grid = document.getElementById('galleryGrid');
  const filterKey = `${selectedFolder}:${q}:${currentSortField}:${currentSortOrder}`;
  if (filterKey !== galleryFilterKey) { galleryPage = 0; galleryFilterKey = filterKey; }

  const filtered = allImages.filter(item => {
    if (selectedFolder !== 'all') {
      if (selectedFolder.includes('/')) {
        if (`${item.year}/${item.month}` !== selectedFolder) return false;
      } else {
        if (item.year !== selectedFolder) return false;
      }
    }
    if (q && !item.filename.toLowerCase().includes(q)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (currentSortField === 'size') {
      const diff = (b.size || 0) - (a.size || 0);
      return currentSortOrder === 'asc' ? -diff : diff;
    }
    if (currentSortField === 'name') {
      const diff = (a.filename || '').localeCompare(b.filename || '', undefined, { numeric: true, sensitivity: 'base' });
      return currentSortOrder === 'asc' ? diff : -diff;
    }
    if (currentSortField === 'hits') {
      const diff = ((b.hits || 0) - (a.hits || 0)) || ((b.createdAt || 0) - (a.createdAt || 0));
      return currentSortOrder === 'asc' ? -diff : diff;
    }
    // Default 'time'
    const diff = (b.createdAt || 0) - (a.createdAt || 0);
    return currentSortOrder === 'asc' ? -diff : diff;
  });

  const filteredBytes = filtered.reduce((acc, cur) => acc + (cur.size || 0), 0);
  const bcEl = document.getElementById('currentFolderBreadcrumb');
  const stEl = document.getElementById('currentFolderStats');

  if (selectedFolder === 'all') {
    bcEl.textContent = t('allAssets');
  } else {
    bcEl.textContent = selectedFolder;
  }
  stEl.textContent = t('folderStatsHint', { count: filtered.length, bytes: formatBytes(filteredBytes) });
  const pages = Math.max(1, Math.ceil(filtered.length / GALLERY_PAGE_SIZE));
  galleryPage = Math.min(galleryPage, pages - 1);
  const pagination = document.getElementById('galleryPagination');
  if (pagination) pagination.innerHTML = `<button class="btn btn-outline" onclick="changeGalleryPage(-1)" ${galleryPage === 0 ? 'disabled' : ''}>${escapeHtml(t('pagePrevious'))}</button>
    <span>${escapeHtml(t('pageCount', { current: galleryPage + 1, total: pages }))}</span>
    <button class="btn btn-outline" onclick="changeGalleryPage(1)" ${galleryPage + 1 === pages ? 'disabled' : ''}>${escapeHtml(t('pageNext'))}</button>`;

  if (filtered.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:56px 20px; color:var(--muted); background:var(--panel); border:1px solid var(--border); border-radius:12px;">${t('noMatchingAssets')}</div>`;
    return;
  }

  grid.innerHTML = filtered.slice(galleryPage * GALLERY_PAGE_SIZE, (galleryPage + 1) * GALLERY_PAGE_SIZE).map((item) => {
    const isImg = item.isImage !== false;
    const isLocked = Boolean(item.locked);
    const primaryUrl = (isOptimizationEnabled && item.isProcessableImage && item.pubUrl) ? item.pubUrl : item.rawUrl;
    const lockBadgeHtml = isLocked
      ? `<span class="card-lock-badge" title="${t('lockedNotice', { filename: item.filename })}">🔒</span>`
      : '';

    const thumbInner = isImg
      ? `<img src="${escapeHtml(item.thumbnailUrl || item.rawPreviewPath)}" loading="lazy" alt="${escapeHtml(item.filename)}" />`
      : `<div class="file-icon-placeholder">
           <div style="font-size:32px;">📄</div>
           <div class="file-ext-label">${escapeHtml((item.ext || '').toUpperCase())}</div>
         </div>`;

    const rightMetaHtml = !isImg
      ? `<span class="meta-tag meta-direct">${t('tagDirectStream')}</span>`
      : isOptimizationEnabled
        ? (item.hasCache ? `<span class="meta-tag meta-opt">WebP ${formatBytes(item.cacheSize)}</span>` : `<span class="meta-tag meta-ondemand">${t('tagOnDemand')}</span>`)
        : `<span class="meta-tag meta-raw">${t('tagRawOnly')}</span>`;

    return `
    <div class="img-card ${isLocked ? 'is-locked' : ''}">
      <div class="img-thumb-wrap" onclick="openPreview(${jsArg(item.year)}, ${jsArg(item.month)}, ${jsArg(item.filename)})">
        ${thumbInner}
        ${lockBadgeHtml}
        <span class="img-tag">${item.year}/${item.month}</span>
        <div class="thumb-hover-actions">
          <button class="thumb-action-pill" onclick="event.stopPropagation(); copyText(${jsArg(primaryUrl)}, t('copyFileLink'))" title="${t('copyFileLink')}">📋 ${t('btnCopy')}</button>
          <button class="thumb-action-pill" onclick="event.stopPropagation(); openPreview(${jsArg(item.year)}, ${jsArg(item.month)}, ${jsArg(item.filename)})" title="${t('modalPreviewTitle')}">🔍</button>
        </div>
      </div>
      <div class="img-body">
        <div class="img-name" title="${escapeHtml(item.filename)}" onclick="openPreview(${jsArg(item.year)}, ${jsArg(item.month)}, ${jsArg(item.filename)})">${escapeHtml(item.filename)}</div>
        <div class="img-meta">
          <span class="meta-size">${formatBytes(item.size)}</span>
          <span class="meta-hits" title="${escapeHtml(t('hitsCount', { hits: item.hits || 0 }))}">👁️ ${item.hits || 0}</span>
          ${rightMetaHtml}
        </div>
        <div class="card-footer-action">
          <button class="card-copy-btn" onclick="copyText(${jsArg(primaryUrl)}, t('copyFileLink'))">
            📋 ${t('copyFileLink')}
          </button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function formatTransferSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 KB/s';
  if (bytesPerSec >= 1024 * 1024) return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
  return Math.round(bytesPerSec / 1024) + ' KB/s';
}

async function uploadFiles(files) {
  if (!files?.length || uploadController) return;
  const selected = Array.from(files);
  const controller = uploadController = new AbortController();
  failedUploads = [];
  let succeeded = 0;
  const startTime = Date.now();
  let transferredBytes = 0;

  const uploadBanner = document.getElementById('uploadProgress');
  if (uploadBanner) {
    uploadBanner.className = 'status-banner is-running';
    uploadBanner.classList.remove('hidden');
  }
  const bannerIcon = document.getElementById('uploadBannerIcon');
  if (bannerIcon) bannerIcon.textContent = '⏳';
  document.getElementById('cancelUpload').classList.remove('hidden');
  document.getElementById('retryUploads').classList.add('hidden');
  const closeBtn = document.getElementById('closeUploadBanner');
  if (closeBtn) closeBtn.classList.add('hidden');

  try {
    for (let i = 0; i < selected.length; i++) {
      if (controller.signal.aborted) { failedUploads.push(...selected.slice(i)); break; }
      const file = selected[i];
      const elapsed = Math.max(0.1, (Date.now() - startTime) / 1000);
      const speed = formatTransferSpeed(transferredBytes / elapsed);
      const speedTag = transferredBytes > 0 ? `<span class="status-pill status-pill-success">⚡ ${speed}</span>` : '';
      document.getElementById('uploadStatus').innerHTML =
        `<span><strong>${t('uploadingFiles')}</strong> (${i + 1}/${selected.length})</span>` +
        `<span class="status-pill">${escapeHtml(file.name)}</span>` +
        speedTag;
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetchWithRetry('/api/image/upload', { method: 'POST',
          headers: { 'X-File-Name': encodeURIComponent(file.name) }, body: fd, signal: controller.signal });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        succeeded++;
        transferredBytes += file.size || 0;
      } catch (err) {
        failedUploads.push(file);
        if (!controller.signal.aborted) console.warn('Upload failed:', file.name, err.message);
      }
    }
  } finally {
    uploadController = null;
    document.getElementById('fileInput').value = '';
    document.getElementById('cancelUpload').classList.add('hidden');
    document.getElementById('retryUploads').classList.toggle('hidden', failedUploads.length === 0);
    if (closeBtn) closeBtn.classList.remove('hidden');

    if (uploadBanner) {
      uploadBanner.className = 'status-banner ' + (failedUploads.length === 0 ? 'is-success' : 'is-warn');
    }
    if (bannerIcon) bannerIcon.textContent = failedUploads.length === 0 ? '✅' : '⚠️';

    const totalElapsed = Math.max(0.1, (Date.now() - startTime) / 1000);
    const avgSpeed = transferredBytes > 0 ? ` · ⚡ ${formatTransferSpeed(transferredBytes / totalElapsed)}` : '';

    if (failedUploads.length === 0) {
      document.getElementById('uploadStatus').innerHTML =
        `<span><strong>${t('uploadCompleted')}</strong></span>` +
        `<span class="status-pill status-pill-success">${t('lblSuccess')}: ${succeeded}${avgSpeed}</span>`;
    } else {
      document.getElementById('uploadStatus').innerHTML =
        `<span><strong>${t('uploadPartial')}</strong></span>` +
        `<span class="status-pill status-pill-success">${t('lblSuccess')}: ${succeeded}${avgSpeed}</span>` +
        `<span class="status-pill status-pill-warn">${t('lblFailed')}: ${failedUploads.length}</span>`;
    }

    const summary = t('uploadSummary', { success: succeeded, remaining: failedUploads.length });
    showToast(summary);
    try { await loadImages(); }
    catch (err) { showToast(t('errorGeneric', { error: err.message })); }
  }
}

function closeUploadBanner() {
  document.getElementById('uploadProgress').classList.add('hidden');
}

function cancelUploads() { uploadController?.abort(); }
function retryFailedUploads() { return uploadFiles(failedUploads); }

function closeIntegrityBanner() {
  document.getElementById('integrityProgress').classList.add('hidden');
}

async function startIntegrityCheck() {
  try {
    const res = await fetch('/api/modules/image-host/integrity', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const banner = document.getElementById('integrityProgress');
    if (banner) {
      banner.className = 'status-banner is-running';
      banner.classList.remove('hidden');
    }
    const iconEl = document.getElementById('integrityBannerIcon');
    if (iconEl) iconEl.textContent = '⏳';
    document.getElementById('downloadIntegrity').classList.add('hidden');
    const viewBtn = document.getElementById('viewIntegrityReport');
    if (viewBtn) viewBtn.classList.add('hidden');
    const closeBtn = document.getElementById('closeIntegrityBanner');
    if (closeBtn) closeBtn.classList.add('hidden');
    document.getElementById('cancelIntegrity').classList.remove('hidden');
    document.getElementById('integrityStatus').innerHTML =
      `<span><strong>${t('integrityRunning')}</strong></span>`;
    clearTimeout(integrityPoll);
    await pollIntegrityCheck();
  } catch (err) { showToast(t('errorGeneric', { error: err.message })); }
}

async function pollIntegrityCheck() {
  try {
    const res = await fetch('/api/modules/image-host/integrity');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    integrityReport = await res.json();
    const { state, checked = 0, matched = 0, issues = [] } = integrityReport;
    const banner = document.getElementById('integrityProgress');
    const statusEl = document.getElementById('integrityStatus');
    const iconEl = document.getElementById('integrityBannerIcon');
    const cancelBtn = document.getElementById('cancelIntegrity');
    const dlBtn = document.getElementById('downloadIntegrity');
    const viewBtn = document.getElementById('viewIntegrityReport');
    const closeBtn = document.getElementById('closeIntegrityBanner');

    if (state === 'running') {
      if (banner) banner.className = 'status-banner is-running';
      if (iconEl) iconEl.textContent = '⏳';
      cancelBtn.classList.remove('hidden');
      dlBtn.classList.add('hidden');
      if (viewBtn) viewBtn.classList.add('hidden');
      if (closeBtn) closeBtn.classList.add('hidden');
      statusEl.innerHTML =
        `<span><strong>${t('integrityRunning')}</strong></span>` +
        `<span class="status-pill">${t('statusChecked')}: ${checked}</span>` +
        `<span class="status-pill status-pill-success">${t('statusMatched')}: ${matched}</span>`;
      integrityPoll = setTimeout(pollIntegrityCheck, 1000);
    } else {
      cancelBtn.classList.add('hidden');
      dlBtn.classList.remove('hidden');
      if (viewBtn) viewBtn.classList.remove('hidden');
      if (closeBtn) closeBtn.classList.remove('hidden');

      if (state === 'completed' && issues.length === 0) {
        if (banner) banner.className = 'status-banner is-success';
        if (iconEl) iconEl.textContent = '✅';
        statusEl.innerHTML =
          `<span><strong>${t('integrity_completed')}</strong>：${t('integrityMatchedAll')}</span>` +
          `<span class="status-pill status-pill-success">${t('statusChecked')}: ${checked}</span>` +
          `<span class="status-pill status-pill-success">${t('statusMatched')}: ${matched}</span>` +
          `<span class="status-pill">${t('statusIssues')}: 0</span>`;
      } else {
        if (banner) banner.className = 'status-banner ' + (issues.length > 0 ? 'is-warn' : 'is-error');
        if (iconEl) iconEl.textContent = issues.length > 0 ? '⚠️' : '❌';
        statusEl.innerHTML =
          `<span><strong>${t('integrity_completed')}</strong>：${t('integrityHasIssues')}</span>` +
          `<span class="status-pill">${t('statusChecked')}: ${checked}</span>` +
          `<span class="status-pill status-pill-success">${t('statusMatched')}: ${matched}</span>` +
          `<span class="status-pill status-pill-warn">${t('statusIssues')}: ${issues.length}</span>` +
          (integrityReport.error ? ` <span style="color:var(--danger)">(${escapeHtml(integrityReport.error)})</span>` : '');
      }
    }
  } catch (err) { showToast(t('errorGeneric', { error: err.message })); }
}

async function cancelIntegrityCheck() {
  try {
    const res = await fetch('/api/modules/image-host/integrity', { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) { showToast(t('errorGeneric', { error: err.message })); }
}

function viewIntegrityDetails() {
  if (!integrityReport) return;
  const { checked = 0, matched = 0, issues = [] } = integrityReport;
  const summaryEl = document.getElementById('integrityModalSummary');
  const contentEl = document.getElementById('integrityModalContent');

  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="integrity-grid">
        <div class="integrity-grid-item">
          <div class="integrity-grid-val">${checked}</div>
          <div class="integrity-grid-lbl">${t('lblTotalChecked')}</div>
        </div>
        <div class="integrity-grid-item">
          <div class="integrity-grid-val is-success">${matched}</div>
          <div class="integrity-grid-lbl">${t('lblShaMatched')}</div>
        </div>
        <div class="integrity-grid-item">
          <div class="integrity-grid-val ${issues.length ? 'is-warn' : 'is-success'}">${issues.length}</div>
          <div class="integrity-grid-lbl">${t('lblIssuesFound')}</div>
        </div>
      </div>
    `;
  }

  if (contentEl) {
    if (issues.length === 0) {
      contentEl.innerHTML = `
        <div style="background:#f0fdf7; border:1px solid #bbf7d0; border-radius:6px; padding:20px; text-align:center; color:#166534; font-size:13px; line-height:1.6;">
          ${t('integrityAllMatched')}
        </div>
      `;
    } else {
      const rows = issues.map(iss => `
        <tr>
          <td style="font-family:var(--font-mono); font-size:12px;">${escapeHtml(iss.path || '-')}</td>
          <td><span class="status-pill status-pill-warn">${escapeHtml(iss.type || 'unknown')}</span></td>
          <td style="font-size:11px; color:var(--muted);">${escapeHtml(iss.error || (iss.expected ? `预期: ${iss.expected.slice(0, 12)}... / 实际: ${iss.actual?.slice(0, 12)}...` : '-'))}</td>
        </tr>
      `).join('');
      contentEl.innerHTML = `
        <div style="font-size:12.5px; font-weight:600; color:var(--warn); margin-bottom:8px;">${t('integrityIssuesFound')}</div>
        <table class="integrity-issues-table">
          <thead>
            <tr>
              <th>${t('lblPath')}</th>
              <th>${t('lblIssueType')}</th>
              <th>${t('lblIssueDetail')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    }
  }
  const modal = document.getElementById('integrityModal');
  if (modal) modal.classList.remove('hidden');
}

function closeIntegrityModal() {
  const modal = document.getElementById('integrityModal');
  if (modal) modal.classList.add('hidden');
}

function downloadIntegrityReport() {
  if (!integrityReport) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(integrityReport, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `file-master-integrity-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function toggleLockImage(year, month, filename, locked) {
  const res = await fetch('/api/modules/image-host/lock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ year, month, filename, locked })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || t('errorAction'));
    return;
  }
  showToast(locked ? `🔒 ${t('lockSuccess', { filename })}` : `🔓 ${t('unlockSuccess', { filename })}`);
  loadImages();
}

let dragCounter = 0;
const globalDropOverlay = document.getElementById('globalDropOverlay');

window.addEventListener('dragenter', (e) => {
  if (document.getElementById('appView').classList.contains('hidden')) return;
  e.preventDefault();
  dragCounter++;
  if (globalDropOverlay) globalDropOverlay.classList.remove('hidden');
});

window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    if (globalDropOverlay) globalDropOverlay.classList.add('hidden');
  }
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  if (globalDropOverlay) globalDropOverlay.classList.add('hidden');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    uploadFiles(e.dataTransfer.files);
  }
});
window.addEventListener('paste', (e) => {
  if (document.getElementById('appView').classList.contains('hidden')) return;
  const items = e.clipboardData?.items || [];
  const files = [];
  for (const it of items) {
    if (it.type.startsWith('image/')) files.push(it.getAsFile());
  }
  if (files.length) uploadFiles(files);
});

async function deleteImage(year, month, filename, isLocked) {
  if (isLocked) {
    alert(`🔒 ${t('lockedNotice', { filename })}`);
    return;
  }
  if (!confirm(t('deleteConfirm', { filename }))) return;
  const res = await fetch(`/api/modules/image-host/item/${encodeURIComponent(year)}/${encodeURIComponent(month)}/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    showToast('🗑️ ' + t('assetDeleted'));
    loadImages();
  } else {
    alert(data.error || t('errorDelete'));
  }
}

async function clearWatermarkCache() {
  const res = await fetch('/api/modules/image-host/cache/clear', { method: 'POST' });
  const data = await res.json();
  if (res.ok) {
    showToast('✅ ' + (data.message || t('cacheCleared')));
    loadImages();
  }
}

let currentShareTarget = null;

function createShareLink(year, month, filename) {
  currentShareTarget = { year, month, filename };
  const modal = document.getElementById('shareModal');
  const fileHint = document.getElementById('shareModalFilename');
  const expInput = document.getElementById('shareExpiryInput');
  const dlInput = document.getElementById('shareMaxDlInput');
  if (fileHint) fileHint.textContent = `${year}/${month}/${filename}`;
  if (expInput) expInput.value = '24';
  if (dlInput) dlInput.value = '0';
  if (modal) modal.classList.remove('hidden');
}

function closeShareModal() {
  const modal = document.getElementById('shareModal');
  if (modal) modal.classList.add('hidden');
  currentShareTarget = null;
}

async function submitCreateShare() {
  if (!currentShareTarget) return;
  const { year, month, filename } = currentShareTarget;
  const hoursStr = document.getElementById('shareExpiryInput')?.value || '24';
  const maxDlStr = document.getElementById('shareMaxDlInput')?.value || '0';
  const btn = document.getElementById('btnConfirmShare');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/modules/share/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        year,
        month,
        filename,
        expiresInHours: Number(hoursStr) || 0,
        maxDownloads: Number(maxDlStr) || 0
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.error || t('errorShare'));
      return;
    }
    closeShareModal();
    await copyText(data.share.shareUrl, t('shareColLink'));
    loadShares();
  } catch (err) {
    alert(err.message || t('errorShare'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadShares() {
  try {
    const res = await fetch('/api/modules/share/list');
    if (!res.ok) return;
    const { shares } = await res.json();
    const badge = document.getElementById('navShareCount');
    if (badge) badge.textContent = (shares || []).filter(s => !s.expired).length;

    const container = document.getElementById('shareListContainer');
    if (!container) return;
    if (!shares || shares.length === 0) {
      container.innerHTML = `<div style="text-align:center; padding:32px; color:var(--muted);">${t('noShareLinks')}</div>`;
      return;
    }

    container.innerHTML = `
      <div class="share-table-wrap">
        <table class="share-table">
          <thead>
            <tr>
              <th>${t('shareColAsset')}</th>
              <th>${t('shareColLink')}</th>
              <th>${t('shareColDownloads')}</th>
              <th>${t('shareColExpires')}</th>
              <th>${t('shareColStatus')}</th>
              <th>${t('shareColActions')}</th>
            </tr>
          </thead>
          <tbody>
            ${shares.map(s => {
              const expText = s.expiresAt > 0 ? new Date(s.expiresAt).toLocaleString(currentLocale === 'zh' ? 'zh-CN' : 'en-US') : t('shareNeverExpire');
              const dlText = s.maxDownloads > 0 ? `${s.downloads} / ${s.maxDownloads}` : `${s.downloads} (∞)`;
              const statusBadge = s.expired
                ? `<span class="share-status expired">${t('shareStatusExpired')}</span>`
                : `<span class="share-status active">${t('shareStatusActive')}</span>`;
              return `
                <tr>
                  <td data-label="${t('shareColAsset')}">${escapeHtml(s.year)}/${escapeHtml(s.month)}/${escapeHtml(s.filename)}</td>
                  <td data-label="${t('shareColLink')}"><code class="inline-code share-url" title="${escapeHtml(s.shareUrl)}">${escapeHtml(s.shareUrl)}</code></td>
                  <td data-label="${t('shareColDownloads')}">${dlText}</td>
                  <td data-label="${t('shareColExpires')}">${expText}</td>
                  <td data-label="${t('shareColStatus')}">${statusBadge}</td>
                  <td class="share-actions" data-label="${t('shareColActions')}">
                    <button class="btn btn-primary" style="padding:4px 10px; font-size:12px;" onclick="copyText(${jsArg(s.shareUrl)}, t('shareColLink'))">${t('shareBtnCopy')}</button>
                    <button class="btn btn-danger" style="padding:4px 10px; font-size:12px;" onclick="revokeShare(${jsArg(s.id)})">${t('shareBtnRevoke')}</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch {}
}

async function revokeShare(shareId) {
  if (!confirm(t('revokeShareConfirm'))) return;
  const res = await fetch('/api/modules/share/' + encodeURIComponent(shareId), { method: 'DELETE' });
  if (res.ok) {
    showToast('🗑️ ' + t('shareRevoked'));
    loadShares();
  }
}

let currentModalMode = 'pub';

function openPreview(year, month, filename) {
  currentModalItem = allImages.find(i => i.year === year && i.month === month && i.filename === filename);
  if (!currentModalItem) return;

  document.getElementById('modalTitle').textContent = filename;
  document.getElementById('previewModal').classList.remove('hidden');

  const canShowOpt = isOptimizationEnabled && currentModalItem.isProcessableImage;
  const modeGroup = document.getElementById('previewModeGroup');
  if (modeGroup) modeGroup.style.display = canShowOpt ? 'flex' : 'none';

  setModalMode(canShowOpt ? 'pub' : 'raw');

  // Populate metadata chips
  const chipRaw = document.getElementById('previewChipRawSize');
  if (chipRaw) chipRaw.textContent = `Raw: ${formatBytes(currentModalItem.size)}`;

  const chipPub = document.getElementById('previewChipPubSize');
  if (chipPub) {
    if (canShowOpt) {
      chipPub.style.display = '';
      chipPub.textContent = currentModalItem.hasCache
        ? `WebP: ${formatBytes(currentModalItem.cacheSize)}`
        : `WebP: ${t('tagOnDemand')}`;
    } else {
      chipPub.style.display = 'none';
    }
  }

  const chipHits = document.getElementById('previewChipHits');
  if (chipHits) chipHits.textContent = `👁️ ${t('hitsCount', { hits: currentModalItem.hits || 0 })}`;

  const chipPath = document.getElementById('previewChipPath');
  if (chipPath) chipPath.textContent = `📂 ${currentModalItem.year}/${currentModalItem.month}`;

  updateModalLockBtn();

  const delBtn = document.getElementById('btnModalDelete');
  if (delBtn) {
    delBtn.disabled = Boolean(currentModalItem.locked);
    delBtn.style.opacity = currentModalItem.locked ? '0.45' : '1';
    delBtn.title = currentModalItem.locked ? t('delLockedTooltip') : '';
  }
}

function updateModalLockBtn() {
  const lockBtn = document.getElementById('btnModalLock');
  if (!lockBtn || !currentModalItem) return;
  if (currentModalItem.locked) {
    lockBtn.innerHTML = `🔓 ${t('unlockBtn')}`;
    lockBtn.style.borderColor = '#d99b46';
    lockBtn.style.color = '#855000';
  } else {
    lockBtn.innerHTML = `🔒 ${t('lockBtn')}`;
    lockBtn.style.borderColor = '';
    lockBtn.style.color = '';
  }
}

function setModalMode(mode) {
  if (!currentModalItem) return;
  currentModalMode = mode;
  const img = document.getElementById('modalImg');
  const btnPub = document.getElementById('btnViewPub');
  const btnRaw = document.getElementById('btnViewRaw');
  if (mode === 'pub' && currentModalItem.pubPreviewPath) {
    img.src = currentModalItem.pubPreviewPath + '?t=' + Date.now();
    if (btnPub) btnPub.classList.add('active');
    if (btnRaw) btnRaw.classList.remove('active');
  } else {
    img.src = currentModalItem.rawPreviewPath;
    if (btnRaw) btnRaw.classList.add('active');
    if (btnPub) btnPub.classList.remove('active');
  }
}

function copyModalActiveLink() {
  if (!currentModalItem) return;
  const isPub = (currentModalMode === 'pub' && currentModalItem.pubUrl);
  const url = isPub ? currentModalItem.pubUrl : currentModalItem.rawUrl;
  copyText(url, isPub ? 'WebP URL' : 'Raw URL');
}

function copyModalMarkdown() {
  if (!currentModalItem) return;
  const isPub = (currentModalMode === 'pub' && currentModalItem.pubUrl);
  const url = isPub ? currentModalItem.pubUrl : currentModalItem.rawUrl;
  const md = currentModalItem.isImage !== false
    ? `![](${url})`
    : `[📎 ${currentModalItem.filename}](${url})`;
  copyText(md, 'Markdown');
}

function downloadModalFile() {
  if (!currentModalItem) return;
  const a = document.createElement('a');
  a.href = currentModalItem.rawUrl;
  a.download = currentModalItem.filename;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('⬇️ ' + t('copied', { label: currentModalItem.filename }));
}

async function toggleModalLock() {
  if (!currentModalItem) return;
  const newLock = !currentModalItem.locked;
  await toggleLockImage(currentModalItem.year, currentModalItem.month, currentModalItem.filename, newLock);
  currentModalItem.locked = newLock;
  updateModalLockBtn();
  const delBtn = document.getElementById('btnModalDelete');
  if (delBtn) {
    delBtn.disabled = newLock;
    delBtn.style.opacity = newLock ? '0.45' : '1';
  }
}

function shareModalFile() {
  if (!currentModalItem) return;
  createShareLink(currentModalItem.year, currentModalItem.month, currentModalItem.filename);
}

function deleteModalFile() {
  if (!currentModalItem) return;
  deleteImage(currentModalItem.year, currentModalItem.month, currentModalItem.filename, currentModalItem.locked);
  closeModal();
}

function closeModal() {
  document.getElementById('previewModal').classList.add('hidden');
  document.getElementById('modalImg').src = '';
  loadImages();
}

async function generateNewTotp() {
  const res = await fetch('/api/platform/totp-generate', { method: 'POST' });
  const data = await res.json();
  if (res.ok) {
    document.getElementById('newTotpSecret').textContent = data.secret;
    document.getElementById('newTotpUri').textContent = data.otpauthUri;
    document.getElementById('f_totp_secret').value = data.secret;
    document.getElementById('totpResultBox').classList.remove('hidden');
  }
}

function quickJumpHotUpdate() {
  const maintenanceBtn = document.getElementById('navItemMaintenance');
  switchTab('maintenance', maintenanceBtn);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function appendUpdateLog(text, replace = false) {
  const logBox = document.getElementById('updLogBox');
  logBox.classList.remove('hidden');
  if (replace) {
    logBox.textContent = text;
  } else {
    logBox.textContent = (logBox.textContent ? logBox.textContent + '\n' : '') + text;
  }
  logBox.scrollTop = logBox.scrollHeight;
}

async function loadLocalUpdateStatus() {
  try {
    const res = await fetch('/api/platform/update/status');
    if (!res.ok) return;
    const st = await res.json();
    if (st.dependenciesPending) appendUpdateLog(t('updateDependenciesPending'));
    document.getElementById('updVersionBadge').textContent = 'v' + (st.version || '0.1.0');
    const commitEl = document.getElementById('updLocalCommit');
    if (st.localShortCommit) {
      commitEl.textContent = `#${st.localShortCommit} (${st.currentBranch || 'main'}) · ${st.localCommitMessage || ''}`;
    } else {
      commitEl.textContent = st.hasGitDir ? t('gitNoCommits') : t('gitNotInit');
    }
  } catch {}
}

async function checkRemoteUpdate() {
  const btn = document.getElementById('btnCheckUpdate');
  const statusEl = document.getElementById('updRemoteStatus');
  const checkedEl = document.getElementById('updLastChecked');
  btn.disabled = true;
  btn.textContent = t('checkChecking');
  statusEl.innerHTML = `<span style="color:var(--muted);">${t('checkRemoteFetching')}</span>`;

  try {
    const upstream_mirror = getSelectedUpstreamMirror();
    const upstream_branch = 'main';
    await fetch('/api/platform/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'form', patch: { upstream_mirror, upstream_branch } })
    });

    const res = await fetch('/api/platform/update/status?fetch=1');
    const st = await res.json();
    if (!res.ok) {
      throw new Error(st.error || t('checkFailed'));
    }

    checkedEl.textContent = t('checkedAt', { time: new Date().toLocaleTimeString(currentLocale === 'zh' ? 'zh-CN' : 'en-US') });
    if (st.dependenciesPending) {
      statusEl.textContent = t('updateDependenciesPending');
      appendUpdateLog(t('updateDependenciesPending'), true);
    } else if (st.hasUpdate) {
      statusEl.innerHTML = `<span style="color:var(--warn); font-weight:600;">${t('checkAvailable', { count: st.commitsBehind, commit: st.remoteShortCommit })}</span>`;
      if (st.incomingCommits && st.incomingCommits.length > 0) {
        appendUpdateLog(t('updateIncoming', { branch: st.upstreamBranch }) + '\n' + st.incomingCommits.map(c => '  • ' + c).join('\n'), true);
      }
      showToast(t('checkAvailable', { count: st.commitsBehind, commit: st.remoteShortCommit }));
    } else {
      statusEl.innerHTML = `<span style="color:var(--success); font-weight:600;">${t('checkLatest', { commit: st.remoteShortCommit || st.localShortCommit || '-' })}</span>`;
      showToast(t('checkLatest', { commit: st.remoteShortCommit || st.localShortCommit || '-' }));
    }
  } catch (err) {
    statusEl.innerHTML = `<span style="color:var(--danger);">${t('checkFailed')}</span>`;
    appendUpdateLog(t('updateCheckError', { error: err.message }), true);
  } finally {
    btn.disabled = false;
    btn.textContent = t('btnCheckUpdates');
  }
}

async function waitForServerReconnect(maxAttempts = 25) {
  appendUpdateLog(t('updateWaitingRestart'));
  for (let i = 1; i <= maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 900));
    try {
      const res = await fetch('/api/platform/status?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        appendUpdateLog('✅ ' + t('serverOnline'));
        showToast(t('updateRestartSuccess'));
        await loadConfigForEdit();
        await loadImages();
        return true;
      }
    } catch {}
  }
  appendUpdateLog(t('reconnectTimeout'));
  return false;
}

async function triggerHotUpdate() {
  const upstream_mirror = getSelectedUpstreamMirror();
  const upstream_branch = 'main';
  const mirrorHint = upstream_mirror ? ` (${upstream_mirror})` : '';
  if (!confirm(t('hotUpdateConfirm', { branch: upstream_branch, mirrorHint }))) {
    return;
  }

  const btnPull = document.getElementById('btnPullUpdate');
  const btnCheck = document.getElementById('btnCheckUpdate');
  const btnRestart = document.getElementById('btnRestartOnly');
  btnPull.disabled = true;
  btnCheck.disabled = true;
  btnRestart.disabled = true;
  btnPull.textContent = '⏳ ' + t('pullingUpdate');
  appendUpdateLog(t('updateStarting', { branch: upstream_branch, mirrorHint }), true);

  try {
    const res = await fetch('/api/platform/update/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upstream_mirror, upstream_branch })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || t('errorUpdateGeneric'));
    }

    if (Array.isArray(data.logs)) {
      appendUpdateLog(data.logs.join('\n'), true);
    }
    btnPull.textContent = '🔄 ' + t('restartingServer');
    await waitForServerReconnect();
  } catch (err) {
    appendUpdateLog(t('updateFailed', { error: err.message }));
    await loadLocalUpdateStatus();
    alert(t('errorUpdate', { error: err.message }));
  } finally {
    btnPull.disabled = false;
    btnCheck.disabled = false;
    btnRestart.disabled = false;
    btnPull.textContent = t('btnPullUpdate');
  }
}

async function triggerServerRestartOnly() {
  if (!confirm(t('restartConfirm'))) return;
  const btnRestart = document.getElementById('btnRestartOnly');
  btnRestart.disabled = true;
  btnRestart.textContent = '⏳ ' + t('restartingServer');
  appendUpdateLog(t('restartStarting'), true);

  try {
    const res = await fetch('/api/platform/restart', { method: 'POST' });
    if (!res.ok) throw new Error(res.statusText || String(res.status));
    await waitForServerReconnect();
  } catch (err) {
    appendUpdateLog(t('restartFailed', { error: err.message }));
  } finally {
    btnRestart.disabled = false;
    btnRestart.textContent = t('btnRestartOnly');
  }
}

initApp();

