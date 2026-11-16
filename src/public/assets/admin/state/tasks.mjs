import { t } from "../locale.mjs";
import { promptFileConflict } from "../features/conflict-dialog.mjs";
import { e, icon, button, notice, dialog, actions, downloadJson, toast } from "../ui.mjs";

function promptUploadConflict(file, conflict, hasMore, displayName = file.name, api = null, initialWarning = "") {
  if (typeof document === "undefined") return Promise.resolve({ action: "skip" });
  const isImage = /^image\//i.test(file.type || "");
  const localUrl = isImage ? URL.createObjectURL(file) : "";
  const localThumbHtml = localUrl ? `<img src="${e(localUrl)}" alt="">` : icon("file", 28);
  return promptFileConflict({
    title: t("uploadConflictTitle"),
    desc: t("uploadConflictDesc", { name: displayName }),
    localLabel: t("uploadConflictLocal"),
    localName: displayName,
    localSize: file.size,
    localThumbHtml,
    conflict,
    hasMore,
    cancelLabel: t("uploadConflictSkipBtn"),
    initialWarning,
    api,
  }).finally(() => {
    if (localUrl) URL.revokeObjectURL(localUrl);
  });
}

export function createTasks(api, onFilesChanged) {
  const listeners = new Set();
  const jobs = {};
  let uploadController;
  let pending = [];
  let uploadPreviewUrls = [];
  const releaseUploadPreviews = () => {
    uploadPreviewUrls.forEach(url => URL.revokeObjectURL(url));
    uploadPreviewUrls = [];
  };
  let integrityTimer,
    backupTimer,
    epoch = 0;
  const emit = () => listeners.forEach((fn) => fn(jobs));
  const service = {
    jobs,
    subscribe(fn) {
      listeners.add(fn);
      fn(jobs);
      return () => listeners.delete(fn);
    },
    async upload(files, { retry = false } = {}) {
      if (uploadController || !files?.length) return;
      const session = epoch;
      if (!retry) releaseUploadPreviews();
      const selected = retry ? [...pending] : [...files].map((file) => {
        const isImage = /^image\//i.test(file.type || "");
        const localPreviewUrl = isImage && file instanceof Blob ? URL.createObjectURL(file) : "";
        if (localPreviewUrl) uploadPreviewUrls.push(localPreviewUrl);
        return { file, row: { name: file.name, filename: file.name, ext: file.name.split(".").pop(),
          size: file.size, isImage, localPreviewUrl, state: "queued" } };
      });
      const controller = (uploadController = new AbortController());
      pending = [];
      const job = retry ? jobs.upload : (jobs.upload = {
        state: "running",
        done: 0,
        total: selected.length,
        success: 0,
        duplicates: 0,
        skipped: 0,
        failed: 0,
        items: [],
        results: selected.map(({ row }) => row),
      });
      job.state = "running";
      job.items = [];
      for (const { row } of selected) { row.state = "queued"; delete row.error; }
      const update = () => {
        job.success = job.results.filter(row => ["uploaded", "replaced"].includes(row.state)).length;
        job.duplicates = job.results.filter(row => row.state === "reused").length;
        job.skipped = job.results.filter(row => row.state === "skipped").length;
        job.failed = job.results.filter(row => ["failed", "cancelled"].includes(row.state)).length;
        job.done = job.results.filter(row => !["queued", "uploading", "cancelled"].includes(row.state)).length;
        emit();
      };
      update();
      let batchStrategy = null;
      try {
        for (let i = 0; i < selected.length; i++) {
          if (controller.signal.aborted) {
            const remaining = selected.slice(i);
            remaining.forEach(({ row }) => { row.state = "cancelled"; });
            pending.push(...remaining);
            break;
          }
          const { file, row } = selected[i];
          row.state = "uploading";
          job.current = file.name;
          update();
          try {
            let result = null;
            let skipped = false;
            let currentName = file.name;
            let uploadOpts = {};
            let renameAttempts = 0;
            while (true) {
              try {
                result = await api.upload(file, controller.signal, { filename: currentName, ...uploadOpts });
                break;
              } catch (error) {
                if (error.status === 409 && (error.details?.conflict || error.data?.conflict || error.details?.code === "CONFLICT_TARGET_CHANGED")) {
                  const conflict = error.details?.conflict || error.data?.conflict;
                  if (!conflict) throw new Error(t("uploadConflictTargetChanged"));
                  const canBatchApply = batchStrategy && error.details?.code !== "CONFLICT_TARGET_CHANGED" &&
                    !(batchStrategy === "replace" && (conflict.locked || conflict.code !== "NAME_CONFLICT"));
                  const retryWarn = error.details?.code === "CONFLICT_TARGET_CHANGED"
                    ? t("uploadConflictTargetChanged")
                    : renameAttempts > 0 ? t("uploadConflictRenameExists", { name: currentName }) : "";
                  const choice = canBatchApply
                    ? { action: batchStrategy, target: conflict }
                    : await promptUploadConflict(file, conflict, selected.length - i > 1, currentName, api, retryWarn);
                  if (choice.action === "replace") {
                    const target = choice.target || conflict;
                    if (target.code === "NAME_CONFLICT" && !target.locked) {
                      if (choice.applyToAll) batchStrategy = "replace";
                      if (choice.filename) currentName = choice.filename;
                      uploadOpts = {
                        conflictStrategy: "replace", conflictTargetYear: target.year, conflictTargetMonth: target.month,
                        conflictTargetFilename: target.filename, conflictTargetSha256: target.sha256,
                      };
                      continue;
                    }
                  }
                  if (choice.action === "rename") {
                    if (choice.filename && choice.filename !== currentName) {
                      currentName = choice.filename;
                      uploadOpts = {};
                      renameAttempts++;
                    } else {
                      uploadOpts = { conflictStrategy: "rename" };
                    }
                    if (choice.applyToAll) batchStrategy = "rename";
                    continue;
                  }
                  if (choice.applyToAll) batchStrategy = "skip";
                  skipped = true;
                  break;
                }
                throw error;
              }
            }
            if (session !== epoch) return;
            if (skipped) row.state = "skipped";
            else if (result) {
              Object.assign(row, {
                state: result.deduplicated ? "reused" : result.replaced ? "replaced" : "uploaded",
                filename: result.filename || currentName,
                year: result.year, month: result.month,
                category: result.category,
                isImage: result.category === "image",
                rawPreviewPath: result.rawUrl,
                thumbnailUrl: result.thumbnailUrl || (result.category === "image" && result.rawUrl
                  ? result.rawUrl + (result.rawUrl.includes("?") ? "&" : "?") + "thumbnail=1" : ""),
              });
            }
          } catch (error) {
            if (session !== epoch) return;
            pending.push({ file, row });
            row.state = error.name === "AbortError" ? "cancelled" : "failed";
            row.error = error.name === "AbortError" ? t("cancelled") : error.message;
            job.items.push({
              name: file.name,
              error:
                error.name === "AbortError" ? t("cancelled") : error.message,
            });
          }
          update();
        }
      } finally {
        if (session !== epoch) return;
        uploadController = null;
        job.state = controller.signal.aborted
          ? "cancelled"
          : pending.length
            ? "error"
            : "completed";
        job.current = "";
        update();
        try {
          await onFilesChanged();
        } catch (error) {
          toast(error.message);
        }
      }
    },
    cancelUpload() {
      uploadController?.abort();
    },
    retryUpload() {
      return this.upload(pending, { retry: true });
    },
    async startIntegrity() {
      const session = epoch;
      const data = await api.startIntegrity();
      if (session !== epoch) return;
      jobs.integrity = data;
      emit();
      await this.pollIntegrity();
    },
    async pollIntegrity() {
      const session = epoch;
      clearTimeout(integrityTimer);
      try {
        const data = await api.integrity();
        if (session !== epoch) return;
        jobs.integrity = data;
      } catch (error) {
        if (session !== epoch) return;
        if (jobs.integrity) jobs.integrity.pollError = error.message;
      }
      emit();
      if (jobs.integrity?.state === "running")
        integrityTimer = setTimeout(() => this.pollIntegrity(), 2000);
    },
    async cancelIntegrity() {
      const session = epoch;
      await api.cancelIntegrity();
      if (session === epoch) await this.pollIntegrity();
    },
    async pollBackup() {
      const session = epoch;
      clearTimeout(backupTimer);
      try {
        const data = await api.backup();
        if (session !== epoch) return;
        jobs.backup = data;
      } catch (error) {
        if (session !== epoch) return;
        if (jobs.backup) jobs.backup.pollError = error.message;
      }
      emit();
      if (jobs.backup?.isBackingUp)
        backupTimer = setTimeout(() => this.pollBackup(), 2000);
    },
    async runBackup() {
      const session = epoch;
      await api.runBackup();
      if (session === epoch) await this.pollBackup();
    },
    async resume() {
      await Promise.allSettled([this.pollIntegrity(), this.pollBackup()]);
    },
    report() {
      const data = jobs.integrity;
      if (!data) return;
      const issueCount = data.issues?.length || 0;
      const isHealthy = !data.error && issueCount === 0;
      const tone = isHealthy ? "ok" : "warn";
      const badgeIcon = isHealthy ? "check" : "close";
      return dialog(
        t("integrityModalTitle"),
        `<div class="activity-result">
          <div class="integrity-status-banner is-${tone}">
            <span class="integrity-status-icon">${icon(badgeIcon)}</span>
            <div class="integrity-status-text">
              <strong>${e(t(data.state || (isHealthy ? "completed" : "error")))}</strong>
              <span>${e(t("integrityDetail", { checked: data.checked || 0, matched: data.matched || 0, issues: issueCount }))}</span>
            </div>
          </div>
          <div class="integrity-metrics">
            <div class="integrity-metric">
              <span>${e(t("integrityChecked"))}</span>
              <strong>${e(String(data.checked || 0))}</strong>
            </div>
            <div class="integrity-metric ${data.matched ? "is-ok" : ""}">
              <span>${e(t("integrityMatched"))}</span>
              <strong>${e(String(data.matched || 0))}</strong>
            </div>
            <div class="integrity-metric ${issueCount ? "is-danger" : ""}">
              <span>${e(t("integrityIssues"))}</span>
              <strong>${e(String(issueCount))}</strong>
            </div>
          </div>
          ${data.error ? notice(data.error, "danger") : ""}
          ${issueCount ? `<div class="table-wrap"><table><thead><tr><th>${e(t("lblPath"))}</th><th>${e(t("lblIssueType"))}</th><th>${e(t("lblIssueDetail"))}</th></tr></thead><tbody>${data.issues.map((i) => `<tr><td class="break-all">${e(i.path)}</td><td>${e(i.type)}</td><td class="break-all">${e(i.error || i.actual || "—")}</td></tr>`).join("")}</tbody></table></div>` : ""}
        </div>`,
        { submit: t("btnDownloadCheck"), className: issueCount ? "" : "dialog-medium", symbol: "check" },
      ).then((ok) => ok && downloadJson(data, "file-master-integrity.json"));
    },
    clear() {
      releaseUploadPreviews();
      epoch++;
      uploadController?.abort();
      uploadController = null;
      clearTimeout(integrityTimer);
      clearTimeout(backupTimer);
      Object.keys(jobs).forEach((k) => delete jobs[k]);
      pending = [];
      emit();
    },
  };
  return service;
}
