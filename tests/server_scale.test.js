const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('Isolated 1,000-image catalog: async scans, metrics, duplicate deletion, and durable integrity baselines', () => {
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-scale-'));
  try {
    fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true });
    for (const name of ['package.json', 'config.example.yaml']) fs.copyFileSync(path.join(root, name), path.join(dir, name));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const script = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const sharp = require('sharp');
      const crypto = require('node:crypto');
      const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
      const express = require('express');
      // Host uptime may be denied by a desktop sandbox; it is unrelated to storage metrics.
      require('node:os').uptime = () => 123;
      const { getConfig, STORAGE_DIR } = require('./src/core/config');
      const { scanAllImages, registerImageHostModule } = require('./src/modules/image-host');
      (async () => {
        const folder = path.join(STORAGE_DIR, 'raw', '2026', '11');
        fs.mkdirSync(folder, { recursive: true });
        const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#456789' } }).png().toBuffer();
        for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(folder, 'asset-' + i + '.png'), Buffer.concat([image, Buffer.from(String(i))]));
        const app = express();
        registerImageHostModule(app);
        const invoke = async (method, route, req = {}) => {
          const layer = app._router.stack.find((l) => l.route?.path === route && l.route.methods[method]);
          const res = { code: 200, status(c) { this.code = c; return this; }, json(data) { this.data = data; return this; }, setHeader() {} };
          await layer.route.stack.at(-1).handle(req, res);
          return res;
        };
        const lag = monitorEventLoopDelay({ resolution: 10 });
        lag.enable();
        let ticks = 0;
        const timer = setInterval(() => ticks++, 1);
        const start = performance.now();
        const cold = await scanAllImages(getConfig());
        const coldMs = Math.round(performance.now() - start);
        const warmStart = performance.now();
        assert.equal(await scanAllImages(getConfig()), cold);
        const warmMs = Math.round(performance.now() - warmStart);
        clearInterval(timer);
        lag.disable();
        assert.equal(cold.images.length, 1000);
        assert.ok(ticks > 0, 'catalog scanning must yield to the event loop');
        const metrics = await require('./src/core/metrics').collectRuntimeMetrics();
        assert.equal(metrics.site.storage.imageCount, 1000);
        fs.copyFileSync(path.join(folder, 'asset-0.png'), path.join(folder, 'twin.png'));
        await scanAllImages(getConfig(), true);
        const deleted = await invoke('delete', '/api/modules/image-host/item/:year/:month/:filename', {
          params: { year: '2026', month: '11', filename: 'twin.png' }, headers: {}, socket: {}
        });
        assert.equal(deleted.data.success, true);
        const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, 'asset-0.png'))).digest('hex');
        const probe = await invoke('get', '/api/image/probe', { query: { sha256: sha } });
        assert.equal(probe.data.exists, true, 'deleting one duplicate must preserve lookup of the remaining copy');
        fs.writeFileSync(path.join(folder, 'asset-1.png'), 'tampered');
        const originalThree = fs.readFileSync(path.join(folder, 'asset-3.png'));
        const threeSha = crypto.createHash('sha256').update(originalThree).digest('hex');
        const twoSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, 'asset-2.png'))).digest('hex');
        fs.unlinkSync(path.join(folder, 'asset-2.png'));
        fs.writeFileSync(path.join(folder, 'asset-3.png'), 'also tampered');
        const missingProbe = await invoke('get', '/api/image/probe', { query: { sha256: twoSha } });
        assert.equal(missingProbe.data.exists, false);
        const corruptProbe = await invoke('get', '/api/image/probe', { query: { sha256: threeSha } });
        assert.equal(corruptProbe.data.exists, false);
        const uploaded = await invoke('post', '/api/image/upload', {
          file: { buffer: originalThree }, headers: { 'x-file-name': 'asset-3.png' }, socket: {}
        });
        assert.equal(uploaded.data.success, true);
        assert.equal(uploaded.data.deduplicated, false);
        assert.notEqual(path.join(STORAGE_DIR, 'raw', uploaded.data.year, uploaded.data.month, uploaded.data.filename),
          path.join(folder, 'asset-3.png'));
        assert.equal(fs.readFileSync(path.join(folder, 'asset-3.png'), 'utf8'), 'also tampered');
        await scanAllImages(getConfig(), true);
        const started = await invoke('post', '/api/modules/image-host/integrity');
        while (started.data.state === 'running') await new Promise((resolve) => setTimeout(resolve, 1));
        assert.equal(started.data.state, 'completed');
        assert.ok(started.data.issues.some((i) => i.path === '2026/11/asset-1.png' && i.type === 'mismatch'));
        assert.ok(started.data.issues.some((i) => i.path === '2026/11/asset-2.png' && i.type === 'missing'));
        assert.ok(started.data.issues.some((i) => i.path === '2026/11/asset-3.png' && i.type === 'mismatch'),
          'probe/upload must preserve the original baseline when the indexed file is corrupt');
        console.log(JSON.stringify({ images: 1000, coldMs, warmMs, eventLoopTicks: ticks, eventLoopP95Ms: Math.round(lag.percentile(95) / 1e6) }));
        process.exit(0);
      })().catch((err) => { console.error(err); process.exit(1); });
    `;
    const output = execFileSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.match(output, /"images":1000/);
    console.log('Scale fixture:', output.trim());
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'sha_index.json'), 'utf8'));
    assert.equal(saved.version, 2);
    assert.notEqual(saved.files['2026/11/asset-1.png'].sha256, saved.files['2026/11/asset-1.png'].baselineSha256);
    const restarted = execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const express = require('express');
      const { registerImageHostModule } = require('./src/modules/image-host');
      const app = express(); registerImageHostModule(app);
      const layer = app._router.stack.find((l) => l.route?.path === '/api/modules/image-host/integrity' && l.route.methods.post);
      let job;
      layer.route.stack.at(-1).handle({}, { status() { return this; }, json(value) { job = value; } });
      const timer = setInterval(() => {
        if (job.state === 'running') return;
        clearInterval(timer);
        assert.ok(job.issues.some((i) => i.type === 'mismatch' && i.path.endsWith('asset-1.png')));
        assert.ok(job.issues.some((i) => i.type === 'mismatch' && i.path.endsWith('asset-3.png')));
        assert.ok(job.issues.some((i) => i.type === 'missing' && i.path.endsWith('asset-2.png')));
        console.log('baseline survived restart'); process.exit(0);
      }, 5);
    `], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.match(restarted, /baseline survived restart/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
