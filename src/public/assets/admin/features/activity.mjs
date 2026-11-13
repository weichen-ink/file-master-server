import { t } from "../locale.mjs";
import { e, icon, button, dialog, actions, notice, downloadJson } from "../ui.mjs";

// Jobs survive route changes; controls and drop targets exist only in an explicit dialog.
export function openUpload(ctx) {
  return dialog(
    t("upload"),
    `<div class="upload-zone" tabindex="0"><p>${e(t("uploadDrop"))}</p>${button("selectFiles", "select-files", "primary", "upload")}<input type="file" multiple hidden></div><div class="activity-result" aria-live="polite"></div>`,
    {
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
          el.querySelector('[data-action="select-files"]').disabled =
            job?.state === "running";
          el.querySelector(".activity-result").innerHTML = job
            ? `<p><strong>${e(t(job.state))}</strong> · ${e(t("uploadProgressNew", job))}</p><progress max="${job.total}" value="${job.done}"></progress><p class="break-all">${e(job.current || "")}</p>${job.state === "running" ? button("stop", "stop-upload") : job.failed ? button("retryUnfinished", "retry-upload") : ""}${job.items.length ? `<details><summary>${e(t("lblFailed"))}</summary>${job.items.map((i) => `<p>${e(i.name)} · ${e(i.error)}</p>`).join("")}</details>` : ""}`
            : "";
        });
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
