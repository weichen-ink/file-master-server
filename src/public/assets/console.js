let allImages = [];
let currentModalItem = null;
let selectedFolder = 'all';
let isOptimizationEnabled = true;
const collapsedYears = new Set();

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

function toggleSecretField(id, button) {
  const input = document.getElementById(id);
  const showing = input.type === 'password';
  input.type = showing ? 'text' : 'password';
  button.dataset.i18n = showing ? 'btnHideSecret' : 'btnShowSecret';
  button.textContent = t(button.dataset.i18n);
}

function toggleHeadersVisibility() {
  const value = document.getElementById('epHeadersJson');
  const button = document.getElementById('btnRevealHeaders');
  const showing = value.dataset.revealed !== 'true';
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
  } else if (tabId === 'settings' || tabId === 'security' || tabId === 'maintenance' || tabId === 'platform') {
    loadConfigForEdit();
    if (tabId === 'settings') loadServerMetrics(false);
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
  const res = await fetch('/api/platform/status');
  const data = await res.json();
  if (data.needsSetup) {
    window.location.href = '/setup';
    return;
  }
  isOptimizationEnabled = data.optimizationEnabled !== false;
  document.title = data.siteName + ' - Console';
  document.getElementById('loginSiteName').textContent = data.siteName;
  document.getElementById('navSiteName').textContent = data.siteName;
  document.getElementById('mobileSiteName').textContent = data.siteName;

  if (data.totpEnabled) {
    document.getElementById('totpGroup').classList.remove('hidden');
  }

  if (data.authenticated) {
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('appView').classList.remove('hidden');
    loadImages();
    loadShares();
  } else {
    document.getElementById('loginView').classList.remove('hidden');
    document.getElementById('appView').classList.add('hidden');
    const savedUser = localStorage.getItem('filemaster_saved_username');
    const savedRem = localStorage.getItem('filemaster_remember_pref');
    if (savedRem !== null) {
      document.getElementById('rememberAccount').checked = savedRem === '1';
    }
    if (savedUser) {
      document.getElementById('loginUsername').value = savedUser;
      document.getElementById('loginPassword').focus();
    } else {
      document.getElementById('loginUsername').focus();
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
  const enabled = document.getElementById('f_enable_optimization')?.value === 'true';
  const sec = document.getElementById('optConfigSection');
  if (sec) {
    sec.style.opacity = enabled ? '1' : '0.45';
    sec.style.pointerEvents = enabled ? 'auto' : 'none';
  }
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
  document.getElementById('f_port').value = cfg.port || 3000;
  
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
  document.getElementById('f_watermark_image').value = img.watermark_image || './watermark.png';
  document.getElementById('f_watermark_text').value = img.watermark_text || '';
  document.getElementById('f_watermark_color').value = img.watermark_color || '#ffffff';
  toggleConsoleOptFields();
}

async function saveConfigForm() {
  const patch = {
    site_name: document.getElementById('f_site_name').value.trim(),
    base_url: document.getElementById('f_base_url').value.trim().replace(/\/+$/, ''),
    port: Number(document.getElementById('f_port').value) || 3000,
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
      watermark_image: document.getElementById('f_watermark_image').value.trim(),
      watermark_text: document.getElementById('f_watermark_text').value,
      watermark_color: document.getElementById('f_watermark_color').value.trim()
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

  const sortedYears = [...yearMap.keys()].sort((a, b) => {
    if (a === 'protected') return -1;
    if (b === 'protected') return 1;
    return b.localeCompare(a);
  });
  for (const year of sortedYears) {
    const yData = yearMap.get(year);
    const isCollapsed = collapsedYears.has(year);
    const isYearActive = selectedFolder === year;
    const arrow = isCollapsed ? '▸' : '▾';
    const yearLabel = year === 'protected' ? t('folderProtectedLabel') : `📂 ${year}`;

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
        const monthLabel = month === 'keep' ? t('folderKeepLabel') : `📁 ${month} <span style="font-size:11px; color:var(--muted);">(${year}/${month})</span>`;
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

function renderGallery() {
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const grid = document.getElementById('galleryGrid');

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

  const filteredBytes = filtered.reduce((acc, cur) => acc + (cur.size || 0), 0);
  const bcEl = document.getElementById('currentFolderBreadcrumb');
  const stEl = document.getElementById('currentFolderStats');

  if (selectedFolder === 'all') {
    bcEl.textContent = t('allAssets');
  } else {
    bcEl.textContent = selectedFolder;
  }
  stEl.textContent = t('folderStatsHint', { count: filtered.length, bytes: formatBytes(filteredBytes) });

  if (filtered.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:56px 20px; color:var(--muted); background:var(--panel); border:1px solid var(--border); border-radius:12px;">${t('noMatchingAssets')}</div>`;
    return;
  }

  grid.innerHTML = filtered.map((item) => {
    const isImg = item.isImage !== false;
    const iconMap = {
      pdf: t('catPdf'),
      video: t('catVideo'),
      audio: t('catAudio'),
      archive: t('catArchive'),
      document: t('catDocument')
    };
    const badgeLabel = iconMap[item.category] || t('catAttachment');
    const rawMdText = isImg ? `![](${item.rawUrl})` : `[📎 ${item.filename}](${item.rawUrl})`;
    const optMdText = isImg && item.pubUrl ? `![](${item.pubUrl})` : rawMdText;
    const isLocked = Boolean(item.locked);
    const lockBadgeHtml = isLocked
      ? `<span style="position:absolute; top:8px; left:8px; background:rgba(245,158,11,0.92); color:#fff; font-size:11px; font-weight:700; padding:2px 8px; border-radius:6px;">${t('lockBtn')}</span>`
      : '';

    const thumbHtml = isImg
      ? `<div class="img-thumb-wrap" onclick="openPreview(${jsArg(item.year)}, ${jsArg(item.month)}, ${jsArg(item.filename)})">
           <img src="${escapeHtml(item.rawPreviewPath)}" loading="lazy" alt="${escapeHtml(item.filename)}" />
           ${lockBadgeHtml}
           <span class="img-tag">${item.year}/${item.month}</span>
         </div>`
      : `<div class="img-thumb-wrap" onclick="window.open(${jsArg(item.rawPreviewPath)}, '_blank')" style="flex-direction:column; gap:6px; cursor:pointer;">
           ${lockBadgeHtml}
           <div style="font-size:28px;">${badgeLabel.split(' ')[0]}</div>
           <div style="font-size:12px; color:var(--primary); font-weight:600;">${escapeHtml(badgeLabel.split(' ')[1] || '')} (${escapeHtml((item.ext || '').toUpperCase())})</div>
           <span class="img-tag">${item.year}/${item.month}</span>
         </div>`;

    const lockBtnHtml = `<button class="btn btn-outline" onclick="toggleLockImage(${jsArg(item.year)}, ${jsArg(item.month)}, ${jsArg(item.filename)}, ${!isLocked})" style="${isLocked ? 'border-color:#d99b46; color:#855000;' : ''}">${isLocked ? t('unlockBtn') : t('lockBtn')}</button>`;

    const optRowHtml = (isOptimizationEnabled && item.isProcessableImage && item.pubUrl)
      ? `<div class="track-row">
           <span class="track-tag track-webp">${t('trackWebp')}</span>
           <button class="btn btn-outline" onclick="copyText(${jsArg(optMdText)}, 'Optimized Markdown')">${t('btnMarkdown')}</button>
           <button class="btn btn-outline" style="border-color:#a6d1be; color:#167a5c;" onclick="copyText(${jsArg(item.pubUrl)}, 'Optimized WebP URL')">${t('btnDirectUrl')}</button>
         </div>`
      : '';

    const rightMetaHtml = !isImg
      ? t('tagDirectStream')
      : isOptimizationEnabled
        ? (item.hasCache ? t('tagOptimized', { size: formatBytes(item.cacheSize) }) : t('tagOnDemand'))
        : t('tagRawOnly');

    return `
    <div class="img-card" style="${isLocked ? 'border-color: rgba(245,158,11,0.45);' : ''}">
      ${thumbHtml}
      <div class="img-body">
        <div>
          <div class="img-name" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</div>
          <div class="img-meta">
            <span>Raw ${formatBytes(item.size)}</span>
            <span>${rightMetaHtml}</span>
          </div>
        </div>
        <div class="card-actions">
          <button class="btn btn-primary btn-block" onclick="copyText(${jsArg(item.rawUrl)}, t('copyFileLink'))">${t('copyFileLink')}</button>
          <details class="card-more">
            <summary>${t('moreFileActions')}</summary>
            <div class="card-more-panel">
              <div class="link-tracks">
                <div class="track-row">
                  <span class="track-tag track-raw">${t('trackRaw')}</span>
                  <button class="btn btn-outline" onclick="copyText(${jsArg(rawMdText)}, 'Raw Markdown')">${t('btnMarkdown')}</button>
                  <button class="btn btn-outline" onclick="copyText(${jsArg(item.rawUrl)}, 'Raw URL')">${t('btnDirectUrl')}</button>
                </div>
                ${optRowHtml}
              </div>
              <div class="card-footer-actions">
                <button class="btn btn-outline" onclick="createShareLink(${jsArg(item.year)}, ${jsArg(item.month)}, ${jsArg(item.filename)})" title="${t('shareTooltip')}">${t('shareBtn')}</button>
                <div class="card-footer-right">
                  ${lockBtnHtml}
                  <button class="btn btn-danger" ${isLocked ? `disabled style="opacity:0.45; cursor:not-allowed;" title="${t('delLockedTooltip')}"` : ''} onclick="deleteImage(${jsArg(item.year)}, ${jsArg(item.month)}, ${jsArg(item.filename)}, ${isLocked})">${t('deleteBtn')}</button>
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>
    </div>
  `;
  }).join('');
}

async function uploadFiles(files) {
  if (!files || !files.length) return;
  showToast(`⏳ ${t('uploading', { count: files.length })}`);
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file);
    const headers = { 'X-File-Name': encodeURIComponent(file.name) };
    const res = await fetch('/api/image/upload', {
      method: 'POST',
      headers,
      body: fd
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(t('errorUpload', { error: err.error || res.statusText }));
    }
  }
  document.getElementById('fileInput').value = '';
  showToast('✅ ' + t('uploadSuccess'));
  loadImages();
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

const dropZone = document.getElementById('dropZone');
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
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

async function createShareLink(year, month, filename) {
  const hoursStr = prompt(t('sharePromptExpiry', { filename }), '24');
  if (hoursStr === null) return;
  const maxDlStr = prompt(t('sharePromptMaxDl'), '0');
  if (maxDlStr === null) return;

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
  await copyText(data.share.shareUrl, t('shareColLink'));
  loadShares();
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

function openPreview(year, month, filename) {
  currentModalItem = allImages.find(i => i.year === year && i.month === month && i.filename === filename);
  if (!currentModalItem) return;
  document.getElementById('modalTitle').textContent = filename;
  document.getElementById('previewModal').classList.remove('hidden');
  const btnPub = document.getElementById('btnViewPub');
  const canShowOpt = isOptimizationEnabled && currentModalItem.isProcessableImage;
  if (btnPub) btnPub.style.display = canShowOpt ? '' : 'none';
  setModalMode(canShowOpt ? 'pub' : 'raw');
}

function setModalMode(mode) {
  if (!currentModalItem) return;
  const img = document.getElementById('modalImg');
  const btnPub = document.getElementById('btnViewPub');
  const btnRaw = document.getElementById('btnViewRaw');
  if (mode === 'pub') {
    img.src = currentModalItem.pubPreviewPath + '?t=' + Date.now();
    btnPub.className = 'btn btn-primary';
    btnRaw.className = 'btn btn-outline';
  } else {
    img.src = currentModalItem.rawPreviewPath;
    btnRaw.className = 'btn btn-primary';
    btnPub.className = 'btn btn-outline';
  }
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
    if (st.hasUpdate) {
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

