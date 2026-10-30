# Security Policy & Deployment Guidelines

## 🛡️ Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | ✅ Yes    |
| 0.1.x   | ✅ Yes    |

## 🔒 Built-in Security Architecture

1. **First-Run Web Setup Wizard (`/setup`) & `scrypt` Hashing**
   - No default plaintext credentials are tracked in Git.
   - Passwords are salted and hashed using `crypto.scryptSync` with constant-time verification (`crypto.timingSafeEqual`).
   - Once `config.yaml` is initialized, `/setup` and `/api/platform/setup*` endpoints permanently return `403 Forbidden`.

2. **Session Management & Explicit Revocation**
   - Admin sessions use HMAC-SHA256 signed `HttpOnly; SameSite=Lax` cookies.
   - Logging out immediately records the session token in `data/revoked_sessions.json` to invalidate the token server-side.

3. **Header-Only API Token & CSRF Protection**
   - API tokens are accepted strictly via `Authorization: Bearer <token>` or `X-API-Token` headers. Passing tokens in URL query strings (`?token=`) is rejected to prevent credential leakage in access logs and browser history.
   - State-changing requests (`POST`, `PUT`, `DELETE`, `PATCH`) validate `Origin` against `Host`.

4. **Brute-Force Lockout & Sliding-Window Rate Limiting**
   - Login and upload endpoints are guarded by per-IP sliding-window rate limiters.
   - Consecutive failed authentication attempts exceeding `max_login_attempts` trigger a 24-hour IP ban persisted in `data/ip_bans.json`.

5. **Safe Attachment Delivery & Path Traversal Prevention**
   - All file operations validate segment format and verify `isPathWithin(targetPath, baseDir)` after `path.resolve`.
   - Served assets include `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. Non-media files force `Content-Disposition: attachment`.

## 🌐 Production Linux Deployment Recommendations

- Place **Nginx** or **Caddy** with HTTPS (TLS) in front of `file-master-server`.
- Keep `trust_proxy: loopback` when your reverse proxy runs on the same Linux host.
- Keep `hot_update: false` in production unless online Git updates are explicitly needed (requires secondary administrator password verification when enabled).

## 📬 Reporting a Vulnerability

If you discover a security vulnerability, please open a security advisory or contact the maintainer via GitHub (`https://github.com/weichen-ink`) before disclosing it publicly.
