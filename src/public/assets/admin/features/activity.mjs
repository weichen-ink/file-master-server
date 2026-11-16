import { t } from "../locale.mjs";
import { e, icon, metaItem, bytes, button, dialog, actions, notice, downloadJson } from "../ui.mjs";
import { collection, fileIdentity, fileThumbnail, thumbnailFallback } from "./collection.mjs";
import { detailHref } from "../router.mjs";

export function renderUploadResult(job) {
  const running = job.state === "running";
  const unfinished = job.failed > 0 || job.state === "cancelled";
  const tone = running ? "running" : unfinished ? "warn" : "ok";
  const summary = [];
  if (job.success) summary.push(t("uploadStatSuccess", { count: job.success }));
  if (job.duplicates) summary.push(t("uploadStatReused", { count: job.duplicates }));
  if (job.skipped) summary.push(t("uploadStatSkipped", { count: job.skipped }));
  if (job.failed) summary.push(t("uploadStatFailed", { count: job.failed }));
  const title = running ? t("uploadingFiles") : unfinished ? t("uploadResultsIncomplete") : t("uploadResultsComplete");
  const rows = (job.results || []).map(row => {
    const ready = ["uploaded", "replaced", "reused"].includes(row.state);
    const canOpen = ready && row.year && row.month && row.filename;
    const stateKey = { queued: "uploadRowQueued", uploading: "uploadRowUploading", uploaded: "uploadRowUploaded", replaced: "uploadRowReplaced", reused: "uploadRowReused", skipped: "uploadRowSkipped", failed: "uploadRowFailed", cancelled: "uploadRowCancelled" }[row.state];
    const filename = row.filename || row.name;
    const details = [row.name !== filename ? t("uploadOriginalName", { name: row.name }) : ""];
    if (row.state === "reused") details.push(t("uploadReuseExplanation"));
    if (row.error) details.push(row.error);
    const status = `<span class="collection-status${ready ? " success" : ""}">${e(t(stateKey || "uploadRowQueued"))}</span>`;
    return {
      file: fileIdentity({ ...row, filename }, {
        href: canOpen ? detailHref(row) : "",
        thumbnail: fileThumbnail({ ...row, thumbnailUrl: row.thumbnailUrl || row.localPreviewUrl }),
        meta: details.filter(Boolean).join(" · "),
        summary: `${typeof row.size === "number" ? metaItem("hardDrive", bytes(row.size)) : ""}${row.year && row.month ? metaItem("folder", `${row.year}/${row.month}`) : ""}${status}`,
      }),
      state: status,
      actions: canOpen ? `<a class="button quiet" href="${e(detailHref(row))}" aria-label="${e(t("uploadOpenFileNamed", { name: filename }))}">${e(t("uploadOpenFile"))}</a>` : "",
    };
  });
  const files = collection([
    { key: "file", label: "file" }, { key: "state", label: "shareColStatus" }, { key: "actions", label: "shareColActions" },
  ], rows, { className: "file-collection" });
  return `<div class="integrity-status-banner upload-status is-${tone}" role="status">
    <span class="integrity-status-icon">${icon(running ? "upload" : unfinished ? "alert" : "check")}</span>
    <div class="integrity-status-text"><strong>${e(title)}</strong><span>${e(running ? t("uploadProcessed", { done: job.done, total: job.total }) : summary.join(" · "))}</span></div>
    </div>
    ${running ? `<progress aria-label="${e(t("uploadProcessed", { done: job.done, total: job.total }))}" max="${job.total}" value="${job.done}"></progress>` : ""}
    ${running || job.failed ? `<div class="actions upload-result-actions">${running ? button("stop", "stop-upload") : button("retryUnfinished", "retry-upload")}</div>` : ""}
    ${rows.length ? `<section class="upload-results" aria-label="${e(t("uploadResultFiles"))}"><div class="upload-results-heading"><h3>${e(t("uploadResultFiles"))}</h3><span>${e(t("uploadFileCount", { count: job.total }))}</span></div>${files}</section>` : ""}`;
}

// Jobs survive route changes; controls and drop targets exist only in an explicit dialog.
export function openUpload(ctx) {
  return dialog(
    t("upload"),
    `<div class="upload-zone" tabindex="0"><p>${e(t("uploadDrop"))}</p>${button("selectFiles", "select-files", "primary", "upload")}<input type="file" multiple hidden></div><div class="activity-result"></div>`,
    {
      symbol: "upload",
      className: "dialog-upload",
      onMount(el) {
        const controller = new AbortController(),
          { signal } = controller;
        const input = el.querySelector("input"),
          zone = el.querySelector(".upload-zone");
        const send = (files) => ctx.tasks.upload([...files]);
        input.addEventListener(
          "change",
          () => {
            send(input.files);
            input.value = "";
          },
          { signal },
        );
        zone.addEventListener(
          "dragover",
          (event) => {
            event.preventDefault();
            zone.classList.add("drag-over");
          },
          { signal },
        );
        zone.addEventListener(
          "dragleave",
          () => zone.classList.remove("drag-over"),
          { signal },
        );
        zone.addEventListener(
          "drop",
          (event) => {
            event.preventDefault();
            event.stopPropagation();
            zone.classList.remove("drag-over");
            send(event.dataTransfer.files);
          },
          { signal },
        );
        el.addEventListener(
          "paste",
          (event) => {
            if (event.clipboardData?.files.length) {
              event.preventDefault();
              send(event.clipboardData.files);
            }
          },
          { signal },
        );
        const unsubscribe = ctx.tasks.subscribe(({ upload: job }) => {
          const select = el.querySelector('[data-action="select-files"]');
          select.disabled = job?.state === "running";
          select.className = job ? "button secondary" : "button primary";
          select.innerHTML = icon("upload") + e(t(job ? "uploadAddMore" : "selectFiles"));
          el.classList.toggle("has-upload-results", Boolean(job));
          const elResult = el.querySelector(".activity-result");
          if (!job) {
            elResult.innerHTML = "";
            return;
          }
          const content = el.querySelector(".dialog-content");
          const scroll = content.scrollTop;
          elResult.innerHTML = renderUploadResult(job);
          content.scrollTop = scroll;
        });
        el.addEventListener("error", thumbnailFallback, { capture: true, signal });
        el.addEventListener("click", event => {
          if (event.target.closest('.upload-results a[href^="#/files/"]') && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) el.close();
        }, { signal });
        actions(
          el,
          {
            "select-files": () => input.click(),
            "stop-upload": () => ctx.tasks.cancelUpload(),
            "retry-upload": () => ctx.tasks.retryUpload(),
          },
          signal,
        );
        el.addEventListener(
          "close",
          () => {
            unsubscribe();
            controller.abort();
          },
          { once: true },
        );
      },
    },
  );
}
export function openIntegrity(ctx) {
  return dialog(
    t("btnIntegrity"),
    '<div class="activity-result" aria-live="polite"></div>',
    {
      className: "dialog-medium",
      symbol: "check",
      onMount(el) {
        const controller = new AbortController(),
          { signal } = controller;
        const unsubscribe = ctx.tasks.subscribe(({ integrity: job }) => {
          const elResult = el.querySelector(".activity-result");
          if (!job || job.state === "idle") {
            elResult.innerHTML = `<p class="muted">${e(t("loading"))}</p>`;
            return;
          }
          const issueCount = job.issues?.length || 0;
          const isRunning = job.state === "running";
          const isHealthy = !isRunning && job.state !== "failed" && job.state !== "cancelled" && issueCount === 0;
          const tone = isRunning ? "running" : isHealthy ? "ok" : "warn";
          const badgeIcon = isRunning ? "clock" : isHealthy ? "check" : "close";
          elResult.innerHTML = `
            <div class="integrity-status-banner is-${tone}">
              <span class="integrity-status-icon">${icon(badgeIcon)}</span>
              <div class="integrity-status-text">
                <strong>${e(t(job.state))}</strong>
                <span>${e(t("integrityDetail", { checked: job.checked || 0, matched: job.matched || 0, issues: issueCount }))}</span>
              </div>
            </div>
            ${isRunning ? "<progress></progress>" : ""}
            <div class="integrity-metrics">
              <div class="integrity-metric">
                <span>${e(t("integrityChecked"))}</span>
                <strong>${e(String(job.checked || 0))}</strong>
              </div>
              <div class="integrity-metric ${job.matched ? "is-ok" : ""}">
                <span>${e(t("integrityMatched"))}</span>
                <strong>${e(String(job.matched || 0))}</strong>
              </div>
              <div class="integrity-metric ${issueCount ? "is-danger" : ""}">
                <span>${e(t("integrityIssues"))}</span>
                <strong>${e(String(issueCount))}</strong>
              </div>
            </div>
            ${job.error ? notice(job.error, "danger") : ""}
            ${job.pollError ? notice(job.pollError, "warning") : ""}
            ${issueCount ? `<div class="issue-list">${job.issues.map((i) => `<div class="issue-item"><strong>${e(i.path)}</strong><span>${e(i.error || i.type)}</span></div>`).join("")}</div>` : ""}
            <div class="actions integrity-actions">
              ${isRunning ? button("stop", "stop-integrity") : button("runAgain", "start-integrity", isHealthy ? "secondary" : "primary")}
              ${!isRunning ? button("btnDownloadCheck", "download-report") : ""}
            </div>`;
        });
        actions(
          el,
          {
            "stop-integrity": () => ctx.tasks.cancelIntegrity(),
            "start-integrity": () => ctx.tasks.startIntegrity(),
            "download-report": () =>
              downloadJson(
                ctx.tasks.jobs.integrity,
                "file-master-integrity.json",
              ),
          },
          signal,
        );
        el.addEventListener(
          "close",
          () => {
            unsubscribe();
            controller.abort();
          },
          { once: true },
        );
        if (ctx.tasks.jobs.integrity?.state !== "running")
          ctx.tasks.startIntegrity().catch((error) => {
            if (!signal.aborted)
              el.querySelector(".activity-result").innerHTML = notice(
                error.message,
                "danger",
              );
          });
      },
    },
  );
}
