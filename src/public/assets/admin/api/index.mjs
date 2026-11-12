import { abortableDelay } from "./client.mjs";

export function createApi(request) {
  const get = (url, options) => request(url, options);
  const post = (url, json, options = {}) =>
    request(url, {
      method: "POST",
      ...options,
      ...(json === undefined ? {} : { json }),
    });
  return {
    status: () => get("/api/platform/status"),
    login: (credentials) => post("/api/platform/login", credentials),
    logout: () => post("/api/platform/logout"),
    config: (reveal = false) =>
      get("/api/platform/config" + (reveal ? "?reveal=1" : "")),
    save: (patch) =>
      request("/api/platform/config", {
        method: "PUT",
        json: { mode: "form", patch },
      }),
    saveRaw: (rawYaml, revision) =>
      request("/api/platform/config", {
        method: "PUT",
        json: { mode: "raw", rawYaml, revision },
      }),
    validateRaw: (rawYaml, revision) => post("/api/platform/config/preview", { rawYaml, revision }),
    healthPreview: (options) => get("/api/platform/health-preview",options),
    metrics: (options) => get("/api/platform/metrics", options),
    files: () => get("/api/modules/image-host/list"),
    trash: () => get("/api/modules/image-host/trash"),
    restoreTrash: (id) =>
      post(
        "/api/modules/image-host/trash/" + encodeURIComponent(id) + "/restore",
      ),
    deleteTrash: (id) =>
      request("/api/modules/image-host/trash/" + encodeURIComponent(id), {
        method: "DELETE",
      }),
    backupFiles: () => get("/api/platform/backup/files"),
    previewDraft: (data, signal) =>
      post("/api/modules/image-host/preview", data, {
        signal,
        responseType: "blob",
      }),
    lock: (item, locked) =>
      post("/api/modules/image-host/lock", {
        year: item.year,
        month: item.month,
        filename: item.filename,
        locked,
      }),
    remove: (item) =>
      request(
        "/api/modules/image-host/item/" +
          [item.year, item.month, item.filename]
            .map(encodeURIComponent)
            .join("/"),
        { method: "DELETE" },
      ),
    clearCache: () => post("/api/modules/image-host/cache/clear"),
    integrity: () => get("/api/modules/image-host/integrity"),
    startIntegrity: () => post("/api/modules/image-host/integrity"),
    cancelIntegrity: () =>
      request("/api/modules/image-host/integrity", { method: "DELETE" }),
    shares: () => get("/api/modules/share/list"),
    share: (item, options) =>
      post("/api/modules/share/create", {
        year: item.year,
        month: item.month,
        filename: item.filename,
        ...options,
      }),
    revoke: (id) =>
      request("/api/modules/share/" + encodeURIComponent(id), {
        method: "DELETE",
      }),
    backup: () => get("/api/platform/backup/status"),
    runBackup: () => post("/api/platform/backup/run"),
    testBackup: (kind, value) =>
      post("/api/platform/backup/test-" + kind, {
        [kind === "bark" ? "bark_url" : "rclone_target"]: value,
      }),
    update: (remote = false) =>
      get("/api/platform/update/status" + (remote ? "?fetch=1" : "")),
    install: () => post("/api/platform/update/pull"),
    restart: () => post("/api/platform/restart"),
    async upload(file, signal) {
      // Uploads may retry because the server deduplicates the original's full hash.
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const body = new FormData();
        body.append("file", file);
        try {
          return await request("/api/image/upload", {
            method: "POST",
            headers: { "X-File-Name": encodeURIComponent(file.name) },
            body,
            signal,
          });
        } catch (error) {
          if (
            signal.aborted ||
            attempt >= 4 ||
            (error.status && ![429, 500, 502, 503, 504].includes(error.status))
          )
            throw error;
          await abortableDelay(
            error.retryAfterMs ?? 1000 * 2 ** attempt + Math.random() * 250,
            signal,
          );
        }
      }
    },
  };
}
