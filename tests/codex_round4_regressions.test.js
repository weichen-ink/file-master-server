const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');

assert.equal(
  process.env.FILE_MASTER_TEST_ROOT,
  fs.realpathSync(path.resolve(__dirname, '..')),
  'Run npm test: regression tests require an isolated project'
);

/** Minimal DOM harness tailored for mountFiles() interactive state & archive tests. */
function createFilesDomHarness() {
  const makeNode = (tag = 'div', attrs = {}) => {
    const listeners = new Map();
    const classes = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
    const dataset = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        dataset[camel] = v;
      }
    }
    let html = '';
    const children = [];
    const node = {
      tagName: tag.toUpperCase(),
      id: attrs.id || '',
      value: attrs.value ?? '',
      open: 'open' in attrs,
      disabled: 'disabled' in attrs,
      hidden: false,
      textContent: '',
      dataset,
      attributes: { ...attrs },
      parentElement: null,
      isConnected: true,
      children,
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        contains: (n) => classes.has(n)
      },
      get className() {
        return [...classes].join(' ');
      },
      set className(val) {
        classes.clear();
        String(val || '').split(/\s+/).filter(Boolean).forEach((n) => classes.add(n));
      },
      getAttribute(name) {
        if (name === 'open') return node.open ? '' : null;
        return name in node.attributes ? node.attributes[name] : null;
      },
      setAttribute(name, val) {
        node.attributes[name] = String(val);
        if (name === 'open') node.open = true;
      },
      append(child) {
        child.parentElement = node;
        children.push(child);
      },
      contains(target) {
        let cur = target;
        while (cur) {
          if (cur === node) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      closest(selector) {
        let cur = node;
        while (cur) {
          if (matchesSelector(cur, selector)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      focus() {},
      addEventListener(type, fn, opts) {
        if (opts?.signal?.aborted) return;
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => listeners.get(type)?.delete(fn), { once: true });
        }
      },
      async dispatch(type, extra = {}) {
        const event = {
          type,
          target: extra.target || node,
          preventDefault() {},
          stopPropagation() {},
          ...extra
        };
        const fns = [...(listeners.get(type) || [])];
        for (const fn of fns) {
          await fn(event);
        }
      },
      setRawHtml(val) {
        html = String(val ?? '');
      },
      get innerHTML() {
        return html;
      },
      set innerHTML(val) {
        html = String(val ?? '');
        rebuildSubtree(node, html);
      },
      querySelector(sel) {
        return queryAll(node, sel)[0] || null;
      },
      querySelectorAll(sel) {
        return queryAll(node, sel);
      }
    };
    return node;
  };

  function parseAttrs(raw) {
    const attrs = {};
    const re = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
    let m;
    while ((m = re.exec(raw))) {
      attrs[m[1]] = m[2] !== undefined ? m[2] : '';
    }
    return attrs;
  }

  function matchesSingle(el, token) {
    if (!token) return false;
    if (token === '[data-action]') return 'action' in el.dataset;
    const dataYearMatch = token.match(/^\.([a-zA-Z0-9_-]+)\[data-year\]$/);
    if (dataYearMatch) return el.classList.contains(dataYearMatch[1]) && 'year' in el.dataset;
    const actionMatch = token.match(/^\[data-action="([^"]+)"\]$/);
    if (actionMatch) return el.dataset.action === actionMatch[1];
    if (token.startsWith('#')) return el.id === token.slice(1);
    if (token.startsWith('.')) return el.classList.contains(token.slice(1));
    return el.tagName === token.toUpperCase();
  }

  function matchesSelector(el, selector) {
    return selector.split(',').some((part) => {
      const steps = part.trim().split(/\s+/);
      let cur = el;
      for (let i = steps.length - 1; i >= 0; i--) {
        if (!cur) return false;
        if (i === steps.length - 1) {
          if (!matchesSingle(cur, steps[i])) return false;
          cur = cur.parentElement;
        } else {
          while (cur && !matchesSingle(cur, steps[i])) cur = cur.parentElement;
          if (!cur) return false;
          cur = cur.parentElement;
        }
      }
      return true;
    });
  }

  function queryAll(rootNode, selector) {
    const out = [];
    const visit = (n) => {
      for (const ch of n.children) {
        if (matchesSelector(ch, selector)) out.push(ch);
        visit(ch);
      }
    };
    visit(rootNode);
    return out;
  }

  function rebuildSubtree(parent, markup) {
    parent.children.length = 0;
    // Parse structural tags needed by mountFiles: aside, details, nav, div, section, input, select, button, a, span
    const tagRe = /<(\/?)(aside|details|nav|div|section|input|select|button|a|span)\b([^>]*)>/gi;
    const voidTags = new Set(['input']);
    const stack = [parent];
    let m;
    while ((m = tagRe.exec(markup))) {
      const [, closing, rawTag, rawAttrs] = m;
      const tag = rawTag.toLowerCase();
      if (closing) {
        while (stack.length > 1 && stack[stack.length - 1].tagName !== tag.toUpperCase()) {
          stack.pop();
        }
        if (stack.length > 1) {
          const closed = stack.pop();
          closed.setRawHtml(markup.slice(closed.openStart, m.index));
        }
      } else {
        const selfClose = voidTags.has(tag) || rawAttrs.trim().endsWith('/');
        const child = makeNode(tag, parseAttrs(rawAttrs));
        child.openStart = tagRe.lastIndex;
        stack[stack.length - 1].append(child);
        if (!selfClose) {
          stack.push(child);
        }
      }
    }
    // Populate raw innerHTML slices on structural containers (e.g. nav, #file-items, .archive-years)
    const setContainerHtml = (n) => {
      for (const ch of n.children) setContainerHtml(ch);
    };
    setContainerHtml(parent);
  }

  const toastEl = makeNode('div', { id: 'toast' });
  const root = makeNode('main', { id: 'main' });
  let currentUrl = '#/files';

  const prevGlobals = {
    window: global.window,
    document: global.document,
    history: global.history,
    location: global.location,
    matchMedia: global.matchMedia
  };

  global.matchMedia = () => ({ matches: false });
  global.history = {
    replaceState(_state, _title, url) {
      currentUrl = url;
    }
  };
  global.location = { hash: '#/files' };
  global.window = {
    scrollY: 0,
    scrollTo() {}
  };
  global.document = {
    activeElement: null,
    body: makeNode('body'),
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => (id === 'toast' ? toastEl : null)
  };

  return {
    root,
    toastEl,
    getUrl: () => currentUrl,
    restore() {
      for (const [k, v] of Object.entries(prevGlobals)) {
        if (v === undefined) delete global[k];
        else global[k] = v;
      }
    }
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('FM-03 & FM-04: mountFiles coordinates concurrent search/refresh/abort and updates archive counts live', async (t) => {
  const dom = createFilesDomHarness();
  t.after(() => dom.restore());

  const { mountFiles } = await import('../src/public/assets/admin/features/files.mjs');
  const { queryCatalog } = require('../src/modules/image-host/catalog-query');

  const makeAsset = (year, month, filename, size = 100) => ({
    year,
    month,
    filename,
    category: 'image',
    isImage: true,
    isProcessableImage: true,
    size,
    createdAt: Date.now(),
    locked: false,
    rawUrl: `/raw/${year}/${month}/${filename}`,
    pubUrl: `/pub/${year}/${month}/${filename}.webp`
  });

  let catalogImages = [
    ...Array.from({ length: 40 }, (_, i) => makeAsset('2026', '11', `nov-${i}.png`)),
    ...Array.from({ length: 24 }, (_, i) => makeAsset('2026', '10', `oct-${i}.png`)),
    makeAsset('2026', '10', 'needle.png'),
    makeAsset('2025', '12', 'legacy.png')
  ];

  const pendingRefresh = deferred();
  const pendingAlphaSearch = deferred();
  let interceptRefreshOnce = false;
  let interceptAlphaOnce = false;

  const syncedCounts = [];
  const ctx = {
    config: { console: { card_copy_format: 'markdown_webp' } },
    status: { storageHealth: { atomicUploads: true } },
    files: { optimizationEnabled: true, bucketCounts: {} },
    loadConfig: async () => {},
    invalidateFiles: () => {},
    syncFileCount: (n) => syncedCounts.push(n),
    api: {
      filesPage: async (params, { signal } = {}) => {
        if (interceptRefreshOnce && params.refresh === '1') {
          interceptRefreshOnce = false;
          return pendingRefresh.promise;
        }
        if (interceptAlphaOnce && params.q === 'alpha') {
          interceptAlphaOnce = false;
          return pendingAlphaSearch.promise;
        }
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        return queryCatalog({ images: catalogImages, optimizationEnabled: true }, params);
      }
    }
  };

  const pageAbort = new AbortController();
  await mountFiles(ctx, dom.root, { page: 'files', query: {} }, pageAbort.signal);

  // Initial mount assertions: 66 files total, archive has 2026 (11, 10) and 2025 (12), no 09
  assert.equal(syncedCounts.at(-1), 66);
  const archiveMarkup = () => decodeURIComponent(dom.root.querySelector('.archive-panel nav').innerHTML);
  assert.ok(archiveMarkup().includes('2026/11'));
  assert.ok(archiveMarkup().includes('2026/10'));
  assert.ok(!archiveMarkup().includes('2026/09'));

  // --- FM-03 Case 1: Slow refresh started BEFORE search('needle'), resolves AFTER search('needle') ---
  interceptRefreshOnce = true;
  const refreshBtn = dom.root.querySelector('[data-action="refresh"]');
  assert.ok(refreshBtn);
  const refreshClickDone = dom.root.dispatch('click', { target: refreshBtn });

  // While refresh is still in-flight, user types 'needle' into #file-search
  const searchInput = dom.root.querySelector('#file-search');
  searchInput.value = 'needle';
  await searchInput.dispatch('input', { target: searchInput });
  await new Promise((r) => setTimeout(r, 240));

  assert.ok(dom.root.querySelector('#file-items').innerHTML.includes('needle.png'));
  assert.ok(!dom.root.querySelector('#file-items').innerHTML.includes('nov-0.png'));
  assert.ok(dom.getUrl().includes('q=needle'));

  // Now resolve the stale refresh with all 66 unfiltered items + bogus count 999
  pendingRefresh.resolve({
    images: catalogImages.slice(0, 60),
    totalCount: 66,
    totalBytes: 6600,
    allTotalCount: 999,
    bucketCounts: { '1999/01': 999 },
    optimizationEnabled: true
  });
  await refreshClickDone;

  // Stale refresh MUST NOT overwrite visible items, shared count, or bucketCounts!
  assert.ok(dom.root.querySelector('#file-items').innerHTML.includes('needle.png'));
  assert.ok(!dom.root.querySelector('#file-items').innerHTML.includes('nov-0.png'));
  assert.notEqual(syncedCounts.at(-1), 999);
  assert.ok(!('1999/01' in ctx.files.bucketCounts));

  // --- FM-03 Case 2: Older search 'alpha' resolves AFTER newer search 'needle' ---
  interceptAlphaOnce = true;
  searchInput.value = 'alpha';
  await searchInput.dispatch('input', { target: searchInput });
  await new Promise((r) => setTimeout(r, 220)); // 'alpha' request sent & suspended

  searchInput.value = 'needle';
  await searchInput.dispatch('input', { target: searchInput });
  await new Promise((r) => setTimeout(r, 230)); // 'needle' completes

  pendingAlphaSearch.resolve({
    images: [makeAsset('2026', '11', 'stale-alpha.png')],
    totalCount: 1,
    totalBytes: 100,
    allTotalCount: 66,
    bucketCounts: ctx.files.bucketCounts,
    optimizationEnabled: true
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(dom.root.querySelector('#file-items').innerHTML.includes('needle.png'));
  assert.ok(!dom.root.querySelector('#file-items').innerHTML.includes('stale-alpha.png'));

  // --- FM-04: Refresh updates archive months & counts in-place and preserves year disclosure state ---
  searchInput.value = '';
  await searchInput.dispatch('input', { target: searchInput });
  await new Promise((r) => setTimeout(r, 230));

  const year2025Details = dom.root.querySelectorAll('.archive-year[data-year]').find((d) => d.dataset.year === '2025');
  assert.ok(year2025Details, 'Archive year details should carry data-year attribute');
  year2025Details.open = false;

  const sepFile = makeAsset('2026', '09', 'september-new.png');
  catalogImages = [...catalogImages, sepFile];
  await dom.root.dispatch('click', { target: dom.root.querySelector('[data-action="refresh"]') });

  assert.equal(syncedCounts.at(-1), 67);
  assert.ok(archiveMarkup().includes('2026/09'), 'Refresh must render new 2026/09 month in archive');
  assert.ok(archiveMarkup().includes('>67<'), 'Refresh must update allAssets total count');
  const year2025AfterAdd = dom.root.querySelectorAll('.archive-year[data-year]').find((d) => d.dataset.year === '2025');
  assert.equal(year2025AfterAdd.open, false, 'Collapsed year disclosure state must survive refresh');

  // Remove the last file in 2026/09 and refresh again -> 2026/09 disappears
  catalogImages = catalogImages.filter((item) => item !== sepFile);
  await dom.root.dispatch('click', { target: dom.root.querySelector('[data-action="refresh"]') });
  assert.equal(syncedCounts.at(-1), 66);
  assert.ok(!archiveMarkup().includes('2026/09'), 'Removed empty month must disappear on refresh');

  // --- FM-03 Case 3: Response returning AFTER route abort does not touch shared state ---
  interceptRefreshOnce = true;
  const lateRefresh = deferred();
  ctx.api.filesPage = async () => lateRefresh.promise;
  const lateClick = dom.root.dispatch('click', { target: dom.root.querySelector('[data-action="refresh"]') });
  const countBeforeAbort = syncedCounts.length;
  pageAbort.abort();
  lateRefresh.resolve({
    images: [],
    totalCount: 0,
    totalBytes: 0,
    allTotalCount: 12345,
    bucketCounts: {},
    optimizationEnabled: true
  });
  await lateClick;
  assert.equal(syncedCounts.length, countBeforeAbort, 'Aborted page must never commit shared counts');
});

test('FM-05: Share verify & cleanup-invalid deduplicate hashing per file via non-blocking async streams', async (t) => {
  const config = require('../src/core/config');
  config.initializeConfigFromSetup({ username: 'admin', password: 'test-only-password' });
  const cfg = config.getConfig();
  const shares = require('../src/modules/share');

  const dir = path.join(config.STORAGE_DIR, 'raw', '2026', '11');
  fs.mkdirSync(dir, { recursive: true });

  // 8 MiB synthetic file shared by 8 distinct share links
  const bigSize = 8 * 1024 * 1024;
  const bigPath = path.join(dir, 'shared-bundle.pdf');
  fs.writeFileSync(bigPath, Buffer.alloc(bigSize, 0x5a));
  const realBigPath = fs.realpathSync(bigPath);

  const missingPath = path.join(dir, 'deleted-doc.pdf');
  fs.writeFileSync(missingPath, 'to-be-deleted');
  const changedPath = path.join(dir, 'mutated-doc.pdf');
  fs.writeFileSync(changedPath, 'version-1');

  for (let i = 0; i < 8; i++) {
    shares.createShareRecord({ year: '2026', month: '11', filename: 'shared-bundle.pdf', expiresInHours: 24 });
  }
  shares.createShareRecord({ year: '2026', month: '11', filename: 'deleted-doc.pdf', expiresInHours: 24 });
  shares.createShareRecord({ year: '2026', month: '11', filename: 'mutated-doc.pdf', expiresInHours: 24 });

  // Mutate / remove underlying files to exercise all verification states
  fs.unlinkSync(missingPath);
  fs.writeFileSync(changedPath, 'version-2-different-bytes');

  const app = express();
  app.use(express.json());
  let pingRespondedWhileVerifying = false;
  app.get('/api/ping', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });
  shares.registerShareModule(app);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    shares.flushSharesMap();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = { Authorization: `Bearer ${cfg.api_token}`, 'Content-Type': 'application/json' };

  // Instrument fs.readSync and fs.createReadStream to count exact bytes read on bigPath
  let syncBytesOnBig = 0;
  let streamBytesOnBig = 0;
  let streamOpensOnBig = 0;
  const openFds = new Set();

  const origOpenSync = fs.openSync;
  const origCloseSync = fs.closeSync;
  const origReadSync = fs.readSync;
  const origCreateReadStream = fs.createReadStream;

  t.mock.method(fs, 'openSync', function (targetPath, ...rest) {
    const fd = origOpenSync.call(fs, targetPath, ...rest);
    try {
      if (fs.existsSync(targetPath) && fs.realpathSync(targetPath) === realBigPath) {
        openFds.add(fd);
      }
    } catch {}
    return fd;
  });
  t.mock.method(fs, 'closeSync', function (fd, ...rest) {
    openFds.delete(fd);
    return origCloseSync.call(fs, fd, ...rest);
  });
  t.mock.method(fs, 'readSync', function (fd, buffer, offset, length, position) {
    const n = origReadSync.call(fs, fd, buffer, offset, length, position);
    if (openFds.has(fd) && n > 0) syncBytesOnBig += n;
    return n;
  });
  t.mock.method(fs, 'createReadStream', function (targetPath, opts) {
    const stream = origCreateReadStream.call(fs, targetPath, opts);
    let isBig = false;
    try {
      isBig = fs.realpathSync(targetPath) === realBigPath;
    } catch {}
    if (isBig) {
      streamOpensOnBig += 1;
      stream.on('data', (chunk) => {
        streamBytesOnBig += chunk.length;
      });
    }
    return stream;
  });

  // 1. Verify endpoint: 8 shares on 1 file must read bigPath ONCE via stream, 0 sync bytes
  const [verifyRes, pingRes] = await Promise.all([
    fetch(`${base}/api/modules/share/verify`, {
      method: 'POST',
      headers: authHeaders
    }),
    fetch(`${base}/api/ping`)
  ]);
  assert.equal(pingRes.status, 200);
  pingRespondedWhileVerifying = true;
  assert.equal(verifyRes.status, 200);
  const verifyJson = await verifyRes.json();

  assert.equal(pingRespondedWhileVerifying, true);
  assert.equal(syncBytesOnBig, 0, 'Share verify must not read shared files via blocking fs.readSync');
  assert.equal(streamOpensOnBig, 1, '8 shares pointing to identical file must open stream only once');
  assert.equal(streamBytesOnBig, bigSize, '8 shares pointing to identical file must read file bytes only once');
  assert.deepEqual(verifyJson.summary, {
    total: 10,
    active: 8,
    invalid: 2,
    fileMissing: 1,
    fileChanged: 1,
    expired: 0,
    quotaUsed: 0
  });

  // 2. Cleanup-invalid endpoint: reads bigPath ONCE and reuses the batch check result (not twice!)
  syncBytesOnBig = 0;
  streamBytesOnBig = 0;
  streamOpensOnBig = 0;

  const cleanupRes = await fetch(`${base}/api/modules/share/cleanup-invalid`, {
    method: 'POST',
    headers: authHeaders
  });
  assert.equal(cleanupRes.status, 200);
  const cleanupJson = await cleanupRes.json();

  assert.equal(syncBytesOnBig, 0, 'cleanup-invalid must not use blocking fs.readSync');
  assert.equal(streamOpensOnBig, 1, 'cleanup-invalid must reuse its single verification pass');
  assert.equal(streamBytesOnBig, bigSize);
  assert.equal(cleanupJson.removed, 2);
  assert.deepEqual(cleanupJson.summary, {
    total: 8,
    active: 8,
    invalid: 0,
    fileMissing: 0,
    fileChanged: 0,
    expired: 0,
    quotaUsed: 0
  });
});
