# File Master Server

**A lightweight, self-hosted file and attachment server**: manage files, create expiring shares, process media on demand, schedule low-overhead backups, and monitor health—standalone or paired with the [Obsidian File Master plugin](https://github.com/weichen-ink/file-master) and PicList.

[简体中文](README.zh-CN.md) · **English** · [Obsidian Plugin](https://github.com/weichen-ink/file-master) · [Changelog](CHANGELOG.md)

---

## Why File Master Server?

Instead of relying on third-party image hosts or heavy cloud suites, File Master Server gives you a **clean, self-owned file backend built for long-term maintenance**:
- **You own your files**: originals stay organized by year/month on disk without lock-in or heavy external databases.
- **Non-destructive media processing**: WebP variants and watermarks are generated and cached separately—originals in `storage/raw/` stay untouched.
- **Graceful file renames**: renaming a file keeps an alias grace period for old URLs so published blog posts don't immediately 404.
- **Built-in operations**: low-CPU scheduled backups, `rclone` sync, Bark notifications, recycle bin recovery, and a configurable `/api/health` endpoint come out of the box.

---

## Core Capabilities

- **File Library & Browser**: filter by directory, type, search query, and sort by date, name, size, or views; switch between grid and list views with zoomable previews.
- **Media Processing (Compression + Adaptive Watermarks)**: automatic WebP conversion, max-width resizing, and image/text/tiled watermarks with auto-contrast and live console preview.
- **Safety & Deduplication**: SHA-256 deduplication on upload, file lock protection, safe renames with URL alias grace periods, and a recycle bin for accidental deletions.
- **Expiring Shares**: generate share links with custom expiration dates and download limits, revocable anytime.
- **Operations & Monitoring**: runtime status overview, CPU-throttled `.tar.gz` backups (with `rclone` sync and Bark alerts), one-click updates, and a read-only `/api/health` endpoint.
- **Themes & Languages**: English and Simplified Chinese UI with light, dark, and system theme support.

---

## Deployment

### Option 1: Docker Compose (Recommended)

```bash
git clone https://github.com/weichen-ink/file-master-server.git
cd file-master-server
docker compose up -d --build
```

Open `http://localhost:3210/setup` (replace `localhost` with your server address for remote deployments) to finish initial setup.

> After setup, follow the [deployment guide](docs/DEPLOYMENT.md#english) to persist your configuration and storage volumes across container updates.

### Option 2: Node.js

Requires **Node.js 18** or later:

```bash
git clone https://github.com/weichen-ink/file-master-server.git
cd file-master-server
npm ci
npm start
```

Open `http://localhost:3210/setup` to finish setup.

### Option 3: Background Service with PM2

For Node.js deployments that stay running after closing your terminal (run inside the project directory after `npm ci`; stop `npm start` with `Ctrl+C` first if running):

```bash
npm install -g pm2
npm run pm2
pm2 save
```

The PM2 process name is `fms` on port `3210`. Run `pm2 startup` and follow its instructions to enable auto-start on reboot.

| Action | Command |
| --- | --- |
| Check status | `pm2 status fms` |
| View logs | `pm2 logs fms` |
| Restart | `pm2 restart fms` |
| Stop | `pm2 stop fms` |

> [!TIP]
> **Chinese Text Watermarks on Linux**: If you render Chinese text watermarks on a Linux VPS, install CJK fonts to avoid tofu boxes: `sudo apt-get install -y fonts-noto-cjk fonts-wqy-zenhei fontconfig` (or equivalent for your distro). Containers built from the included `Dockerfile` ship with CJK fonts pre-installed.

---

## Quick Start

1. Open the admin console (default `/admin`) to upload, browse, and share files.
2. To connect **Obsidian File Master** or **PicList**, copy your site URL and API token from **Settings → Site settings** (HTTPS is recommended for public deployments).
3. This is version **1.2.0**; when connecting Obsidian, use plugin version **1.1 or later** (**1.2.0+** recommended).

---

## External Monitoring (`/api/health`)

In **Site settings → Monitoring**, enable the endpoint, select the groups you want to expose, and save. Copy the endpoint URL into Uptime Kuma or any monitoring tool (no auth required; only selected groups are exposed, and you can preview the JSON in settings):

```bash
curl https://your-site.example/api/health
```

- **Available groups**: service status, CPU & memory, storage usage, file counts, and backup status.
- **Status codes**: `200` when available, `503` when core storage is unavailable, and `404` when the endpoint is disabled.
- **Polling**: recommended every 30–60s (resources refresh at most every 15s, backup status every 5s, storage/file counts every 60s; unreadable groups report `status: "unknown"`).
- Set `language: en` or `language: zh` in `config.yaml` to control startup terminal log language independently from browser UI language.

---

[Changelog](CHANGELOG.md) · [Report an issue](https://github.com/weichen-ink/file-master-server/issues) · [MIT license](LICENSE)
