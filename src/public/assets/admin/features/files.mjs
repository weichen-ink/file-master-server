/**
 * @typedef {Object} Asset
 * @property {string} year
 * @property {string} month
 * @property {string} filename Full name including extension; never use basename as identity.
 * @property {number} size Original bytes, distinct from webpSize and cacheSize.
 * @property {boolean} locked Deletion protection, not an access permission.
 * @property {boolean} isImage Browser/image preview capability from the catalog.
 * @property {boolean} isProcessableImage Whether the service can generate WebP.
 * @property {string} rawUrl Original URL; rawPreviewPath may transcode for browser display.
 * @property {string} pubUrl Optimized delivery URL.
 * @property {?number} webpSize Null means not generated, not a zero-byte file.
 */
import { t } from "../locale.mjs";
import {
  e,
  icon,
  metaItem,
  button,
  heading,
  bytes,
  date,
  compactDate,
  notice,
  empty,
  actions,
  copy,
  confirm,
  toast,
  kv,
  dialog,
} from "../ui.mjs";
import {
  assetKey,
  detailHref,
  libraryBacklink,
  filesHref,
  navigate,
} from "../router.mjs";
import { collection, fileIdentity } from "./collection.mjs";
import { mountViewer, viewerControls, bindViewerControls, openImagePreview } from "./viewer.mjs";
import { cardCopy } from "../state/preferences.mjs";
import { confirmedMutation } from "../state/settings.mjs";

/** One hierarchy for year/month navigation and counts, independent of viewport. */
export function archiveGroups(items) {
  const years = new Map();
  for (const item of items) {
    if (!years.has(item.year)) years.set(item.year, new Map());
    const months = years.get(item.year);
    months.set(item.month, (months.get(item.month) || 0) + 1);
  }
  return [...years].sort(([a], [b]) => b.localeCompare(a)).map(([key, months]) => ({
    key,
    count: [...months.values()].reduce((sum, count) => sum + count, 0),
    months: [...months].sort(([a], [b]) => b.localeCompare(a)).map(([key, count]) => ({ key, count })),
  }));
}
export const PAGE_SIZE = 60;
export function queryFiles(items, query) {
  const q = String(query.q || "").toLocaleLowerCase();
  const filtered = items.filter(
    (item) =>
      (!query.folder ||
        `${item.year}/${item.month}`.startsWith(query.folder)) &&
      (!q || item.filename.toLocaleLowerCase().includes(q)) &&
      (!query.type ||
        (query.type === "image" ? item.isImage : !item.isImage)) &&
      (!query.protected || item.locked),
  );
  const [field, order] = (query.sort || "time-desc").split("-");
  const dir = order === "asc" ? 1 : -1;
  filtered.sort(
    (a, b) =>
      dir *
      (field === "name"
        ? a.filename.localeCompare(b.filename, undefined, { numeric: true })
        : field === "size"
          ? a.size - b.size
          : field === "hits"
            ? (a.hits || 0) - (b.hits || 0)
            : a.createdAt - b.createdAt),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.max(
    1,
    Math.min(pages, Math.floor(Number(query.page)) || 1),
  );
  return {
    filtered,
    page,
    pages,
    visible: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
  };
}
const previewThumb = (item) =>
  item.isImage
    ? `<img src="${e(item.thumbnailUrl || item.rawPreviewPath)}" alt="" loading="lazy"><span class="thumbnail-fallback" hidden>${icon("image")}</span>`
    : `<span class="file-type-icon">${icon("file")}<span>${e(item.ext?.replace(".", "").toUpperCase())}</span></span>`;
export function fileCard(item, index, from = "") {
  return `<article class="file-card"><a href="${e(detailHref(item, { from }))}" class="file-open"><div class="file-thumbnail">${previewThumb(item)}${item.locked ? `<span class="protection-badge" aria-label="${e(t("protected"))}">${icon("lock")}</span>` : ""}</div><div class="file-caption"><h3 title="${e(item.filename)}">${e(item.filename)}</h3><p>${metaItem("hardDrive", bytes(item.size))}<span class="meta-sep" aria-hidden="true"></span>${metaItem("eye", item.hits || 0, { title: `${t("sortHits")}: ${item.hits || 0}` })}</p></div></a><button type="button" class="card-copy icon-button" data-action="copy-raw" data-index="${index}" title="${e(t("copy"))}" aria-label="${e(t("copy"))}">${icon("copy")}</button></article>`;
}
function fileRow(item, index, from = "") {
  return {
    file: fileIdentity(item, {
      href: detailHref(item, { from }),
      thumbnail: previewThumb(item),
      summary: `${metaItem("hardDrive", bytes(item.size))}${metaItem("calendar", compactDate(item.createdAt))}${item.locked ? metaItem("lock", t("protected")) : ""}`,
    }),
    size: e(bytes(item.size)),
    date: e(compactDate(item.createdAt)),
    protection: item.locked
      ? `<span class="collection-status">${e(t("protected"))}</span>`
      : "—",
    actions: `<button class="icon-button" data-action="copy-raw" data-index="${index}" title="${e(t("copy"))}" aria-label="${e(t("copy"))}">${icon("copy")}</button>`,
  };
}
const selected = (a, b) => (a === b ? "selected" : "");
export async function mountFiles(ctx, root, route, signal) {
  await Promise.all([ctx.loadFiles(), ctx.loadConfig()]);
  if (signal.aborted) return;
  let query = { ...route.query };
  const view =
    query.view || (matchMedia("(max-width: 600px)").matches ? "list" : "grid");
  const archive = archiveGroups(ctx.files.items);
  const [currentYear, currentMonth] = (query.folder || "").split("/");
  const currentArchive = currentYear ? t("archiveYear", {year:currentYear}) + (currentMonth ? " / " + t("archiveMonth", {month:currentMonth}) : "") : t("allAssets");
  const folderLink = (key, label, count) =>
    `<a href="${e(filesHref({ ...query, folder: key, page: 1 }))}" class="folder-link" ${(!query.folder && !key) || query.folder === key ? 'aria-current="page"' : ""}>${icon("folder")}<span>${e(label)}</span><small>${count}</small></a>`;
  const archiveHtml = `${folderLink("", t("allAssets"), ctx.files.items.length)}<div class="archive-years">${archive.map(year => `<details class="archive-year" open><summary><span class="archive-disclosure">${icon("chevron")}</span>${folderLink(year.key, t("archiveYear", {year: year.key}), year.count)}</summary><div class="archive-months">${year.months.map(month => folderLink(year.key + "/" + month.key, t("archiveMonth", {month: month.key}), month.count)).join("")}</div></details>`).join("")}</div>`;
  root.innerHTML =
    heading(
      "library",
      "libraryDesc",
      `<div class="library-action-bar">${button("btnIntegrity", "integrity")}${button("btnClearWatermarkCache", "clear-cache")}${button("refresh", "refresh")}</div><details class="menu library-more"><summary class="button secondary">${icon("more")}${e(t("more"))}</summary><div class="menu-items">${button("btnIntegrity", "integrity", "quiet")}${button("btnClearWatermarkCache", "clear-cache", "quiet")}${button("refresh", "refresh", "quiet")}</div></details>${button("upload", "upload", "primary", "upload")}`,
    ) +
    (ctx.status.storageHealth?.atomicUploads === true
      ? ""
      : notice(t("storageWarning"), "warning")) +
    `<div class="explorer"><aside class="archive-panel"><details class="archive-root" ${matchMedia("(max-width:600px)").matches ? "" : "open"}><summary><span class="archive-label">${icon("clock")}${e(t("archive"))}</span><span class="archive-current">${e(currentArchive)}</span>${icon("chevron")}</summary><nav aria-label="${e(t("archive"))}">${archiveHtml}</nav></details></aside><section class="file-results"><div class="file-toolbar"><label class="search-field" for="file-search">${icon("search")}<input type="search" id="file-search" placeholder="${e(t("search"))}" value="${e(query.q || "")}"></label><div class="filter-controls"><select id="type-filter" aria-label="${e(t("type"))}"><option value="">${e(t("allTypes"))}</option><option value="image" ${selected(query.type, "image")}>${e(t("images"))}</option><option value="other" ${selected(query.type, "other")}>${e(t("otherFiles"))}</option></select><select id="protection-filter" aria-label="${e(t("protection"))}"><option value="">${e(t("allProtection"))}</option><option value="1" ${selected(query.protected, "1")}>${e(t("protected"))}</option></select><div class="library-display-controls"><div class="sort-controls" role="group" aria-label="${e(t("sort"))}">${[
      ["time", "sortTime", "desc"], ["size", "sortSize", "desc"], ["name", "sortName", "asc"], ["hits", "sortHits", "desc"],
    ].map(([field,label,initial]) => {
      const [active,order] = (query.sort || "time-desc").split("-");
      const next = active === field ? (order === "desc" ? "asc" : "desc") : initial;
      return `<a class="button sort-button ${active === field ? 'is-active' : ''}" href="${e(filesHref({...query,sort:field+'-'+next,page:1}))}" aria-label="${e(t(label))} · ${e(t(active === field ? (order === 'desc' ? 'descending' : 'ascending') : 'sort'))}" ${active === field ? 'aria-current="true"' : ''}>${e(t(label))}<span aria-hidden="true">${active === field ? (order === 'desc' ? '↓' : '↑') : '↕'}</span></a>`;
    }).join('')}</div><div class="segmented view-controls"><a href="${e(filesHref({ ...query, view: "grid" }))}" aria-label="${e(t("grid"))}" ${view === "grid" ? 'aria-current="true"' : ""}>${icon("files")}</a><a href="${e(filesHref({ ...query, view: "list" }))}" aria-label="${e(t("list"))}" ${view === "list" ? 'aria-current="true"' : ""}>${icon("list")}</a></div></div></div></div><div id="filter-summary" class="result-summary"></div><div id="file-items"></div><nav id="file-pages" class="pagination" aria-label="${e(t("pageNext"))}"></nav></section></div>`;
  let visible = [];
  const renderResults = () => {
    const result = queryFiles(ctx.files.items, query);
    visible = result.visible;
    ctx.lastFilesHref = filesHref(query);
    root.querySelector("#filter-summary").innerHTML =
      `<span>${e(query.folder || t("allAssets"))} <span class="muted">/ ${e(t("filesSummary", { count: result.filtered.length, size: bytes(result.filtered.reduce((n, i) => n + i.size, 0)) }))}</span></span>${query.q || query.type || query.protected ? `<a href="${e(filesHref({ view, folder: query.folder }))}">${e(t("clearFilters"))}</a>` : ""}${query.folder ? `<a href="${e(filesHref({ ...query, folder: "", page: 1 }))}">${e(t("searchAll"))}</a>` : ""}`;
    const box = root.querySelector("#file-items");
    box.innerHTML = !ctx.files.items.length
      ? empty(
          "emptyLibrary",
          "emptyLibraryDesc",
          button("upload", "upload", "primary", "upload"),
        )
      : !visible.length
        ? empty("noResults", "noResultsDesc", button("clearFilters", "reset"))
        : view === "grid"
          ? `<div class="file-grid">${visible.map((item, index) => fileCard(item, index, filesHref(query))).join("")}</div>`
          : collection(
              [
                { key: "file", label: "file" },
                { key: "size", label: "sizeColumn" },
                { key: "date", label: "date" },
                { key: "protection", label: "protectionColumn" },
                { key: "actions", label: "shareColActions" },
              ],
              visible.map((item, index) =>
                fileRow(item, index, filesHref(query)),
              ),
              { className: "file-collection" },
            );
    root.querySelector("#file-pages").innerHTML =
      `${button("pagePrevious", "previous", "secondary", "", result.page === 1 ? "disabled" : "")}<span>${e(t("pageCount", { current: result.page, total: result.pages }))}</span>${button("pageNext", "next", "secondary", "", result.page === result.pages ? "disabled" : "")}`;
  };
  root.querySelector("#file-search").addEventListener(
    "input",
    (event) => {
      query = { ...query, q: event.target.value, page: 1 };
      history.replaceState(null, "", filesHref(query));
      renderResults();
    },
    { signal },
  );
  for (const [id, key] of [
    ["type-filter", "type"],
    ["protection-filter", "protected"],
  ])
    root
      .querySelector("#" + id)
      .addEventListener(
        "change",
        (event) =>
          navigate(filesHref({ ...query, [key]: event.target.value, page: 1 })),
        { signal },
      );
  actions(
    root,
    {
      upload: () => ctx.chooseUpload(),
      refresh: async () => {
        await ctx.loadFiles(true);
        ctx.render();
      },
      reset: () => navigate(filesHref({ view })),
      previous: () =>
        navigate(
          filesHref({
            ...query,
            page: queryFiles(ctx.files.items, query).page - 1,
          }),
        ),
      next: () =>
        navigate(
          filesHref({
            ...query,
            page: queryFiles(ctx.files.items, query).page + 1,
          }),
        ),
      "copy-raw": (target) =>
        copy(
          cardCopy(
            visible[Number(target.dataset.index)],
            ctx.config.console?.card_copy_format,
            ctx.files.optimizationEnabled,
          ),
        ),
      integrity: () => ctx.checkIntegrity(),
      "clear-cache": async () => {
        if (
          await confirm(t("btnClearWatermarkCache"), t("clearCacheConfirm"))
        ) {
          await ctx.api.clearCache();
          toast(t("cacheCleared"));
          await ctx.loadFiles(true);
          ctx.render();
        }
      },
    },
    signal,
  );
  root.addEventListener(
    "click",
    (event) => {
      if (event.target.closest(".file-open,.file-row-link")) {
        ctx.fileScroll = window.scrollY;
        ctx.returnFileHref = event.target.closest("a").getAttribute("href");
        ctx.lastFilesHref = filesHref(query);
      }
    },
    { signal },
  );
  root.addEventListener(
    "error",
    (event) => {
      if (event.target.tagName === "IMG") {
        event.target.hidden = true;
        const fallback = event.target.nextElementSibling;
        if (fallback) fallback.hidden = false;
      }
    },
    { capture: true, signal },
  );
  renderResults();
  if (ctx.restoreFileScroll) {
    window.scrollTo(0, ctx.fileScroll || 0);
    ctx.restoreFileScroll = false;
    const returnLink = [
      ...root.querySelectorAll(".file-open,.file-row-link"),
    ].find((link) => link.getAttribute("href") === ctx.returnFileHref);
    if (returnLink) {
      returnLink.focus({ preventScroll: true });
      ctx.focusRoute = false;
    }
  }
}

export async function createShare(ctx, item, signal) {
  const values = await dialog(
    t("share"),
    `<div class="share-target-name">${e(item.filename)}</div><div class="field"><label for="share-hours">${e(t("shareExpiryLabel"))}</label><input id="share-hours" name="hours" type="number" min="0" value="24" required></div><div class="field"><label for="share-max">${e(t("shareMaxDlLabel"))}</label><input id="share-max" name="max" type="number" min="0" step="1" value="0" required></div>${notice(t("sharesHelp"))}`,
    { submit: t("share"), className: "dialog-compact" },
  );
  if (!values || signal?.aborted) return;
  const { share } = await ctx.api.share(item, {
    expiresInHours: Number(values.hours),
    maxDownloads: Number(values.max),
  });
  if (signal?.aborted) return;
  await dialog(
    t("shareCreated"),
    `<div class="field"><label for="created-share">${e(t("shareLink"))}</label><div class="input-with-action"><input readonly value="${e(share.shareUrl)}" id="created-share">${button("copy", "copy-created-share", "icon-button", "copy")}</div></div>`,
    {
      cancel: t("done"),
      className: "dialog-compact",
      onMount: (el) => {
        el.querySelector("input").addEventListener("click", (event) =>
          event.target.select(),
        );
        el.querySelector('[data-action="copy-created-share"]').addEventListener(
          "click",
          () => copy(share.shareUrl),
        );
      },
    },
  );
}

export async function mountDetail(ctx, root, route, signal) {
  await ctx.loadFiles();
  if (signal.aborted) return;
  const item = ctx.files.items.find((i) => assetKey(i) === route.key);
  const back =
    libraryBacklink(route.query.from) || ctx.lastFilesHref || "#/files";
  if (!item) {
    root.innerHTML = empty(
      "missingFile",
      "missingFileDesc",
      `<a class="button primary" href="${e(back)}">${e(t("backFiles"))}</a>`,
    );
    return;
  }
  const canWebp = ctx.files.optimizationEnabled && item.isProcessableImage;
  let variant = route.query.variant === "webp" && canWebp ? "webp" : "raw",
    viewer,
    previewController;
  const linkRows = [
    ["rawLink", item.rawUrl],
    ...(canWebp ? [["webpLink", item.pubUrl]] : []),
    ["markdownRaw", cardCopy(item, "markdown_raw")],
    ...(canWebp ? [["markdownWebp", cardCopy(item, "markdown_webp")]] : []),
  ];
  const download =
    item.rawUrl + (item.rawUrl.includes("?") ? "&" : "?") + "raw=1&download=1";
  root.innerHTML = `<a class="back-link" href="${e(back)}">${icon("arrow")}${e(t("backFiles"))}</a><header class="detail-heading"><h1>${e(item.filename)}</h1><nav class="file-breadcrumb" aria-label="${e(t("fileLocation"))}"><span aria-hidden="true">📁</span><a href="${e(filesHref({ folder: item.year }))}">${e(item.year)}</a><span aria-hidden="true">/</span><a href="${e(filesHref({ folder: item.year + "/" + item.month }))}">${e(item.month)}</a></nav></header><div class="detail-workspace"><section class="preview-panel"><div class="preview-toolbar"><div class="segmented">${button("raw", "raw", "quiet")}${canWebp ? button("webp", "webp", "quiet") : ""}</div>${item.isImage ? viewerControls({expand:true}) : ""}</div><div class="preview-stage image-viewport" id="preview-stage" tabindex="0" aria-label="${e(t("viewerHelp"))}"></div><div id="preview-status" role="status" hidden></div></section><aside class="inspector"><section class="panel"><h2>${e(t("links"))}</h2><table class="asset-link-table" aria-label="${e(t('links'))}"><tbody>${[
    {label:'raw',indexes:[0,canWebp ? 2 : 1]},
    ...(canWebp ? [{label:'webpFormat',indexes:[1,3]}] : []),
  ].map(group=>`<tr><th scope="row">${e(t(group.label))}</th>${group.indexes.map((index,i)=>`<td><button type="button" data-action="copy-link" data-index="${index}" aria-label="${e(t('copy'))} ${e(t(group.label))} ${i ? 'Markdown' : 'URL'}">${icon('copy')}<span>${i ? 'Markdown' : 'URL'}</span></button></td>`).join('')}</tr>`).join('')}</tbody></table><div class="actions asset-secondary-actions"><a class="button secondary" href="${e(download)}" download="${e(item.filename)}">${e(t("download"))}</a>${button("share", "share")}</div></section><section class="panel asset-properties"><h2>${e(t("properties"))}</h2><dl class="asset-facts">${kv("size", bytes(item.size))}${canWebp ? `<div id="webp-size">${kv("webpSize", item.webpSize == null ? t("onDemand") : bytes(item.webpSize))}</div>` : ""}${item.isImage ? '<div id="image-dimensions"></div>' : ""}${kv("sortHits", item.hits || 0)}<div class="fact-wide">${kv("date", date(item.createdAt))}</div></dl><div class="protection-setting"><div><strong>${e(t("protection"))}</strong><span class="muted">${e(t(item.locked ? "protected" : "disabled"))}</span></div>${button(item.locked ? "unlockBtn" : "lockBtn", "lock", "secondary", "lock")}</div>${item.sha256?`<div class="asset-checksum"><span>SHA-256</span><code>${e(item.sha256)}</code><button type="button" class="icon-button" data-action="copy-hash" title="${e(t("copy"))}" aria-label="${e(t("copy"))} SHA-256">${icon("copy")}</button></div>`:""}</section><section class="panel asset-danger"><div class="danger-heading">${icon("trash")}<h2>${e(t("dangerZone"))}</h2></div><p>${e(t(item.locked?"unlockToRemove":"trashHelp"))}</p><div class="actions">${button("remove", "delete", "danger", "", item.locked ? "disabled" : "")}<a class="button secondary" href="#/trash">${e(t("openTrash"))}</a></div></section></aside></div>`;
  const stage = root.querySelector("#preview-stage"),
    status = root.querySelector("#preview-status");
  const showScale = item.isImage ? bindViewerControls(root.querySelector(".viewer-controls"), () => viewer, { signal, onExpand: () => openImagePreview({src: variant === "webp" ? item.pubPreviewPath : item.rawPreviewPath, filename: item.filename, signal}) }) : () => {};
  function renderPreview() {
    previewController?.abort();
    previewController = new AbortController();
    const previewSignal = previewController.signal;
    root
      .querySelectorAll('[data-action="raw"],[data-action="webp"]')
      .forEach((el) => {
        el.classList.toggle("selected", el.dataset.action === variant);
        el.setAttribute("aria-pressed", String(el.dataset.action === variant));
      });
    viewer = null;
    status.hidden = !item.isImage;
    status.textContent = t("loading");
    stage.innerHTML = item.isImage
      ? `<img draggable="false" src="${e(variant === "webp" ? item.pubPreviewPath : item.rawPreviewPath)}" alt="${e(item.filename)}">`
      : empty("unsupported", "unsupportedDesc", "", "file");
    const img = stage.querySelector("img");
    if (!img) return;
    viewer = mountViewer(stage, img, {
      signal: previewSignal,
      onScale: showScale,
    });
    const loaded = () => {
      if (signal.aborted || previewSignal.aborted) return;
      status.hidden = true;
      root.querySelector("#image-dimensions").innerHTML = kv(
        variant === "raw" ? "dimensions" : "optimizedDimensions",
        img.naturalWidth + " × " + img.naturalHeight,
      );
      if (variant === "webp")
        ctx
          .loadFiles(true)
          .then(() => {
            if (signal.aborted || previewSignal.aborted) return;
            const current = ctx.files.items.find(
              (i) => assetKey(i) === route.key,
            );
            if (current?.webpSize != null)
              root.querySelector("#webp-size").innerHTML = kv(
                "webpSize",
                bytes(current.webpSize),
              );
          })
          .catch(() => {});
    };
    img.addEventListener("load", loaded, { once: true, signal: previewSignal });
    if (img.complete && img.naturalWidth) loaded();
    img.addEventListener(
      "error",
      () => {
        stage.innerHTML = empty(
          "previewFailed",
          "unsupportedDesc",
          button("retry", "retry-preview"),
        );
        status.hidden = true;
      },
      { once: true, signal: previewSignal },
    );
  }
  signal.addEventListener("abort", () => previewController?.abort(), {
    once: true,
  });
  const changeVariant = (value) => {
    variant = value;
    history.replaceState(
      null,
      "",
      detailHref(item, {
        from: libraryBacklink(route.query.from),
        variant: value === "webp" ? "webp" : "",
      }),
    );
    renderPreview();
  };
  actions(
    root,
    {
      raw: () => changeVariant("raw"),
      webp: () => changeVariant("webp"),
      "retry-preview": renderPreview,
      "copy-link": (target) => copy(linkRows[Number(target.dataset.index)][1]),
      "copy-hash": () => copy(item.sha256),
      share: () => createShare(ctx, item, signal),
      lock: async () => {
        await confirmedMutation(
          () => ctx.api.lock(item, !item.locked),
          () => {
            item.locked = !item.locked;
            ctx.invalidateFiles();
          },
        );
        toast(
          t(item.locked ? "lockSuccess" : "unlockSuccess", {
            filename: item.filename,
          }),
        );
        ctx.render();
      },
      delete: async () => {
        if (
          !(await confirm(
            t("remove"),
            t("deleteConfirm", { filename: item.filename }),
            true,
          ))
        )
          return;
        await ctx.api.remove(item);
        ctx.invalidateFiles();
        toast(t("assetDeleted"));
        ctx.restoreFileScroll = true;
        navigate(back);
      },
    },
    signal,
  );
  root.querySelector(".back-link").addEventListener(
    "click",
    () => {
      ctx.restoreFileScroll = true;
    },
    { signal },
  );
  renderPreview();
}
