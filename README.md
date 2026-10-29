# ⚡ FileMaster Server

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

**FileMaster Server** is a fast, database-free self-hosted media backend designed to accompany the [FileMaster Obsidian Plugin](https://github.com/weichen-ink/file-master). It can also function as an independent, secure image hosting platform for PicList, Astro static blogs, CLI scripts, and markdown documentation workflows.

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
   `http://localhost:3000/setup`
3. Complete the interactive setup wizard to initialize your administrator credentials and API token.

Persistent data (`./storage` and `./data`) are mounted to your host automatically.

---

### Option 2: Running with Node.js & PM2

**Requirements**: Node.js `>= 18.0.0`

```bash
# 1. Install dependencies
npm install

# 2. Production startup via PM2
npm install -g pm2
pm2 start src/server.js --name filemaster-server
pm2 save && pm2 startup
```

---

### Nginx Reverse Proxy Example

```nginx
server {
    listen 80;
    server_name img.yourdomain.com;
    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3000;
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
site_name: FileMaster Server
port: 3000
base_url: http://localhost:3000
trust_proxy: loopback

# Security & Authentication
admin_path: admin               # Admin console route (e.g. /admin)
username: admin                 # Administrator username
password: scrypt:...            # Auto-hashed with scrypt
max_login_attempts: 5           # Lockout threshold before IP ban
totp_secret: ""                 # 2FA base32 secret (leave blank to disable)
api_token: fm_...               # Global API token for client integrations

# Image Host & Watermark Engine
image_host:
  raw_secret_path: raw          # Route prefix for lossless files (/raw/YYYY/MM/file.ext)
  enable_optimization: true     # Enable Sharp WebP transcoding & watermark
  webp_quality: 82              # WebP compression quality (1-100)
  max_width: 1920               # Max width constraint (0 for unlimited)
  watermark_enable: true        # Dynamic watermark on optimized link
  watermark_type: image         # image | text
  watermark_pos: bottom-right   # bottom-right | bottom-left | top-right | top-left | center
  watermark_opacity: 0.65       # Transparency (0.1 - 1.0)
  watermark_scale: 0.16         # Proportional scale (16% of width)
  watermark_image: ./watermark.png
  watermark_text: "© FileMaster"
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
| `GET` | `/pub/:year/:month/:file` | Fetch optimized WebP / watermarked image | Public |
| `GET` | `/api/modules/image-host/list` | Fetch all assets and storage metrics | API Token / Session |
| `POST` | `/api/modules/image-host/lock` | Toggle asset deletion lock | API Token / Session |
| `DELETE` | `/api/modules/image-host/item/:y/:m/:f` | Soft-delete file to `storage/trash/` | API Token / Session |
| `POST` | `/api/modules/image-host/cache/clear` | Purge WebP derivative cache | API Token / Session |

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

**FileMaster Server** 是一款面向个人与中小型团队的轻量级、无数据库自建多媒体图床与资产管理系统。

### ✨ 核心特性
* **⚡ 零外部数据库**: 纯本地文件系统 + 原子 JSON 存储，无需 MySQL/Redis，备份只需拷贝文件夹。
* **🪄 首次交互式安装向导**: 初次启动自动进入 `/setup`，一键生成强密码与配置，初始化后永久锁死防篡改。
* **🚀 SHA-256 毫秒秒传探针**: 提供 `/api/image/probe` 接口，客户端本地比对哈希，已有文件 0 流量秒传复用。
* **🛡️ 企业级多层安全防御**: `scrypt` 密码哈希、连续失败 IP 封禁、两步验证（TOTP 2FA）、Header API 凭证校验。
* **🖼️ 原图与 WebP 双轨分发**: 笔记内保留原始无损文件，公开博客分发使用 Sharp 动态转码与智能水印。

### 📄 许可证
[MIT License](LICENSE)
