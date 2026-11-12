# Security policy

Security fixes target the latest 1.1.x release. Update both the server and the File Master plugin before reporting an issue.

## Deployment

- Complete the first-run setup before exposing the server publicly. Setup does not require an installation token; whoever reaches an unconfigured server first can create its administrator account. After setup, the setup API returns 403 and the setup page redirects to the home page.
- Use HTTPS through Caddy, Nginx, or another reverse proxy. Keep `trust_proxy: loopback` when the proxy runs on the same host.
- Keep passwords, API tokens, `config.yaml`, and the `data` directory private. Full backups include configuration and session security data; protect them like the running server's credentials.
- Online updates require administrator access. Downloaded commits are checked against the full commit ID returned by GitHub's official HTTPS API, including when a mirror is used. If GitHub cannot be reached or the IDs differ, the update stops. Installation does not ask for a second password. You can disable online updates with `hot_update: false`.

## Access and files

Administrator passwords use salted scrypt hashes. Sessions use signed, HttpOnly, SameSite cookies; logout revokes the session on the server. API tokens belong in `Authorization: Bearer …` or `X-API-Token` headers, never in URLs. Failed login attempts and invalid supplied API tokens are limited; anonymous requests do not count as failed authentication.

Public attachment URLs, custom link prefixes, and the legacy `/pub/` route are public delivery mechanisms, not access controls. Image optimization and watermark options do not provide protection against copying original files. The optional `/api/health` endpoint is public when enabled; its output follows the fields selected in settings.

Renames preserve old links for the configured retention period. After that period, the old name can be reused. Direct gallery deletion moves a file to the recycle bin and can break existing references; the plugin's duplicate merge checks content and references before deleting a redundant copy.

Unreadable or invalid critical state stops the affected operation instead of silently resetting locks, hashes, shares, or session state. Delete and restore operations record a recoverable intent before moving files. If recovery detects changed bytes or conflicting files, it stops and preserves the remaining data for inspection. These checks do not replace backups; run one server process per storage directory and avoid editing storage or state files during file operations.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/weichen-ink/file-master-server/security/advisories/new) or contact [the maintainer](https://github.com/weichen-ink) before publishing sensitive details.
