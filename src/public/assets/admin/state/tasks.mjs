import { t } from "../locale.mjs";
import { e, icon, button, notice, dialog, downloadJson, toast } from "../ui.mjs";

export function createTasks(api, onFilesChanged) {
  const listeners = new Set();
  const jobs = {};
  let uploadController;
  let pending = [];
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
    async upload(files) {
      if (uploadController || !files?.length) return;
      const session = epoch;
      const selected = [...files];
      const controller = (uploadController = new AbortController());
      pending = [];
      const job = (jobs.upload = {
        state: "running",
        done: 0,
        total: selected.length,
        success: 0,
        duplicates: 0,
        failed: 0,
        items: [],
      });
      emit();
      try {
        for (let i = 0; i < selected.length; i++) {
          if (controller.signal.aborted) {
            pending.push(...selected.slice(i));
            break;
          }
          const file = selected[i];
          job.current = file.name;
          emit();
          try {
            const result = await api.upload(file, controller.signal);
            if (session !== epoch) return;
            if (result.deduplicated) job.duplicates++;
            else job.success++;
          } catch (error) {
            if (session !== epoch) return;
            pending.push(file);
            job.items.push({
              name: file.name,
              error:
                error.name === "AbortError" ? t("cancelled") : error.message,
            });
          }
          job.done++;
          job.failed = pending.length;
          emit();
        }
      } finally {
        if (session !== epoch) return;
        uploadController = null;
        job.failed = pending.length;
        job.state = controller.signal.aborted
          ? "cancelled"
          : pending.length
            ? "error"
            : "completed";
        job.current = "";
        emit();
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
      return this.upload(pending);
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
        { submit: t("btnDownloadCheck"), className: issueCount ? "" : "dialog-medium" },
      ).then((ok) => ok && downloadJson(data, "file-master-integrity.json"));
    },
    clear() {
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
