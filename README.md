# File Master Server

A self-hosted home for your images, attachments, and shared links.

[简体中文](README.zh-CN.md) · **English** · [Obsidian plugin](https://github.com/weichen-ink/file-master)

## Features

- **File management**: upload, search, browse by date, and switch between grid and list views.
- **Image previews**: zoom, pan, and copy original, WebP, or Markdown links.
- **Image optimization**: compress, resize, and watermark images while keeping originals.
- **Sharing and trash**: create expiring shares and restore accidentally deleted files.
- **Server management**: view resource use, schedule and download backups, and install updates.
- **Monitoring**: connect monitoring tools to a read-only JSON endpoint and choose which statistics to share.

Use it on its own or connect Obsidian or PicList. Supports Chinese and English, with light, dark, and system themes.

## Deploy

### Docker Compose

```bash
git clone https://github.com/weichen-ink/file-master-server.git
cd file-master-server
docker compose up -d --build
```

Open `http://localhost:3210/setup` to set up your site and administrator account. For a remote deployment, replace `localhost` with your server address.

After setup, follow the [deployment guide](docs/DEPLOYMENT.md#english) to save and mount your site configuration. Keep your files and configuration when updating the container.

### Node.js

Requires Node.js 18 or later.

```bash
git clone https://github.com/weichen-ink/file-master-server.git
cd file-master-server
npm ci
npm start
```

Open `http://localhost:3210/setup` to finish setup.

### Run in the background with PM2

Use PM2 to keep a Node.js deployment running after you close the terminal. After cloning the project and running `npm ci` above, run these commands from the project directory. If `npm start` is already running, stop it with `Ctrl+C` first.

```bash
npm install -g pm2
npm run pm2
pm2 save
```

The service is named `fms` and remains available at `http://localhost:3210`. To start it automatically after a reboot, run `pm2 startup` and follow the command it prints.

| Action | Command |
|---|---|
| Check status | `pm2 status fms` |
| View logs | `pm2 logs fms` |
| Restart | `pm2 restart fms` |
| Stop | `pm2 stop fms` |

> [!TIP]
> **Chinese Text Watermarks on Linux**: If you use Chinese text watermarks on a Linux server or VPS, install CJK fonts to ensure glyph rendering: `sudo apt-get install -y fonts-noto-cjk fonts-wqy-zenhei fontconfig` (or equivalent for your distribution). Docker containers built with the latest Dockerfile include these fonts automatically.

## Start using it

Enter the console from the homepage (default: `/admin`) to upload and manage files. To connect a client, use the site URL and upload API token from Site settings. Use HTTPS for public access.

This is version **1.1**. Connecting Obsidian requires plugin **1.1 or later**. Before updating, save a full backup in Backup & recovery.

## Connect a monitoring tool

In **Site settings → Monitoring**, enable the endpoint, select the information to include, and save. Copy the fixed endpoint URL into your monitoring tool. No login or token is needed; only the selected information is public.

```bash
curl https://your-site.example/api/health
```

When enabled, the server also prints the monitoring URL on startup. Set `language: en` or `language: zh` in `config.yaml` to choose the startup language; the browser language is independent.

Choose service status, CPU and memory, storage usage, file counts, or backup status. Preview JSON in settings before connecting. HTTP `200` means the service is available; `503` means its core storage is unavailable. Check JSON `status` and `warnings` for issues such as a failed backup. Backup states distinguish disabled, never run, running, successful, partially successful, and failed backups.

Poll every 30–60 seconds. Resources refresh at most every 15 seconds, backup status every 5 seconds, and storage/file statistics every 60 seconds; `collectedAt` shows when each snapshot was taken. CPU and memory reflect what the server operating system exposes. Unavailable groups return `status: "unknown"`; they are never reported as zero usage. Disabling the endpoint returns `404`. Use HTTPS for remote monitoring.

[Changelog](CHANGELOG.md) · [Report an issue](https://github.com/weichen-ink/file-master-server/issues) · [MIT license](LICENSE)
