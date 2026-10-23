# ⚡ FileMaster Server

> **Version**: v0.1.0  
> **Companion Client**: [FileMaster (Obsidian Plugin)](../file-master)  
> **Engineering Principles**: KISS (Keep It Simple, Stupid) · Zero External Database · Minimalist & Fast · Dual-Track Media Delivery

**FileMaster Server** is a lightweight, self-hosted asset backend and image hosting service tailored specifically for the **FileMaster** client suite. It can also operate as a standalone, secure media hub for PicList, Astro static blogs, CLI workflows, and markdown note-taking tools.

---

## 🧭 Architectural Highlights

1. **Zero External Database Overhead**  
   All configuration is managed directly in `config.yaml` with hot-reloading support and an in-browser visual editor. Structured state is stored atomically in standard JSON files (`data/`), and physical binaries are neatly organized into chronological directories (`storage/raw/YYYY/MM/`), making backups as simple as zipping a single folder.

2. **Three-Layer Security Defense**  
   - **Stealth Entry Point**: Standard routes (`/`, `/admin`, `/login`) immediately return plain-text `404 Not Found`. Access to the management dashboard requires your secret custom URL (e.g., `http://localhost:3000/panel-9x7k2m`).
   - **Memory-Level Brute-Force Circuit Breaker**: Exceeding failed credential attempts (default: 3) triggers an automatic 24-hour IP ban.
   - **Optional 2FA (TOTP)**: Built-in support for RFC 6238 two-factor authentication (Google Authenticator, 1Password).

3. **Dual-Track Asset Routing**  
   - **Internal / Private Vaults**: Access lossless originals through obfuscated secret URL paths (e.g., `/raw-8f9a2b/2026/10/file.png`), keeping assets protected from public crawler indexing.
   - **Public Static Blogs (Astro, VitePress, Hugo)**: Requesting `/pub/2026/10/file.webp` dynamically triggers `sharp` image optimization, converts to lightweight WebP, and stamps an adaptive text/PNG watermark cached directly in `storage/cache/`.

4. **Native Deduplication & Protection APIs**  
   Built-in SHA-256 cross-client deduplication, orphan attachment discovery, and single-file `Protected Lock` flags to prevent accidental file deletion.

---

## 🚀 Quick Start

### Prerequisites
- **Node.js** >= 18.0.0
- **npm** >= 9.0.0

### Running Locally or on a VPS

```bash
# 1. Install dependencies
npm install

# 2. Start the service (Production)
npm start

# Or start in watch mode (Development)
npm run dev
```

Once started, open your secret management URL in your browser:  
`http://localhost:3000/panel-9x7k2m`

- **Default Username**: `admin`
- **Default Password**: `admin-password-123`
- **Default API Token**: `filemaster-api-token-888`

> ⚠️ **Important Security Notice**: Update your `admin_path`, `password`, and `api_token` in `config.yaml` or through the web dashboard immediately after your first startup!

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
    client_max_body_size 50M;

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

# Security & Authentication
admin_path: panel-9x7k2m        # Obfuscated admin path
username: admin                 # Management username
password: admin-password-123    # Strong admin password
max_login_attempts: 3           # Lockout threshold before 24h ban
totp_secret: ""                 # 2FA base32 secret (leave blank to disable)
api_token: filemaster-api-token-888 # API Token for client integrations

# Image Host & Watermark Engine
image_host:
  raw_secret_path: raw-8f9a2b   # Obfuscated prefix for raw assets
  webp_quality: 82              # WebP compression quality (1-100)
  max_width: 1920               # Max width constraint (0 for unlimited)
  watermark_enable: true        # Enable dynamic watermark
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
| `POST` | `/api/image/upload` | Upload single file (multipart form `file`) | API Token / Session |
| `GET` | `/pub/:year/:month/:file` | Fetch public WebP / stream attachment | Public |
| `GET` | `/:rawSecret/:year/:month/:file` | Fetch lossless original | Public (Obfuscated) |
| `GET` | `/api/modules/image-host/list` | Fetch all assets and storage metrics | API Token / Session |
| `POST` | `/api/modules/image-host/lock` | Toggle single file deletion lock | API Token / Session |
| `DELETE` | `/api/modules/image-host/item/:y/:m/:f`| Delete asset and associated cache | API Token / Session |
| `POST` | `/api/modules/image-host/orphans` | Discover or batch-clean orphan files | API Token / Session |
| `POST` | `/api/modules/image-host/cache/clear` | Purge all cached WebP derived images | API Token / Session |

---

## 📄 License

[MIT License](LICENSE)
