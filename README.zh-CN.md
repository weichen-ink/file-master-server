# File Master Server

**轻量自建文件与附件管理服务端**：集文件存储、外链分享、媒体处理、定时备份与状态监控于一体，可独立作为私有文件库使用，也可无缝对接 [Obsidian File Master 插件](https://github.com/weichen-ink/file-master) 与 PicList。

**简体中文** · [English](README.md) · [Obsidian 插件](https://github.com/weichen-ink/file-master) · [更新记录](CHANGELOG.md)

---

## 为什么选择 File Master Server？

相比单纯的图床或网盘，File Master Server 专注于**“长期可维护、低心智负担”的个人/团队文件基础设施**：
- **数据完全掌握在自己手里**：原文件按年月清晰存放在本地磁盘，不依赖第三方图床，也不绑定复杂数据库；
- **原文件与优化版本分离**：WebP 压缩与水印按需生成并缓存，原文件始终保持纯净，随时可重新生成或下载；
- **改名不怕旧链接立刻失效**：服务端重命名文件后自动保留旧路径别名宽限期，已发布的博客/文档不会突然 404；
- **内置运维闭环**：定时备份、rclone 异地同步、Bark 通知、回收站与 `/api/health` 监控接口开箱即用。

---

## 核心能力

- **文件管理与检索**：支持按目录、文件类型、关键词及时间/大小/访问量排序浏览，网格与列表视图自由切换，大图预览支持缩放与拖拽。
- **媒体处理（压缩 + 自适应水印）**：支持自动 WebP 转换、最大宽度限制，以及图片/文字/平铺水印（支持根据图片亮度自动切换深浅色水印，后台实时预览效果）。
- **安全与去重机制**：上传自动 SHA-256 去重；支持文件锁定防删、安全重命名（含旧链接宽限期）以及服务端回收站还原。
- **外链分享**：为任意文件生成独立分享链接，可配置过期时间与最大下载次数，随时撤销。
- **运维管理与监控**：内置运行状态面板、低 CPU 占用的定时/手动打包备份（支持 `rclone` 同步与 Bark 推送）、GitHub 在线更新与只读 `/api/health` 监控端点。
- **多端与多语言**：支持简体中文与 English，支持亮色、暗色及跟随系统主题。

---

## 快速部署

### 方式一：Docker Compose（推荐）

```bash
git clone https://github.com/weichen-ink/file-master-server.git
cd file-master-server
docker compose up -d --build
```

启动后打开 `http://localhost:3210/setup`（远程部署请将 `localhost` 替换为服务器地址）完成初始化设置。

> 初始化后请参考[部署说明](docs/DEPLOYMENT.md)确认挂载目录与配置持久化，确保升级容器时文件与配置不丢失。

### 方式二：Node.js 直接运行

需要 **Node.js 18** 或更新版本：

```bash
git clone https://github.com/weichen-ink/file-master-server.git
cd file-master-server
npm ci
npm start
```

打开 `http://localhost:3210/setup` 完成初始化。

### 方式三：PM2 后台守护

适合希望关闭终端后服务持续运行的 Node.js 部署（完成克隆与 `npm ci` 后在项目目录执行；若已运行 `npm start` 请先 `Ctrl+C` 停止）：

```bash
npm install -g pm2
npm run pm2
pm2 save
```

服务名称为 `fms`，默认端口 `3210`。如需开机自启，执行 `pm2 startup` 并按终端提示完成配置。

| 操作 | 命令 |
| --- | --- |
| 查看运行状态 | `pm2 status fms` |
| 查看运行日志 | `pm2 logs fms` |
| 重启服务 | `pm2 restart fms` |
| 停止服务 | `pm2 stop fms` |

> [!TIP]
> **Linux 中文文字水印字体提示**：若在 Linux/VPS 环境中使用中文文字水印，请安装中文字体包以避免渲染为方块：`sudo apt-get install -y fonts-noto-cjk fonts-wqy-zenhei fontconfig`。使用最新 `Dockerfile` 构建的容器已内置中文字体。

---

## 开始使用

1. 访问管理后台（默认 `/admin`），即可直接上传、浏览与分享文件。
2. 若需接入 **Obsidian File Master** 或 **PicList**，前往 **系统设置 → 站点设置** 复制站点地址与上传 API 令牌（公网环境建议配合 HTTPS 反向代理）。
3. 当前版本为 **1.2.0**，连接 Obsidian 时请确保插件版本为 **1.1 及以上**（推荐同步使用 **1.2.0+**）。

---

## 接入第三方监控（`/api/health`）

在 **系统设置 → 站点设置 → 监控接入** 中开启接口，按需勾选要公开的状态分组并保存，即可将固定端点填入 Uptime Kuma 等监控工具（无需登录或令牌，且只暴露勾选字段，可在设置页先预览 JSON）：

```bash
curl https://your-site.example/api/health
```

- **可选分组**：服务运行状态、CPU 与内存、存储占用、文件数量、备份状态。
- **状态码约定**：`200` 表示服务正常，`503` 表示核心存储不可用；关闭接口后返回 `404`。
- **采集与刷新频率**：建议每 30–60 秒轮询一次（资源数据最多每 15 秒刷新，备份状态每 5 秒刷新，存储与文件统计每 60 秒刷新；无法采集的分组会标记为 `status: "unknown"`）。
- 在 `config.yaml` 中设置 `language: zh` 或 `language: en` 可指定服务端启动终端日志语言，与浏览器语言互不影响。

---

[更新记录](CHANGELOG.md) · [问题反馈](https://github.com/weichen-ink/file-master-server/issues) · [MIT 许可证](LICENSE)
