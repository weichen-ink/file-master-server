# ⚡ File Master Server

[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Docker Support](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](Dockerfile)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-Passing-success)](tests/)

> **Lightweight, database-free self-hosted image hosting and asset management service.**  
> *Zero External Database · Dual-Link Delivery · Instant Upload (秒传) · Multi-Layer Security*

[English](#english) | [简体中文](#简体中文)

---

<a name="english"></a>
## 🌟 Overview

**File Master Server** is a fast, database-free self-hosted media backend designed to accompany the [File Master Obsidian Plugin](https://github.com/weichen-ink/file-master). It can also function as an independent, secure image hosting platform for PicList, Astro static blogs, CLI scripts, and markdown documentation workflows.

---

## ✨ Key Architectural Features

- ⚡ **Zero External Database Overhead**:
  - Relies entirely on the native file system with atomic JSON state (`data/`) and clean chronological directory storage (`storage/raw/YYYY/MM/`).
  - No MySQL, PostgreSQL, or Redis configuration required. Backup is as simple as copying the folder.

- 🪄 **Interactive Web Setup Wizard (`/setup`)**:
  - Automatically redirects to `/setup` on first launch when uninitialized.
  - Generates administrator credentials, API tokens, and watermarking preferences in seconds.
  - Permanently locks after initialization to prevent tampering.

- 🚀 **Instant Upload SHA-256 Probe (秒传)**:
  - Lightweight endpoint (`/api/image/probe`) matches hashes against the server's index in milliseconds.
  - Allows client applications to skip uploading payloads when an identical file already exists on the server.

- 🛡️ **Enterprise Security Defense**:
  - **`scrypt` Password Hashing**: Passwords stored salted and hashed.
  - **Brute-Force Circuit Breaker**: Sliding-window rate limiter + automatic 24-hour persistent IP ban (`data/ip_bans.json`).
  - **2FA TOTP Support**: RFC 6238 two-factor authentication (Google Authenticator, 1Password).
  - **Header-Only API Token**: API tokens strictly validated via `Authorization: Bearer` or `X-API-Token` (never exposed in URL query strings).

- 🖼️ **Dual-Track Delivery & Watermark Engine**:
  - **Raw Lossless Asset**: `/:rawSecret/YYYY/MM/filename.ext` serves unmodified original files.
  - **Optimized WebP Delivery**: `/pub/YYYY/MM/filename.webp` applies on-the-fly Sharp compression and customizable dynamic watermarking with caching in `storage/cache/`.

---

## 🚀 Quick Deployment

### Option 1: Docker Compose (Recommended)

1. Clone repository and start container:
   ```bash
   git clone https://github.com/weichen-ink/file-master-server.git
   cd file-master-server
   docker compose up -d --build
   ```
2. Open your browser and navigate to:  
   `http://localhost:3210/setup`
3. Complete the interactive setup wizard to set your administrator credentials and API token.

Use HTTPS for access from other devices. Set `trust_proxy` to your trusted reverse proxy and restart the server so it can mark administrator cookies `Secure` (the default `loopback` only trusts a proxy on the same host). Plain HTTP is suitable only for a local, trusted setup connection; it does not protect the plugin API token or administrator password in transit.

Persistent data (`./storage` and `./data`) are mounted to your host automatically.

### Storage, backups, and update recovery

- Run one server process per writable storage directory, including when using PM2 or Docker.
- The filesystem and mount permissions must allow hard links within the upload directory. Uploads publish complete files through an exclusive hard link. Unsupported storage returns **HTTP 501**; copying directly to a public filename cannot provide the same atomic publication guarantee.
- Startup probes exclusive hard links inside `storage/raw/`. A failed probe is reported in the server log and the authenticated asset manager before uploading. Fix mount permissions or move to a compatible filesystem, then restart. The probe is a startup snapshot; uploads still check each publication.
- Stop writes or use a consistent snapshot when backing up `storage/raw/`, `data/` (including `sha_index.json`), `config.yaml`, and custom watermark files. Restore originals and their matching index together; deleting the index loses the existing integrity baselines.
- Update recovery restores user configuration and watermarks. It does **not** guarantee rollback of updated source code and installed dependencies. If dependency installation fails, the pending state and backups remain. Resolve the error, then run the hot update again even when the commit is already current: installation will be retried. Startup recovery restores unfinished user assets without rerunning npm; it does not overwrite assets already restored. Avoid restarting until installation succeeds.

See [batch processing and scale](docs/SCALABILITY.md) for recovery and verification details.

---

### Option 2: Running with Node.js & PM2

**Requirements**: Node.js `>= 18.0.0`

```bash
# 1. Install dependencies
npm install

# 2. Production startup via PM2 ecosystem (named 'fms')
npm install -g pm2
pm2 start ecosystem.config.js
# Or run via npm script
npm run pm2

# 3. View startup output and runtime logs
pm2 logs fms
# Useful PM2 commands:
pm2 restart fms
pm2 stop fms
```

---

### Nginx Reverse Proxy Example

```nginx
server {
    listen 80;
    server_name img.yourdomain.com;
    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3210;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## ⚙️ Configuration Reference (`config.yaml`)

```yaml
# Platform Basics
site_name: File Master Server
port: 3210
base_url: http://localhost:3210
trust_proxy: loopback

# Security & Authentication
admin_path: admin               # Admin console route (e.g. /admin)
username: admin                 # Administrator username
password: scrypt:...            # Auto-hashed with scrypt
max_login_attempts: 3           # Lockout threshold before IP ban
totp_secret: ""                 # 2FA base32 secret (leave blank to disable)
api_token: fm_...               # Global API token for client integrations

# Image Host & Watermark Engine
image_host:
  raw_secret_path: raw          # Route prefix for lossless files (/raw/YYYY/MM/file.ext)
  enable_optimization: true     # Enable Sharp WebP transcoding & watermark
  webp_quality: 82              # WebP compression quality (1-100)
  max_width: 1920               # Max width constraint (0 for unlimited)
  watermark_enable: true        # Watermark switch for public links: true | false
  watermark_type: image         # image | text | tile
  watermark_pos: bottom-right   # bottom-right | bottom-left | top-right | top-left | center
  watermark_opacity: 0.65       # Transparency (0.1 - 1.0)
  watermark_scale: 0.16         # Proportional scale (16% of width)
  watermark_margin: 24          # Edge padding in pixels
  watermark_min_width: 320      # Skip watermarking if image width < threshold
  watermark_image: ./watermark.png
  watermark_image_dark: ./watermark-dark.png
  watermark_auto_contrast: true # Adaptive light/dark switching by image luminance
  watermark_text: "© File Master"
  watermark_color: "#ffffff"
  watermark_color_dark: "#111827"
  watermark_font: system        # system | pingfang | arial | impact | georgia | courier
```

---

## 🔌 API Endpoints Summary

| Method | Route | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/platform/version` | Platform version and feature contract | No |
| `GET/POST` | `/api/platform/setup` | First-time setup wizard (locked after init) | First Run Only |
| `GET` | `/api/image/probe` | Instant upload SHA-256 probe check | API Token / Session |
| `POST` | `/api/image/upload` | Upload file (multipart streaming `file`) | API Token / Session |
| `GET` | `/:rawSecret/:year/:month/:file` | Fetch lossless original file | Public |
| `GET` | `/:rawSecret/:year/:month/:file?thumbnail=1` | Bounded WebP thumbnail for processable images | Secret original URL |
| `GET` | `/pub/:year/:month/:file` | Fetch optimized WebP (supports dynamic `?wm=image`, `?wm=text`, `?wm=tile`) | Public |
| `GET` | `/api/modules/image-host/list` | Fetch all assets and storage metrics | API Token / Session |
| `POST` | `/api/modules/image-host/lock` | Toggle asset deletion lock | API Token / Session |
| `DELETE` | `/api/modules/image-host/item/:y/:m/:f` | Soft-delete file to `storage/trash/` | API Token / Session |
| `POST` | `/api/modules/image-host/cache/clear` | Purge WebP derivative cache | API Token / Session |
| `POST/GET/DELETE` | `/api/modules/image-host/integrity` | Start, inspect, or cancel original-file verification | API Token / Session |

For large batches, the console supports cancellation, retries of unfinished uploads, 60-item gallery pages, and downloadable original-file verification reports. Deploy one server process per writable storage directory. See [batch processing and scale](docs/SCALABILITY.md) for recovery, index compatibility, integrity semantics, and reproducible checks.

---

## 🗺️ Future Roadmap

- [ ] **Multi-User & RBAC**: Role-based permissions and user-specific storage quotas.
- [ ] **Hybrid Storage Drivers**: S3/R2 object storage driver support alongside local storage.
- [ ] **Video Transcoding**: Thumbnail generation and lightweight H.264/WebM compression.
- [ ] **WebDAV Server**: Built-in WebDAV server for mounting storage as a network drive.
- [ ] **1-Click Full Backup Generator**: Downloadable full-vault archive (`.tar.gz` / `.zip`).

---

<a name="简体中文"></a>
## 🇨🇳 简体中文介绍

**File Master Server** 是一款面向个人与中小型团队的轻量级、无数据库自建多媒体图床与资产管理系统。

### ✨ 核心特性
* **⚡ 零外部数据库**: 纯本地文件系统 + 原子 JSON 存储，无需 MySQL/Redis，备份只需拷贝文件夹。
* **🪄 首次交互式安装向导**: 初次启动自动进入 `/setup`，一键生成强密码与配置，初始化后永久锁死防篡改。
* **🚀 SHA-256 毫秒秒传探针**: 提供 `/api/image/probe` 接口，客户端本地比对哈希，已有文件 0 流量秒传复用。
* **🛡️ 企业级多层安全防御**: `scrypt` 密码哈希、连续失败 IP 封禁、两步验证（TOTP 2FA）、Header API 凭证校验。
* **🖼️ 原图与 WebP 双轨分发**: 笔记内保留原始无损文件，公开博客分发使用 Sharp 动态转码与智能水印。

### 批处理与完整校验

千张级图片使用单进程文件存储与轻量索引；同一份可写目录只运行一个服务实例。网页支持停止上传、重试未完成项、每页 60 项的缩略图库，以及原文件 SHA-256 完整校验和报告下载。恢复清单、索引兼容性、备份要求及验证边界见[批处理与规模说明](docs/SCALABILITY.md)。

### 存储、备份与更新恢复要求

- 每份可写存储目录只运行一个服务进程，使用 PM2 或 Docker 时也需遵守。
- 上传目录所在的文件系统及挂载权限必须允许同目录硬链接。上传通过独占硬链接一次性发布完整文件；不支持时返回 **HTTP 501**。直接复制到公开文件名无法提供相同的原子发布保证。
- 启动时会在 `storage/raw/` 内探测硬链接和目标独占性；失败会在服务日志及登录后的资产管理页提前提示。请修复挂载权限或更换兼容的文件系统后重启。探测仅反映启动时的能力，实际上传仍逐次检查发布操作。
- 备份时暂停写入或使用一致性快照，保存 `storage/raw/`、`data/`（包含 `sha_index.json`）、`config.yaml` 和自定义水印。恢复原图时同时恢复对应索引；删除索引会丢失已有完整性基准。
- 更新恢复保障用户配置和水印的恢复，**不保证已更新的源代码和依赖整体回退**。依赖安装失败会保留待完成状态与备份；排除错误后，即使已是最新提交，也应重新执行热更新以重试安装。启动恢复只恢复尚未完成的用户配置和水印，不运行 npm，也不会反复覆盖已恢复后又被修改的文件。安装成功前请避免手动重启。

### 📄 许可证
[MIT License](LICENSE)

### Development and tests / 开发与测试

Install development dependencies with `npm ci`, then run **`npm test`**. The runner copies each test file into a separate temporary project and cleans it up afterward. Do not run `node --test` directly in the working repository: it bypasses isolation, and configuration tests deliberately refuse to run there. See [CONTRIBUTING.md](CONTRIBUTING.md) for validation and release checks.

使用 `npm ci` 安装开发依赖后，必须通过 **`npm test`** 运行测试。测试运行器为每个测试文件创建独立临时项目并自动清理。不要在工作仓库直接运行 `node --test`，它会绕过隔离，涉及配置的测试会主动拒绝执行。开发及发布检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。
