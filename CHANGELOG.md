# Changelog (file-master-server)

## [1.0.1] - 2026-11-10

### Storage and batch operations
- Publish uploads atomically through exclusive hard links; compare full SHA-256 before deduplication and preserve existing name collisions.
- Probe storage capabilities at startup and show failures in server logs and the authenticated asset manager.
- Scan catalogs asynchronously, preserve per-file integrity baselines, and offer cancellable original-file verification with downloadable reports.
- Add gallery pagination, thumbnails, bounded/coalesced image generation, and retries for transient upload failures.

### Configuration and update recovery
- Validate prepared configuration before cache invalidation and persist TOTP changes atomically.
- Separate update orchestration, backup/recovery, and Git operations; verify watermark backup checksums.
- Retain unfinished dependency installation across failures and process restarts, including retries against the same commit; only clean recovery state after completion.

### Development
- Run every server test file in its own temporary project through `npm test`.
- Cover update failure stages, offline Git updates, interrupted processes, and the storage capability probe; document test and release workflows.

## [0.1.5] - 2026-10-30
- Require a startup setup token before first-time administrator initialization.
- Set `Secure` on administrator cookies when requests arrive over HTTPS, and reject malformed CSRF origins.
- Restrict multipart requests to a single file and stream file hashing to avoid loading large uploads into memory.
- Preserve the original file if moving it to trash fails, including cross-filesystem moves.
- Escape file and share data rendered in the web console to prevent script injection.

## [0.1.4] - 2026-10-29
- Added **First-Run Web Setup Wizard (`/setup`)** and **Dual-Link Image Optimization Toggle (`enable_optimization`)**.
- Added **📁 Expiring File Share Links (`/s/:shareId`)** module and **☁️ Linux `.tar.gz` Backup & `rclone` Center**.
- Added **Bilingual Web Console (`简体中文` / `English`)** and split console into modular static assets (`src/public/assets/`).
- Hardened security with `scrypt` password hashing, session revocation, header-only API tokens, CSRF protection, sliding-window rate limiting, soft-delete trash (`storage/trash/`), and JSONL audit logging (`data/audit.log`).
- Optimized Linux support with native `sharp` / `heif-convert` / `ffmpeg` transcoding, `/proc/meminfo` metrics, and `Dockerfile` + `docker-compose.yml`.
- Upgraded **One-Click Hot Updates**: locked official upstream repository (`weichen-ink/file-master-server`), added optional GitHub acceleration mirror support (`upstream_mirror`, e.g. `https://ghproxy.net/`), and streamlined one-click updates without redundant password prompts.
