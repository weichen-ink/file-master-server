# Changelog (file-master-server)

See root `CHANGELOG.md` for full ecosystem release notes.

## [0.2.0] - 2026-10-29
- Added **First-Run Web Setup Wizard (`/setup`)** and **Dual-Link Image Optimization Toggle (`enable_optimization`)**.
- Added **📁 Expiring File Share Links (`/s/:shareId`)** module and **☁️ Linux `.tar.gz` Backup & `rclone` Center**.
- Added **Bilingual Web Console (`简体中文` / `English`)** and split console into modular static assets (`src/public/assets/`).
- Hardened security with `scrypt` password hashing, session revocation, header-only API tokens, CSRF protection, sliding-window rate limiting, soft-delete trash (`storage/trash/`), and JSONL audit logging (`data/audit.log`).
- Optimized Linux support with native `sharp` / `heif-convert` / `ffmpeg` transcoding, `/proc/meminfo` metrics, and `Dockerfile` + `docker-compose.yml`.
- Upgraded **One-Click Hot Updates**: locked official upstream repository (`weichen-ink/file-master-server`), added optional GitHub acceleration mirror support (`upstream_mirror`, e.g. `https://ghproxy.net/`), and streamlined one-click updates without redundant password prompts.
