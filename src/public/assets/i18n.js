// ================= Bilingual Internationalization (zh-CN / en) =================
const I18N = {
  zh: {
    allAssets: "全部资源",
    copied: "已复制 {label}",
    deleteConfirm: "确定要删除 {filename} 吗？（原图将移入回收站，同时清理关联缓存）",
    lockedNotice: "文件 '{filename}' 已开启防删保护锁，请先解锁后再删除。",
    lockSuccess: "已开启防删保护: {filename}",
    unlockSuccess: "已解除防删保护: {filename}",
    uploading: "正在上传 {count} 个文件...",
    uploadSuccess: "上传成功！",
    configSaved: "配置已保存并立即生效！",
    rawSaved: "config.yaml 源码已保存生效！",
    cacheCleared: "WebP 与水印缓存已清空。",
    copyRawBtn: "📎 复制原始链接",
    copyOptBtn: "⚡ 复制优化链接",
    copyMdBtn: "📋 Markdown",
    shareBtn: "🔗 分享",
    deleteBtn: "🗑️ 删除",
    lockBtn: "🔒 加锁",
    unlockBtn: "🔓 解锁",
    protectedBtn: "🛡️ 保护目录",
    navAssets: "🖼️ 图床与附件管理",
    navStatus: "📊 主机与进程监控",
    navShares: "📁 过期短链分享",
    navConfig: "🛡️ 配置与安全中心",
    navHotUpdate: "🚀 在线热更新",
    navLogout: "退出登录",
    langToggle: "🌐 English"
  },
  en: {
    allAssets: "All Assets",
    copied: "Copied {label}",
    deleteConfirm: "Are you sure you want to delete {filename}? (Moved to trash and cache cleared)",
    lockedNotice: "File '{filename}' is locked against deletion. Unlock it before deleting.",
    lockSuccess: "Protected against deletion: {filename}",
    unlockSuccess: "Unlocked deletion protection: {filename}",
    uploading: "Uploading {count} file(s)...",
    uploadSuccess: "Upload completed successfully!",
    configSaved: "Configuration saved and active!",
    rawSaved: "config.yaml source saved successfully!",
    cacheCleared: "Watermark cache cleared successfully.",
    copyRawBtn: "📎 Copy Raw URL",
    copyOptBtn: "⚡ Copy Optimized URL",
    copyMdBtn: "📋 Markdown",
    shareBtn: "🔗 Share",
    deleteBtn: "🗑️ Delete",
    lockBtn: "🔒 Lock",
    unlockBtn: "🔓 Unlock",
    protectedBtn: "🛡️ Protected",
    navAssets: "🖼️ Image Host & Assets",
    navStatus: "📊 Host & Process Status",
    navShares: "📁 Expiring Share Links",
    navConfig: "🛡️ Config & Security",
    navHotUpdate: "🚀 Pull & Hot Update",
    navLogout: "Sign Out",
    langToggle: "🌐 简体中文"
  }
};

let currentLocale = localStorage.getItem('filemaster_lang') || 'zh';

function t(key, params = {}) {
  const dict = I18N[currentLocale] || I18N.zh;
  let msg = dict[key] || I18N.en[key] || key;
  for (const [k, v] of Object.entries(params)) {
    msg = msg.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return msg;
}

function applyLocaleToStaticDom() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  const langBtn = document.getElementById('btnLangSwitch');
  if (langBtn) langBtn.textContent = t('langToggle');
}

function toggleConsoleLanguage() {
  currentLocale = currentLocale === 'zh' ? 'en' : 'zh';
  localStorage.setItem('filemaster_lang', currentLocale);
  applyLocaleToStaticDom();
  if (typeof renderFolderTree === 'function') renderFolderTree();
  if (typeof renderGallery === 'function') renderGallery();
}

