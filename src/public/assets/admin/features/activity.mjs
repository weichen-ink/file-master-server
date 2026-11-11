import { t } from "../locale.mjs";
import { e, button, dialog, actions, notice, downloadJson } from "../ui.mjs";

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
      onMount(el) {
        const controller = new AbortController(),
          { signal } = controller;
        const unsubscribe = ctx.tasks.subscribe(({ integrity: job }) => {
          el.querySelector(".activity-result").innerHTML =
            job && job.state !== "idle"
              ? `<p><strong>${e(t(job.state))}</strong></p><p>${e(t("integrityDetail", { checked: job.checked || 0, matched: job.matched || 0, issues: job.issues?.length || 0 }))}</p>${job.state === "running" ? "<progress></progress>" : ""}${job.error ? notice(job.error, "danger") : ""}${job.pollError ? notice(job.pollError, "warning") : ""}${job.issues?.length ? `<div class="issue-list">${job.issues.map((i) => `<p><strong>${e(i.path)}</strong><br>${e(i.error || i.type)}</p>`).join("")}</div>` : ""}<div class="actions">${job.state === "running" ? button("stop", "stop-integrity") : button("runAgain", "start-integrity")}${job.state !== "running" ? button("btnDownloadCheck", "download-report") : ""}</div>`
              : `<p>${e(t("loading"))}</p>`;
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
