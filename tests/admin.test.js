const test = require("node:test");
const assert = require("node:assert/strict");
const modules = (name) => import("../src/public/assets/admin/" + name + ".mjs");

test("Settings drafts survive navigation/refresh of other sections; accepted changes do not overwrite dirty drafts", async () => {
  const { createSettingsStore } = await modules("state/settings");
  const store = createSettingsStore();
  const general = store.section("general", { site_name: "before", port: 3210 });
  store.edit("general", "site_name", "unsaved");
  store.section("media", { webp_quality: 82 });
  store.merge("general", { site_name: "remote", port: 3210 });
  assert.equal(store.section("general", {}).draft.site_name, "unsaved");
  store.accept("media", { webp_quality: 70 });
  assert.equal(general.draft.site_name, "unsaved");
  assert.equal(store.anyDirty(), true);
  store.discard("general");
  assert.equal(general.draft.site_name, "before");
  assert.equal(store.anyDirty(), false);
});

test("Section payloads enforce ownership and preserve valid zeroes", async () => {
  const { sectionPatch } = await modules("features/settings-schema");
  const general = sectionPatch("general", {
    site_name: "test",
    base_url: "https://example.test",
    port: 3210,
    raw_secret_path: "raw",
    pub_secret_path: "pub",
    password: "must-not-send",
    webp_quality: 99,
  });
  assert.deepEqual(Object.keys(general).sort(), [
    "base_url",
    "console",
    "image_host",
    "language",
    "port",
    "site_name",
  ]);
  assert.deepEqual(general.image_host, {
    raw_secret_path: "raw",
    pub_secret_path: "pub",
  });
  const keep = sectionPatch("security", {
    username: "admin",
    admin_path: "admin",
    max_login_attempts: 3,
    password: "",
    api_token: "",
  });
  assert.ok(!("password" in keep));
  assert.ok(!("api_token" in keep));
  assert.equal(
    sectionPatch("media", { watermark_margin: 0, max_width: 0 }).image_host
      .watermark_margin,
    0,
  );
});

test("Failed mutations cannot commit a successful UI state", async () => {
  const { confirmedMutation } = await modules("state/settings");
  let locked = false;
  await assert.rejects(
    confirmedMutation(
      async () => {
        throw new Error("denied");
      },
      () => {
        locked = true;
      },
    ),
    /denied/,
  );
  assert.equal(locked, false);
  await confirmedMutation(
    async () => ({ success: true }),
    () => {
      locked = true;
    },
  );
  assert.equal(locked, true);
});

test("File routing safely roundtrips filenames and legacy bookmarks, filters and clamps pages", async () => {
  const { parseRoute, detailHref, filesHref } = await modules("router");
  const filesMod = await modules("features/files");
  const { queryCatalog } = require("../src/modules/image-host/catalog-query");
  assert.equal("queryFiles" in filesMod, false, "Legacy client-side queryFiles() must be removed");
  const item = {
    year: "2026",
    month: "11",
    filename: "中文 #?%'\".png",
    category: "image",
    isImage: true,
    size: 3,
    createdAt: 2,
    locked: true,
  };
  assert.equal(parseRoute(detailHref(item)).key, `2026/11/${item.filename}`);
  assert.equal(parseRoute("#image-host").page, "files");
  assert.equal(parseRoute("#security").section, "site");
  const query = parseRoute(
    filesHref({ q: "#中文", folder: "2026/11", sort: "size-desc", page: 999 }),
  ).query;
  assert.equal(query.q, "#中文");
  const matched = queryCatalog({ images: [item], optimizationEnabled: true }, {
    types: "image",
    protected: "1",
    limit: filesMod.PAGE_SIZE,
    offset: 0,
  });
  assert.equal(matched.totalCount, 1);
  assert.equal(matched.images[0], item);
  assert.equal(
    queryCatalog({ images: [item], optimizationEnabled: true }, { types: "audio,other" }).totalCount,
    0,
  );
});

test("API errors propagate without retrying writes; only 401 invalidates sessions", async () => {
  const { createClient } = await modules("api/client");
  let calls = 0,
    expired = 0;
  const client = createClient(
    async () => {
      calls++;
      return new Response(JSON.stringify({ error: "denied" }), { status: 403 });
    },
    () => expired++,
  );
  await assert.rejects(
    client("/share", { method: "POST", json: {} }),
    /denied/,
  );
  assert.equal(calls, 1);
  assert.equal(expired, 0);
  const unauthorized = createClient(
    async () => new Response("{}", { status: 401 }),
    () => expired++,
  );
  await assert.rejects(unauthorized("/files"));
  assert.equal(expired, 1);
  await assert.rejects(unauthorized("/login"));
  assert.equal(expired, 1);
});

test("Upload cancellation retains unfinished files and retries only those files", async () => {
  const { createTasks } = await modules("state/tasks");
  let release;
  const firstStarted = new Promise((r) => (release = r));
  let attempts = [];
  const api = {
    upload: async (file, signal) => {
      attempts.push(file.name);
      if (attempts.length === 1) {
        release();
        await new Promise((resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Stopped", "AbortError")),
            { once: true },
          ),
        );
      }
      return { deduplicated: false };
    },
  };
  const tasks = createTasks(api, async () => {});
  const run = tasks.upload([{ name: "one" }, { name: "two" }]);
  await firstStarted;
  tasks.cancelUpload();
  await run;
  assert.equal(tasks.jobs.upload.state, "cancelled");
  assert.equal(tasks.jobs.upload.failed, 2);
  await tasks.retryUpload();
  assert.deepEqual(attempts, ["one", "one", "two"]);
  assert.equal(tasks.jobs.upload.success, 2);
  assert.equal(tasks.jobs.upload.failed, 0);
});

test("Upload results use actual server identities and retain successful rows when retrying failures", async () => {
  const { createTasks } = await modules("state/tasks");
  const { renderUploadResult } = await modules("features/activity");
  let failed = false;
  const calls = [];
  const tasks = createTasks({ upload: async file => {
    calls.push(file.name);
    if (file.name === 'retry.pdf' && !failed) { failed = true; throw Error('<offline>'); }
    return { year: '2020', month: '02', filename: file.name === 'copy.png' ? 'existing #图.png' : file.name,
      category: file.name.endsWith('.png') ? 'image' : 'other', rawUrl: 'https://example.test/raw/2020/02/existing.png', deduplicated: file.name === 'copy.png' };
  } }, async () => {});
  await tasks.upload([{ name: 'copy.png' }, { name: 'retry.pdf' }]);
  const job = tasks.jobs.upload;
  assert.equal(job.results[0].state, 'reused');
  assert.equal(job.results[0].filename, 'existing #图.png');
  assert.equal(job.results[1].state, 'failed');
  let html = renderUploadResult(job);
  assert.ok(html.includes(detailLink()));
  assert.ok(html.includes('collection file-collection'));
  assert.ok(html.includes('class="row-thumbnail"'));
  assert.ok(html.includes('src="https://example.test/raw/2020/02/existing.png?thumbnail=1"'));
  assert.ok(html.includes('&lt;offline&gt;'));
  assert.ok(!html.includes('<offline>'));
  await tasks.retryUpload();
  assert.deepEqual(calls, ['copy.png', 'retry.pdf', 'retry.pdf']);
  assert.equal(tasks.jobs.upload, job);
  assert.equal(job.results.length, 2);
  assert.equal(job.results[0].state, 'reused');
  assert.equal(job.results[1].state, 'uploaded');
  assert.equal(job.total, 2);
  assert.equal(job.done, 2);
  assert.equal(job.failed, 0);
  html = renderUploadResult(job);
  assert.ok(html.includes(detailLink()));
  assert.ok(!html.includes('&lt;offline&gt;'));
  function detailLink() { return '#/files/2020/02/' + encodeURIComponent('existing #图.png'); }
});

test("Task responses arriving after session cleanup cannot repopulate jobs or restart polling", async () => {
  const { createTasks } = await modules("state/tasks");
  let resolveIntegrity, resolveBackup;
  const tasks = createTasks(
    {
      integrity: () =>
        new Promise((resolve) => {
          resolveIntegrity = resolve;
        }),
      backup: () =>
        new Promise((resolve) => {
          resolveBackup = resolve;
        }),
    },
    async () => {},
  );
  const work = tasks.resume();
  tasks.clear();
  resolveIntegrity({ state: "running" });
  resolveBackup({ isBackingUp: true });
  await work;
  assert.deepEqual(tasks.jobs, {});
});

test("Upload Retry-After accepts seconds and HTTP dates, bounds waits, and stays abortable", async () => {
  const { createClient, parseRetryAfter, abortableDelay } =
    await modules("api/client");
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(
    parseRetryAfter(
      "Wed, 11 Nov 2026 08:00:02 GMT",
      Date.parse("2026-11-11T08:00:00Z"),
    ),
    2000,
  );
  assert.equal(parseRetryAfter("9999"), 60000);
  assert.equal(parseRetryAfter("invalid"), null);
  const client = createClient(
    async () =>
      new Response("{}", { status: 429, headers: { "Retry-After": "3" } }),
  );
  await assert.rejects(
    client("/upload"),
    (error) => error.status === 429 && error.retryAfterMs === 3000,
  );
  const controller = new AbortController();
  const waiting = abortableDelay(60000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("Detail links retain a safe library query across reload and variant selection", async () => {
  const { detailHref, parseRoute, filesHref, libraryBacklink } =
    await modules("router");
  const from = filesHref({
    folder: "2026/11",
    q: "中文 #?",
    page: 2,
    view: "list",
  });
  const route = parseRoute(
    detailHref(
      { year: "2026", month: "11", filename: "中文.png" },
      { from, variant: "webp" },
    ),
  );
  assert.equal(route.query.from, from);
  assert.equal(route.query.variant, "webp");
  assert.equal(libraryBacklink(route.query.from), from);
  assert.equal(libraryBacklink("https://external.test/"), null);
  assert.equal(libraryBacklink("#/files/2026/11/other.png"), null);
  assert.equal(libraryBacklink("#/settings/security"), null);
});


test("Independent image drafts, card copy preferences and mirror presets retain their ownership", async () => {
  const {sectionPatch,sectionValues}=await modules("features/settings-schema");
  const {cardCopy}=await modules("state/preferences");
  const compression=sectionPatch("compression",{enable_optimization:true,max_width:0,webp_quality:75,watermark_text:"not-owned"});
  assert.deepEqual(compression,{image_host:{enable_optimization:true,webp_quality:75,max_width:0}});
  assert.ok(!("webp_quality" in sectionPatch("watermark",{watermark_enable:true,webp_quality:75}).image_host));
  assert.deepEqual(sectionPatch("updates",{mirror_preset:"",upstream_mirror:"https://old.test/"}),{upstream_mirror:""});
  assert.deepEqual(sectionPatch("updates",{mirror_preset:"custom",upstream_mirror:"https://custom.test/"}),{upstream_mirror:"https://custom.test/"});
  const item={rawUrl:"/original",pubUrl:"/webp",isProcessableImage:true,isImage:true};
  assert.equal(cardCopy(item,"markdown_webp"),"![](/webp)");
  assert.equal(cardCopy(item,"webp",false),"/original");
  assert.equal(cardCopy({...item,isProcessableImage:false},"webp"),"/original");
  assert.equal(cardCopy({...item,isImage:false,filename:"x[y].txt"},"markdown_raw"),"[x\\[y\\].txt](/original)");
});

test("Draft subscription only shows modified sections and removes accepted or discarded sections", async()=>{
  const {createSettingsStore}=await modules("state/settings");const store=createSettingsStore();let dirty=[];
  const stop=store.subscribe(()=>{dirty=store.dirtyNames();});
  store.section("general",{site_name:"A"});store.section("watermark",{watermark_text:"A"});
  store.edit("general","site_name","B");store.edit("watermark","watermark_text","B");
  assert.deepEqual(dirty,["general","watermark"]);store.accept("general",{site_name:"B"});assert.deepEqual(dirty,["watermark"]);store.discard("watermark");assert.deepEqual(dirty,[]);stop();
});

test("Binary preview responses retain errors and session invalidation",async()=>{
  const {createClient}=await modules("api/client");
  const client=createClient(async()=>new Response(new Uint8Array([82,73,70,70]),{headers:{"Content-Type":"image/webp"}}));
  assert.deepEqual([...new Uint8Array(await (await client("/preview",{responseType:"blob"})).arrayBuffer())],[82,73,70,70]);
  let expired=false;const denied=createClient(async()=>new Response('{"error":"expired"}',{status:401}),()=>{expired=true;});
  await assert.rejects(denied("/preview",{responseType:"blob"}),/expired/);assert.equal(expired,true);
});

test("prepareConfigPatch rejects stale revision with 409 CONFIG_CHANGED", () => {
  const { prepareConfigPatch, configRevision } = require("../src/core/config");
  const currentRev = configRevision();
  assert.ok(currentRev);
  assert.throws(
    () => prepareConfigPatch({ site_name: "New Name" }, "stale-revision"),
    (err) => err && err.status === 409 && err.message === "CONFIG_CHANGED"
  );
  const prepared = prepareConfigPatch({ site_name: "New Name" }, currentRev);
  assert.equal(prepared.config.site_name, "New Name");
});

test("Settings store merge safely handles uninitialized, clean, and dirty advanced sections", async () => {
  const { createSettingsStore } = await modules("state/settings");
  const store = createSettingsStore();
  // 1. Never opened: merge must not throw
  store.merge("advanced", { raw: "v2", revision: "rev2" });
  assert.equal(store.dirty("advanced"), false);

  // 2. Opened and clean: merge updates baseline & draft
  store.section("advanced", { raw: "v1", revision: "rev1" });
  store.merge("advanced", { raw: "v2", revision: "rev2" });
  assert.deepEqual(store.section("advanced").draft, { raw: "v2", revision: "rev2" });

  // 3. Opened and dirty: merge preserves dirty draft & old revision
  store.edit("advanced", "raw", "v2-edited");
  store.merge("advanced", { raw: "v3", revision: "rev3" });
  assert.deepEqual(store.section("advanced").draft, { raw: "v2-edited", revision: "rev2" });
});

test("Settings drafts survive elapsed time, polling and remounts until explicitly resolved", async (t) => {
  const { createSettingsStore } = await modules("state/settings");
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const store = createSettingsStore();
  store.section("site", { site_name: "a", port: 3210 });
  store.edit("site", "site_name", "b");
  now += 60 * 60 * 1000;
  store.merge("site", { site_name: "server-update", port: 3210 });
  assert.deepEqual(store.section("site").draft, { site_name: "b", port: 3210 });
  assert.deepEqual(store.dirtyKeys("site"), ["site_name"]);
  store.rebase("site", { site_name: "server-update", port: 3211 });
  assert.deepEqual(store.section("site").draft, { site_name: "b", port: 3211 });
  store.accept("site", store.section("site").draft);
  assert.equal(store.anyDirty(), false);
  store.edit("site", "site_name", "discard-me");
  store.discard("site");
  assert.equal(store.section("site").draft.site_name, "b");
  store.clear();
  assert.deepEqual(store.section("site", { site_name: "after-login" }).draft, { site_name: "after-login" });
});


test('Backup polling exposes the first failure, retains known status on failure, and recovers', async () => {
  const { createTasks } = await modules('state/tasks');
  let fails = true;
  const data = { config: { enabled: true }, lastBackup: { success: true }, isBackingUp: false };
  const tasks = createTasks({backup: async () => { if (fails) throw new Error('Cannot read backup_status.json'); return data; }}, async () => {});
  await tasks.pollBackup();
  assert.match(tasks.jobs.backup.pollError, /backup_status/);
  assert.equal(tasks.jobs.backup.lastBackup, undefined, 'A failed read must not manufacture a never-run result');
  fails = false; await tasks.pollBackup();
  assert.equal(tasks.jobs.backup.pollError, undefined);
  fails = true; await tasks.pollBackup();
  assert.deepEqual(tasks.jobs.backup.lastBackup, {success:true});
  assert.match(tasks.jobs.backup.pollError, /backup_status/);
  fails = false; await tasks.pollBackup();
  assert.equal(tasks.jobs.backup.pollError, undefined);
  tasks.clear();
});
