# File Master Server

自建文件库，集中管理图片、附件和分享链接。

**简体中文** · [English](README.en.md) · [Obsidian 插件](https://github.com/weichen-ink/file-master)

## 功能

- **文件管理**：上传、搜索、时间归档，支持网格和列表查看。
- **图片预览**：放大、拖动，复制原文件、WebP 或 Markdown 链接。
- **图片优化**：压缩、调整尺寸、添加水印，同时保留原文件。
- **分享与回收站**：创建限时分享，恢复误删文件。
- **日常维护**：查看资源占用、定时备份、下载备份和在线更新。

可独立使用，也可连接 Obsidian 插件或 PicList。支持中英文界面，以及亮色、暗色和跟随系统主题。

## 部署

### Docker Compose

```bash
git clone https://github.com/weichen-ink/file-master-server.git
cd file-master-server
docker compose up -d --build
```

打开 `http://localhost:3210/setup`，设置站点和管理员账号。远程部署时，将 `localhost` 换成服务器地址。

初始化后，请按[部署说明](docs/DEPLOYMENT.md)保存并挂载站点配置；升级容器时保留文件和配置。

### Node.js

需要 Node.js 18 或更新版本。

```bash
git clone https://github.com/weichen-ink/file-master-server.git
cd file-master-server
npm ci
npm start
```

同样打开 `http://localhost:3210/setup` 完成初始化。

## 开始使用

从首页进入管理页面（默认 `/admin`），即可上传和管理文件。连接客户端时，使用“站点设置”中的站点地址和上传 API 令牌；公网访问建议使用 HTTPS。

本版本为 **1.1**，连接 Obsidian 时请使用 **1.1 或更新版本**的插件。升级前可在“备份与恢复”中保存一份完整备份。

[更新记录](CHANGELOG.md) · [问题反馈](https://github.com/weichen-ink/file-master-server/issues) · [MIT 许可证](LICENSE)
