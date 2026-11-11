# File Master Server

A self-hosted home for your images, attachments, and shared links.

[简体中文](README.zh-CN.md) · **English** · [Obsidian plugin](https://github.com/weichen-ink/file-master)

## Features

- **File management**: upload, search, browse by date, and switch between grid and list views.
- **Image previews**: zoom, pan, and copy original, WebP, or Markdown links.
- **Image optimization**: compress, resize, and watermark images while keeping originals.
- **Sharing and trash**: create expiring shares and restore accidentally deleted files.
- **Server management**: view resource use, schedule and download backups, and install updates.

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

## Start using it

Enter the console from the homepage (default: `/admin`) to upload and manage files. To connect a client, use the site URL and upload API token from Site settings. Use HTTPS for public access.

This is version **1.1**. Connecting Obsidian requires plugin **1.1 or later**. Before updating, save a full backup in Backup & recovery.

[Changelog](CHANGELOG.md) · [Report an issue](https://github.com/weichen-ink/file-master-server/issues) · [MIT license](LICENSE)
