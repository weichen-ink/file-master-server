const path = require('node:path');

/** One startup summary for both languages and both first-run/initialized states. */
function startupMessage(cfg, { port, version, networkAddress, initialized, storageDir }) {
  const zh = cfg.language === 'zh';
  const divider = '  ──────────────────────────────────────────────────────────';
  const lines = ['', divider, `  🚀 ${initialized ? cfg.site_name || 'File Master Server' : 'File Master Server'} v${version}`, ''];
  const row = (emoji, chinese, english, value) => {
    const label = (zh ? chinese : english) + ':';
    const width = [...label].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
    lines.push(`  ${emoji} ${label}${' '.repeat(Math.max(1, 12 - width))}${value}`);
  };
  if (!initialized) {
    lines.push(zh ? '  ✨ 尚未配置站点，请访问以下地址完成初始化：' : '  ✨ Open a setup URL below to configure your site:');
    row('💻', '本机', 'Local', `http://localhost:${port}/setup`);
    if (networkAddress) row('🌐', '局域网', 'Network', networkAddress + '/setup');
  } else {
    const customBase = cfg.base_url && !/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(cfg.base_url);
    const origin = customBase ? cfg.base_url : `http://localhost:${port}`;
    row('💻', '本机', 'Local', `http://localhost:${port}/`);
    if (networkAddress) row('🌐', '局域网', 'Network', networkAddress + '/');
    if (customBase) row('🌍', '站点', 'Site', origin + '/');
    row('🔐', '管理后台', 'Admin', `${origin}/${cfg.admin_path}`);
    row('📤', '上传接口', 'Upload', `${origin}/api/image/upload`);
    if (cfg.monitoring?.enabled) row('🩺', '监控接口', 'Health', `${origin}/api/health`);
    lines.push('');
    row('📁', '文件存储', 'Storage', './' + (path.relative(process.cwd(), storageDir) || 'storage'));
    const img = cfg.image_host || {};
    const optimization = img.enable_optimization !== false
      ? (zh ? `已开启（质量 ${img.webp_quality || 82}，最大宽度 ${img.max_width ?? 1920}px）` : `Enabled (quality ${img.webp_quality || 82}, max width ${img.max_width ?? 1920}px)`)
      : (zh ? '未开启' : 'Disabled');
    row('✨', 'WebP 优化', 'WebP', optimization);
    const positions = { 'bottom-right':'右下角', 'bottom-left':'左下角', 'top-right':'右上角', 'top-left':'左上角', center:'居中' };
    const type = img.watermark_type === 'image' ? (zh ? '图片' : 'Image') : img.watermark_type === 'tile' ? (zh ? '平铺' : 'Tile') : (zh ? '文字' : 'Text');
    const position = zh ? positions[img.watermark_pos] || '右下角' : img.watermark_pos || 'bottom-right';
    row('💧', '水印', 'Watermark', img.watermark_enable
      ? (zh ? `已启用（${type}，${position}）` : `Enabled (${type}, ${position})`)
      : (zh ? '未启用' : 'Disabled'));
  }
  lines.push('', zh ? '  💡 按 Ctrl+C 停止服务' : '  💡 Press Ctrl+C to stop', divider, '');
  return lines.join('\n');
}

module.exports = { startupMessage };
