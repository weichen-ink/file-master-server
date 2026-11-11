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
  const { queryFiles } = await modules("features/files");
  const item = {
    year: "2026",
    month: "11",
    filename: "中文 #?%'\".png",
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
  const result = queryFiles([item], {
    type: "image",
    protected: "1",
    page: 999,
  });
  assert.equal(result.page, 1);
  assert.equal(result.visible[0], item);
  assert.equal(queryFiles([item], { type: "other" }).filtered.length, 0);
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
