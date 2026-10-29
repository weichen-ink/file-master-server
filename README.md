# ⚡ FileMaster Server

> **Version**: v0.1.0  
> **Companion Client**: [FileMaster (Obsidian Plugin)](../file-master)  
> **Engineering Principles**: KISS (Keep It Simple, Stupid) · Zero External Database · Minimalist & Fast · Dual-Link Media Delivery

**FileMaster Server** is a lightweight, self-hosted asset backend and image hosting service tailored specifically for the **FileMaster** client suite. It can also operate as a standalone, secure media hub for PicList, Astro static blogs, CLI workflows, and markdown note-taking tools.

---

## 🧭 Architectural Highlights

1. **Zero External Database Overhead & Interactive Setup Wizard**  
   - **First-Run Web Setup Wizard (`/setup`)**: When starting without `config.yaml`, any visit automatically redirects to `/setup`, allowing you to configure your administrator account (with a 1-click random password generator or custom password), API token, and image optimization settings in seconds. Once initialized, `/setup` is permanently locked.
   - All configuration is managed directly in `config.yaml` with hot-reloading support and an in-browser visual editor. Structured state is stored atomically in standard JSON files (`data/`), and physical binaries are neatly organized into chronological directories (`storage/raw/YYYY/MM/`).

2. **Multi-Layer Security Defense**  
   - **`scrypt` Password Hashing & Session Revocation**: Passwords are stored salted and hashed with `scrypt`. Explicit logout immediately revokes the session token.
   - **Brute-Force Circuit Breaker & Rate Limiting**: Sliding-window rate limiting plus persistent IP ban tracking (`data/ip_bans.json`) after consecutive login failures.
   - **Optional 2FA (TOTP)**: Built-in support for RFC 6238 two-factor authentication (Google Authenticator, 1Password).
   - **Header-Only API Token & CSRF Protection**: API tokens are strictly validated via `Authorization: Bearer` or `X-API-Token` headers (never leaked in URL query strings).

3. **Dual-Link Image Host Architecture (`Raw Original` + `Optimized WebP`)**  
   - **📎 Raw Original Link (`/:raw_secret_path/YYYY/MM/file.ext`)**: Serves the unmodified original asset uploaded by the user. Always available with a dedicated copy button on every asset card.
   - **⚡ Optimized WebP Link (`/pub/YYYY/MM/file.webp`)**: Controlled by `image_host.enable_optimization` (`true | false`). When enabled, image cards display a second **`⚡ 复制优化链接`** button that serves on-the-fly `sharp` WebP compression and adaptive watermarking cached in `storage/cache/`. When disabled, only the raw original link button is shown.

4. **Native Deduplication, Trash Retention & Audit Logs**  
   - Built-in SHA-256 cross-client deduplication (`data/sha_index.json`), single-file `Protected Lock` flags (`data/protected_files.json`), soft-delete trash retention (`storage/trash/YYYY-MM-DD/`), and automatic JSON Lines audit logs (`data/audit.log` with 10MB rotation).

---

## 🚀 Quick Start

### Option A: Running Locally or on a VPS (Node.js >= 18)

```bash
# 1. Install dependencies
npm install

# 2. Start the service (Production)
npm start

# Or start in watch mode (Development)
npm run dev
```

On first launch (when `config.yaml` does not exist), open your browser and visit:  
`http://localhost:3000/setup`

Complete the interactive setup wizard to generate `config.yaml` and automatically sign in to your Admin Console (`http://localhost:3000/admin` by default).

### Option B: Docker & Docker Compose

```bash
# Build and start in background
docker compose up -d --build
```

Persistent volumes (`./storage` and `./data`) are mounted automatically. Visit `http://localhost:3000/setup` on first launch to initialize your instance.

---

### Production Deployment with PM2

```bash
npm install -g pm2
pm2 start src/server.js --name filemaster-server
pm2 save && pm2 startup
```

### Nginx Reverse Proxy Configuration Example

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

# Upstream Git Repository (Optional: requires hot_update: true + secondary password confirmation)
hot_update: false
upstream_repo: https://github.com/weichen-ink/file-master-server.git
upstream_branch: main

# Security & Authentication
admin_path: admin               # Admin console path (e.g. /admin)
username: admin                 # Management username
password: scrypt:...            # Auto-hashed with scrypt
max_login_attempts: 5           # Lockout threshold before 24h ban
totp_secret: ""                 # 2FA base32 secret (leave blank to disable)
api_token: fm_...               # API Token for Obsidian / PicList client integrations

# Image Host & Watermark Engine
image_host:
  raw_secret_path: raw          # Route prefix for raw original files (/raw/YYYY/MM/file.ext)
  enable_optimization: true     # Enable Optimized WebP + Watermark link & second copy button
  webp_quality: 82              # WebP compression quality (1-100)
  max_width: 1920               # Max width constraint (0 for unlimited)
  watermark_enable: true        # Enable dynamic watermark on optimized link
  watermark_type: image         # image | text | tile
  watermark_pos: bottom-right   # bottom-right | bottom-left | top-right | top-left | center
  watermark_opacity: 0.65       # Watermark transparency (0.1 - 1.0)
  watermark_scale: 0.16         # Proportional scale (16% of image width)
  watermark_margin: 24          # Border padding in pixels
  watermark_min_width: 320      # Minimum image width to apply watermark
  watermark_image: ./watermark.png
  watermark_text: "© FileMaster"
  watermark_color: "#ffffff"
```

---

## 🔌 API Endpoints Summary

| Method | Route | Description | Auth |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/platform/version` | Public version & feature contract | Public |
| `GET/POST` | `/api/platform/setup` | First-time Web Setup Wizard (locked after init) | Public (First Run Only) |
| `POST` | `/api/image/upload` | Upload single file (streaming multipart `file`) | Header API Token / Session |
| `GET` | `/:rawSecret/:year/:month/:file` | Fetch lossless original asset | Public |
| `GET` | `/pub/:year/:month/:file` | Fetch optimized WebP / watermarked image | Public (When Optimization On) |
| `GET` | `/api/modules/image-host/list` | Fetch all assets and storage metrics | Header API Token / Session |
| `POST` | `/api/modules/image-host/lock` | Toggle single file deletion lock | Header API Token / Session |
| `DELETE` | `/api/modules/image-host/item/:y/:m/:f`| Soft-delete asset to `storage/trash/` & purge cache | Header API Token / Session |
| `POST` | `/api/modules/image-host/cache/clear` | Purge all cached WebP derived images | Header API Token / Session |
| `GET` | `/api/platform/update/status` | Check local & upstream Git commit status | Session |
| `POST` | `/api/platform/update/pull` | Pull upstream repo (requires password confirmation) | Session |
| `POST` | `/api/platform/restart` | Gracefully restart the server process | Session |

---

## 🧪 Automated Testing

```bash
npm test
```

## 📄 License

[MIT License](LICENSE)
