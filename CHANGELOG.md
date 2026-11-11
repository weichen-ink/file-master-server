# Changelog (file-master-server)

## [1.1.2] - 2026-11-11

### Maintenance
- Align platform version to 1.1.2.

## [1.1.1] - 2026-11-11

### Internationalization and logging
- Default startup banner and console output to English, switching to Chinese only when configured with `language: "zh"`.
- Align platform contract versioning to semantic 1.1.1.

## [1.1.0] - 2026-11-11

### Web console and navigation
- Reorganize navigation around file management and system settings, with compact utility icons for theme, language, GitHub, and sign out.
- Refine the site identity and minimal homepage footer, including the repository link and a dynamically generated year.
- Add light, dark, and system appearance preferences backed by shared theme variables.
- Replace the monolithic console with focused routing, API, state, translation, feature, and UI modules.

### File browsing and previews
- Unify file, share, and recycle-bin collections with consistent columns, thumbnails, action placement, and responsive layouts.
- Present time archives as a vertical year/month hierarchy and expose time, size, and name sorting as direct buttons.
- Add configurable file-card copying, compact original/WebP link rows, and simpler file-location breadcrumbs.
- Support image zoom presets, wheel zoom, dragging at every scale, and a larger preview dialog with backdrop dismissal.
- Limit drag-and-drop uploading to the explicitly opened upload flow; show maintenance progress in dialogs instead of a separate task center.
- Add authenticated recycle-bin previews for both the web console and plugin.

### Settings and operations
- Consolidate site addresses, account access, upload tokens, and copy preferences; simplify client setup to a focused PicList page.
- Group compression and watermark settings under Image optimization, with a live preview for watermark changes.
- Replace service-information clutter with CPU, memory, disk usage, automatic refresh, and service restart controls.
- Improve backup scheduling with timezone and next-run information, archive listing and downloads, and inline destination tests.
- Publish completed backup archives atomically and exclude incomplete archives and symbolic links from download listings.
- Group update identity, proxy options, and checking controls together; render incoming commit titles and bodies as update cards.
- Install updates directly from the action button without a second confirmation, retaining execution progress and recovery behavior.
- Simplify configuration editing, keep credentials outside the YAML editor, and detect conflicting configuration revisions before applying changes.
- Remove the retired two-factor authentication feature and its configuration, API, UI, and documentation references.

### Documentation and compatibility
- Rewrite the Chinese and English READMEs around installation, everyday use, compatibility, backups, and troubleshooting.
- Keep setup instructions focused on everyday use and document Docker configuration persistence.
- Set the server version and minimum supported plugin version to 1.1.
- Validate with 113 isolated server tests and responsive browser checks. Mobile Obsidian device testing remains a separate release check.

## [1.0.1] - 2026-11-10

### Storage and batch operations
- Publish uploads atomically through exclusive hard links; compare full SHA-256 before deduplication and preserve existing name collisions.
- Probe storage capabilities at startup and show failures in server logs and the authenticated asset manager.
- Scan catalogs asynchronously, preserve per-file integrity baselines, and offer cancellable original-file verification with downloadable reports.
- Add gallery pagination, thumbnails, bounded/coalesced image generation, and retries for transient upload failures.

### Configuration and update recovery
- Validate prepared configuration before cache invalidation and persist credential changes atomically.
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
