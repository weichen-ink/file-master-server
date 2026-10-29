// ================= Bilingual Internationalization (zh-CN / en) =================
const I18N = {
  zh: {
    // 侧边栏与导航
    navSecWorkspace: "工作空间",
    navAssets: "🖼️ 文件与资产库",
    navShares: "📁 安全文件分享",
    navMonitoring: "📊 主机与监控中心",
    navSecSystem: "系统管理",
    navSettings: "⚙️ 系统配置中心",
    navSecurity: "🛡️ 安全与访问权限",
    navMaintenance: "🚀 系统维护与更新",
    navHotUpdate: "在线热更新",
    navLogout: "退出登录",
    langToggle: "🌐 English",

    // 交互提示与按钮
    allAssets: "全部资源",
    copied: "已复制 {label}",
    deleteConfirm: "确定要删除 {filename} 吗？原图将移入回收站，同时清理关联缓存。",
    lockedNotice: "文件 '{filename}' 已开启防删保护锁，请先解锁后再删除。",
    lockSuccess: "已开启防删保护: {filename}",
    unlockSuccess: "已解除防删保护: {filename}",
    uploading: "正在上传 {count} 个文件...",
    uploadSuccess: "上传成功！",
    configSaved: "配置已保存并立即生效！",
    rawSaved: "配置文件源码已保存并生效！",
    cacheCleared: "图片缓存已清空并重新生成。",
    copyRawBtn: "📎 原始链接",
    copyOptBtn: "⚡ 优化链接",
    copyMdBtn: "📋 Markdown",
    shareBtn: "🔗 分享",
    deleteBtn: "🗑️ 删除",
    lockBtn: "🔒 加锁",
    unlockBtn: "🔓 解锁",
    protectedBtn: "🛡️ 保护目录",

    // 资产管理页面
    lblAssetManagerTitle: "文件与资产库",
    lblAssetManagerDesc: "支持拖拽、粘贴或通过 Obsidian 插件直接上传；无损存储原始素材，并支持按需 WebP 水印转码。",
    chkUploadProtected: "🛡️ 上传至防删保护目录",
    btnClearWatermarkCache: "🔄 重建水印缓存",
    btnUploadFiles: "+ 上传文件",
    lblStatRawCount: "原始资产总数",
    lblStatRawHint: "无损保存于 storage/raw",
    lblStatRawSize: "原始资产总占用",
    lblStatRawSizeHint: "磁盘实际占用容量",
    lblStatPubCount: "缓存优化数量",
    lblStatPubHint: "按需生成的 WebP / 水印版本",
    lblStatPubSize: "缓存占用空间",
    lblStatPubSavings: "体积节省比例",

    // 安全文件分享
    lblSharesTitle: "安全文件分享短链",
    lblSharesDesc: "生成带有效时长与下载次数限制的独立分享链接，不暴露服务器真实存储路径。",
    btnRefreshShares: "🔄 刷新分享列表",

    // 主机监控中心
    lblMonitorTitle: "主机与进程监控",
    lblMonitorDesc: "实时观测 Node.js 进程状态、内存占用、垃圾回收站容量及系统运行健康指标。",
    lblMetricUptime: "服务连续运行时间",
    lblMetricMemory: "Node.js 堆内存占用",
    lblMetricRss: "物理常驻内存",
    lblMetricTrash: "安全回收站容量",
    btnEmptyTrash: "🗑️ 清空回收站",

    // 系统配置子标签
    subtabGeneral: "基本参数",
    subtabMedia: "图床与媒体处理",
    subtabRawYaml: "原始配置 (YAML)",

    // 配置表单
    lblSiteName: "站点名称",
    lblBaseUrl: "对外访问公网地址",
    lblPort: "服务监听端口",
    lblRawSecretPath: "原始文件访问路径前缀",
    lblEnableOptimization: "启用图片自动优化与双链接",
    optOptEnabled: "开启 — 同时提供原始文件链接与 WebP 优化链接",
    optOptDisabled: "关闭 — 仅使用原始无损文件",
    lblWebpQuality: "WebP 压缩画质 (10-100)",
    lblMaxWidth: "最大图片宽度限制 (像素, 0 为不限制)",
    lblWatermarkEnable: "水印功能",
    optWatermarkOn: "开启水印",
    optWatermarkOff: "关闭水印",
    lblWatermarkType: "水印呈现样式",
    optWatermarkImg: "PNG 图片水印",
    optWatermarkText: "角落文本水印",
    optWatermarkTile: "全图平铺水印",
    lblWatermarkPos: "水印摆放位置",
    optPosBottomRight: "右下角",
    optPosBottomLeft: "左下角",
    optPosTopRight: "右上角",
    optPosTopLeft: "左上角",
    optPosCenter: "居中",
    lblWatermarkOpacity: "水印不透明度 (0.1 - 1.0)",
    lblWatermarkScale: "水印缩放比例 (0.05 - 0.8)",
    lblWatermarkMargin: "边距留白 (像素)",
    lblWatermarkMinWidth: "启用水印最小图片宽度 (像素)",
    lblWatermarkImage: "水印图片相对路径",
    lblWatermarkText: "水印文字内容",
    lblWatermarkColor: "水印文字颜色",
    lblAutoClearCache: "保存配置后自动清理旧缓存（立即对已有图片生效）",
    btnSaveConfig: "💾 保存配置",

    // 安全中心
    lblSecurityTitle: "安全中心与访问凭据",
    lblSecurityDesc: "管理控制台身份验证凭证、对外上传 API 令牌、双重验证密钥及暴力破解防范策略。",
    lblUsername: "管理员账号",
    lblPassword: "管理员密码 (留空表示保持原密码不变)",
    lblAdminPath: "隐蔽后台访问路径",
    lblMaxLoginAttempts: "登录失败锁定阈值 (次)",
    lblApiToken: "全局上传 API 访问令牌",
    lblTotpSecret: "双重验证密钥 (TOTP, 留空即关闭)",
    btnGenerateTotp: "✨ 生成新密钥",
    btnSaveSecurity: "🛡️ 保存安全设置",

    // 系统维护与更新
    lblUpstreamTitle: "官方版本维护与在线热更新",
    lblUpstreamDesc: "一键检查官方仓库版本更新。点击「拉取更新并平滑重启」将拉取最新代码、完整保留现有配置与存储数据，并平滑重启服务。",
    lblOfficialRepo: "官方更新源与分支",
    lblOfficialLocked: "🔒 官方锁定",
    lblEnableMirror: "是否开启加速",
    optMirrorOff: "关闭 (官方直连)",
    optMirrorOn: "开启加速",
    lblMirrorPreset: "加速服务器选择",
    btnCheckUpdates: "🔍 检查更新",
    btnRestartOnly: "♻️ 仅重启服务",
    btnPullUpdate: "⚡ 拉取更新并平滑重启",
    lblBackupTitle: "系统灾备与 Linux 云备份",
    lblBackupDesc: "支持一键打包导出快照归档（.tar.gz），或通过 Linux rclone 工具配置定时增量云同步。",
    btnExportConfig: "📦 导出配置与索引 (.tar.gz)",
    btnExportFull: "🗄️ 导出完整全量库 (.tar.gz)",
    lblRcloneHint: "# Linux 环境通过 rclone 定时增量同步云端示例："
  },
  en: {
    // Sidebar & Navigation
    navSecWorkspace: "Workspace",
    navAssets: "🖼️ Files & Assets",
    navShares: "📁 Shared Links",
    navMonitoring: "📊 Host & Monitoring",
    navSecSystem: "System",
    navSettings: "⚙️ System Settings",
    navSecurity: "🛡️ Security & Access",
    navMaintenance: "🚀 Maintenance & Updates",
    navHotUpdate: "Hot Update",
    navLogout: "Sign Out",
    langToggle: "🌐 简体中文",

    // Prompts & Buttons
    allAssets: "All Assets",
    copied: "Copied {label}",
    deleteConfirm: "Are you sure you want to delete {filename}? Moved to trash and cache cleared.",
    lockedNotice: "File '{filename}' is deletion-protected. Unlock it before deleting.",
    lockSuccess: "Protected against deletion: {filename}",
    unlockSuccess: "Unlocked deletion protection: {filename}",
    uploading: "Uploading {count} file(s)...",
    uploadSuccess: "Upload completed successfully!",
    configSaved: "Configuration saved and active!",
    rawSaved: "Configuration file saved and active!",
    cacheCleared: "Image cache cleared and refreshed.",
    copyRawBtn: "📎 Raw URL",
    copyOptBtn: "⚡ Optimized URL",
    copyMdBtn: "📋 Markdown",
    shareBtn: "🔗 Share",
    deleteBtn: "🗑️ Delete",
    lockBtn: "🔒 Lock",
    unlockBtn: "🔓 Unlock",
    protectedBtn: "🛡️ Protected",

    // Assets View
    lblAssetManagerTitle: "Files & Asset Library",
    lblAssetManagerDesc: "Upload via drag-and-drop, clipboard paste, or FileMaster Obsidian plugin with lossless storage and adaptive WebP watermarks.",
    chkUploadProtected: "🛡️ Upload to Protected Folder",
    btnClearWatermarkCache: "🔄 Rebuild Watermark Cache",
    btnUploadFiles: "+ Upload Files",
    lblStatRawCount: "Total Raw Assets",
    lblStatRawHint: "Lossless storage in storage/raw",
    lblStatRawSize: "Raw Storage Footprint",
    lblStatRawSizeHint: "Actual disk space used",
    lblStatPubCount: "Cached WebP Assets",
    lblStatPubHint: "Generated on-the-fly",
    lblStatPubSize: "Cache Footprint",
    lblStatPubSavings: "Bandwidth Savings",

    // Shared Links
    lblSharesTitle: "Secure Expiring File Shares",
    lblSharesDesc: "Generate isolated expiring share links with download limits without exposing raw paths.",
    btnRefreshShares: "🔄 Refresh Shares",

    // Host & Monitoring
    lblMonitorTitle: "Host & Process Status",
    lblMonitorDesc: "Real-time metrics for Node.js process, memory, trash retention, and operational health.",
    lblMetricUptime: "Process Uptime",
    lblMetricMemory: "Node.js Heap Memory",
    lblMetricRss: "Resident Set Size (RSS)",
    lblMetricTrash: "Trash Retention Size",
    btnEmptyTrash: "🗑️ Empty Trash",

    // Settings Subtabs
    subtabGeneral: "General",
    subtabMedia: "Image & Media",
    subtabRawYaml: "Raw YAML",

    // Settings Form
    lblSiteName: "Site Name",
    lblBaseUrl: "Public Access URL",
    lblPort: "Server Port",
    lblRawSecretPath: "Original File URL Prefix",
    lblEnableOptimization: "Dual-Link Image Optimization",
    optOptEnabled: "Enabled — Offer both Raw and Optimized WebP URLs",
    optOptDisabled: "Disabled — Lossless original files only",
    lblWebpQuality: "WebP Compression Quality (10-100)",
    lblMaxWidth: "Max Image Width (px, 0 for unlimited)",
    lblWatermarkEnable: "Watermark Feature",
    optWatermarkOn: "Watermark Enabled",
    optWatermarkOff: "Watermark Disabled",
    lblWatermarkType: "Watermark Style",
    optWatermarkImg: "PNG Image",
    optWatermarkText: "Corner Text",
    optWatermarkTile: "Full-Tile Pattern",
    lblWatermarkPos: "Watermark Position",
    optPosBottomRight: "Bottom-Right",
    optPosBottomLeft: "Bottom-Left",
    optPosTopRight: "Top-Right",
    optPosTopLeft: "Top-Left",
    optPosCenter: "Center",
    lblWatermarkOpacity: "Watermark Opacity (0.1 - 1.0)",
    lblWatermarkScale: "Watermark Scale (0.05 - 0.8)",
    lblWatermarkMargin: "Edge Padding (px)",
    lblWatermarkMinWidth: "Min Width to Watermark (px)",
    lblWatermarkImage: "Watermark Image Path",
    lblWatermarkText: "Watermark Text Content",
    lblWatermarkColor: "Watermark Text Color",
    lblAutoClearCache: "Automatically clear cache on save (applies to existing images immediately)",
    btnSaveConfig: "💾 Save Configuration",

    // Security Center
    lblSecurityTitle: "Security & Credentials",
    lblSecurityDesc: "Manage admin authentication credentials, API upload tokens, two-factor auth, and brute-force defenses.",
    lblUsername: "Admin Username",
    lblPassword: "Admin Password (leave blank to keep unchanged)",
    lblAdminPath: "Stealth Admin Access Path",
    lblMaxLoginAttempts: "Login Attempt Limit",
    lblApiToken: "Global Upload API Token",
    lblTotpSecret: "Two-Factor Auth Secret (TOTP, leave blank to disable)",
    btnGenerateTotp: "✨ Generate New Key",
    btnSaveSecurity: "🛡️ Save Security Settings",

    // Maintenance & Updates
    lblUpstreamTitle: "Official Updates & Hot Restart",
    lblUpstreamDesc: "Check for updates with one click. Pulling updates will automatically pull official code, preserve your config and asset data, and restart smoothly.",
    lblOfficialRepo: "Official Repository & Branch",
    lblOfficialLocked: "🔒 Official Locked",
    lblEnableMirror: "Mirror Accelerator",
    optMirrorOff: "Disabled (Direct GitHub)",
    optMirrorOn: "Enabled (Mirror Proxy)",
    lblMirrorPreset: "Accelerator Server",
    btnCheckUpdates: "🔍 Check Updates",
    btnRestartOnly: "♻️ Restart Server",
    btnPullUpdate: "⚡ Pull & Hot Restart",
    lblBackupTitle: "System Backups & Linux Disaster Recovery",
    lblBackupDesc: "Export one-click .tar.gz snapshots or set up scheduled Linux rclone incremental cloud backups.",
    btnExportConfig: "📦 Export Config & Index (.tar.gz)",
    btnExportFull: "🗄️ Export Full Assets & Config (.tar.gz)",
    lblRcloneHint: "# Linux incremental backup example using rclone:"
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
    if (key) {
      if (el.tagName === 'INPUT' && el.type === 'button') {
        el.value = t(key);
      } else {
        el.textContent = t(key);
      }
    }
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
