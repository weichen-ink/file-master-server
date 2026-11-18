import { t } from "../locale.mjs";
import { e, icon, metaItem, notice, dialog, actions } from "../ui.mjs";

export function formatConflictSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** idx).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function promptFileConflict({
  title,
  localLabel,
  localName,
  localSize,
  localThumbHtml,
  conflict,
  hasMore = false,
  cancelLabel,
  initialWarning = "",
  renameLabel,
  renameDesc,
  replaceLabel,
  replaceDesc,
  lockedHint,
  initialRenameBase,
  api = null,
  checkYear = "",
  checkMonth = "",
}) {
  if (typeof document === "undefined") return Promise.resolve({ action: "skip" });
  const dot = localName.lastIndexOf(".");
  const defaultBase = dot > 0 ? localName.slice(0, dot) : localName;
  const baseName = initialRenameBase ?? defaultBase;
  const ext = dot > 0 ? localName.slice(dot) : "";
  const renderRemoteCardInner = (item, fallbackName) => {
    const remoteName = item?.filename || fallbackName;
    const isRemoteImg = item?.category === "image" && item?.rawUrl;
    const thumb = isRemoteImg ? `<img src="${e(item.pubUrl || item.rawUrl)}" alt="">` : icon("file", 28);
    const bucket = item?.year && item?.month ? `${item.year}/${item.month}` : "";
    return `<div class="file-thumbnail">
        ${thumb}
      </div>
      <div class="file-caption">
        <h3 title="${e(remoteName)}">${e(remoteName)}</h3>
        <p>${metaItem("hardDrive", formatConflictSize(item?.size))}${bucket ? `<span class="meta-sep" aria-hidden="true"></span>${metaItem("folder", bucket)}` : ""}${item?.locked ? `<span class="meta-sep" aria-hidden="true"></span>${metaItem("lock", t("protected"))}` : ""}</p>
      </div>`;
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (choice) => {
      if (settled) return;
      settled = true;
      resolve(choice);
    };
    const batchBox = hasMore
      ? `<label class="checkbox-row conflict-batch"><input type="checkbox" data-apply-all> <span>${e(t("uploadConflictApplyAll"))}</span></label>`
      : "";
    const topWarning = initialWarning ? notice(initialWarning, "warning") : "";
    dialog(
      title,
      `${topWarning}
      <div class="conflict-compare-grid">
        <div class="conflict-card-col">
          <div class="conflict-col-label is-local">${e(localLabel)}</div>
          <article class="file-card is-local">
            <div class="file-thumbnail">
              ${localThumbHtml}
            </div>
            <div class="file-caption">
              <h3 title="${e(localName)}">${e(localName)}</h3>
              <p>${metaItem("hardDrive", formatConflictSize(localSize))}</p>
            </div>
          </article>
        </div>
        <div class="conflict-card-col">
          <div class="conflict-col-label">${e(t("uploadConflictRemote"))}</div>
          <article class="file-card" data-conflict-remote>${renderRemoteCardInner(conflict, localName)}</article>
        </div>
      </div>
      <section class="conflict-resolution">
      <div class="conflict-section-title" id="fm-conflict-action">${e(t("uploadConflictActionTitle"))}</div>
      <div class="conflict-choice-grid" data-conflict-choices role="radiogroup" aria-labelledby="fm-conflict-action"></div>
      <p class="conflict-choice-desc" id="fm-conflict-choice-desc" data-conflict-choice-desc role="status"></p>
      <div class="field conflict-rename-field" data-conflict-rename-wrap>
        <label for="fm-conflict-rename">${e(t("uploadConflictNewName"))}</label>
        <div class="conflict-input-group" data-conflict-input-group>
          <input id="fm-conflict-rename" type="text" value="${e(baseName)}">
          ${ext ? `<span class="conflict-input-ext">${e(ext)}</span>` : ""}
        </div>
        <div class="conflict-feedback" data-conflict-rename-feedback></div>
      </div>
      </section>${batchBox}`,
      {
        className: "dialog-medium conflict-dialog",
        symbol: "files",
        focusSelector: '[data-choice][aria-checked="true"]',
        cancel: cancelLabel || t("uploadConflictSkipBtn"),
        onMount(modal) {
          const controller = new AbortController();
          const applyAll = () => Boolean(modal.querySelector("[data-apply-all]")?.checked);
          const input = modal.querySelector("#fm-conflict-rename");
          const inputGroup = modal.querySelector("[data-conflict-input-group]");
          const renameWrap = modal.querySelector("[data-conflict-rename-wrap]");
          const choicesEl = modal.querySelector("[data-conflict-choices]");
          const choiceDescEl = modal.querySelector("[data-conflict-choice-desc]");
          const feedbackEl = modal.querySelector("[data-conflict-rename-feedback]");
          const footer = modal.querySelector("footer");
          const confirmBtn = document.createElement("button");
          confirmBtn.type = "button";
          confirmBtn.className = "button primary";
          confirmBtn.dataset.action = "conflict-confirm";
          confirmBtn.textContent = t("confirm");
          footer?.append(confirmBtn);

          const activeConflict = conflict;
          const activeConflictBase = defaultBase;
          let selectedAction = "rename";
          let checkTimer = null;
          let checkAbort = null;
          let lastCheckedName = "";
          let lastCheckedResult = null;

          const normalizeBase = (v) => String(v || "").trim().replace(/[\s_]+/g, "_").toLowerCase();
          const buildTargetName = () => {
            const raw = String(input?.value || "").trim();
            if (!raw) return "";
            return ext && raw.toLowerCase().endsWith(ext.toLowerCase()) ? raw : `${raw}${ext}`;
          };
          const getOptions = (item) => {
            const list = [
              { id: "rename", label: renameLabel || t("uploadConflictRenameBtn"), desc: renameDesc || t("uploadConflictRenameDesc") },
            ];
            const unavailable = item?.locked || item?.code !== "NAME_CONFLICT";
            list.push({ id: "replace", label: replaceLabel || t("uploadConflictReplaceBtn"), desc: replaceDesc || t("uploadConflictReplaceDesc"), danger: true,
              unavailable, reason: item?.locked ? lockedHint || t("uploadConflictLockedHint") : t("uploadConflictReservedHint") });
            return list;
          };
          const setConfirmEnabled = (enabled) => {
            confirmBtn.disabled = !enabled;
            confirmBtn.setAttribute("aria-disabled", String(!enabled));
          };
          const setFeedback = (html, invalid = false) => {
            if (feedbackEl) feedbackEl.innerHTML = html;
            if (inputGroup) inputGroup.classList.toggle("is-invalid", Boolean(invalid));
            if (input) {
              if (invalid) input.setAttribute("aria-invalid", "true");
              else input.removeAttribute("aria-invalid");
            }
          };
          const syncConfirmState = () => {
            if (selectedAction !== "rename") {
              setConfirmEnabled(true);
              return;
            }
            const val = String(input?.value || "").trim();
            const changed = Boolean(val) && normalizeBase(val) !== normalizeBase(activeConflictBase);
            const targetName = buildTargetName();
            if (!changed || (lastCheckedName === targetName && lastCheckedResult?.status === "conflict")) {
              setConfirmEnabled(false);
              return;
            }
            setConfirmEnabled(true);
          };
          const renderChoices = () => {
            const opts = getOptions(activeConflict);
            if (!opts.some((o) => o.id === selectedAction && !o.unavailable)) selectedAction = opts[0].id;
            if (choicesEl) {
              choicesEl.innerHTML = opts
                .map(
                  (o) => `<button type="button" role="radio" tabindex="${o.id === selectedAction ? "0" : "-1"}" aria-checked="${o.id === selectedAction ? "true" : "false"}"${o.unavailable ? ` aria-disabled="true" title="${e(o.reason)}" aria-describedby="fm-conflict-choice-desc"` : ""} class="conflict-choice-card${o.id === selectedAction ? " is-selected" : ""}${o.danger ? " is-danger" : ""}" data-choice="${e(o.id)}">${o.unavailable ? icon("lock") : ""}<span>${e(o.label)}</span><span class="conflict-choice-check">${icon("check")}</span></button>`,
                )
                .join("");
            }
            const current = opts.find((o) => o.id === selectedAction);
            if (choiceDescEl) choiceDescEl.textContent = current?.desc || "";
            if (renameWrap) renameWrap.style.display = selectedAction === "rename" ? "" : "none";
            confirmBtn.textContent = current?.label || t("confirm");
            confirmBtn.className = current?.danger ? "button danger" : "button primary";
            syncConfirmState();
          };
          const choose = (id) => {
            const option = getOptions(activeConflict).find(o => o.id === id);
            if (!option) return;
            if (option.unavailable) {
              // Keep the current valid choice; unavailable controls explain themselves on activation.
              choiceDescEl.textContent = option.reason;
              choiceDescEl.classList.add("is-unavailable");
              choicesEl.querySelector(`[data-choice="${id}"]`)?.focus();
              return;
            }
            selectedAction = id;
            choiceDescEl.classList.remove("is-unavailable");
            renderChoices();
            choicesEl.querySelector('[aria-checked="true"]')?.focus();
          };
          const showRenameConflict = (targetName, conflictInfo = null) => {
            // A rename check never changes the file being compared or the overwrite target.
            const key = conflictInfo?.code === "NAME_RESERVED" || conflictInfo?.reserved
              ? "uploadConflictRenameReserved"
              : "uploadConflictRenameExists";
            setFeedback(`<p class="conflict-feedback-error">${e(t(key, { name: targetName }))}</p>`, true);
            syncConfirmState();
          };
          const runAvailabilityCheck = async (targetName) => {
            if (typeof api?.uploadCheck !== "function") return { status: "unavailable" };
            if (checkAbort) checkAbort.abort();
            checkAbort = new AbortController();
            const checkItem = checkYear && checkMonth
              ? { filename: targetName, year: checkYear, month: checkMonth }
              : { filename: targetName };
            const res = await api.uploadCheck([checkItem], checkAbort.signal);
            const item = res?.results?.[0] || { status: "unavailable" };
            lastCheckedName = targetName;
            lastCheckedResult = item;
            return item;
          };

          const syncRenameInput = () => {
            if (checkTimer) {
              clearTimeout(checkTimer);
              checkTimer = null;
            }
            if (checkAbort) {
              checkAbort.abort();
              checkAbort = null;
            }
            const val = String(input?.value || "").trim();
            const changed = Boolean(val) && normalizeBase(val) !== normalizeBase(activeConflictBase);
            if (!changed) {
              lastCheckedName = "";
              lastCheckedResult = null;
              setFeedback("", false);
              syncConfirmState();
              return;
            }
            const targetName = buildTargetName();
            if (lastCheckedName === targetName && lastCheckedResult?.status === "conflict") {
              showRenameConflict(targetName, lastCheckedResult.conflict);
              return;
            }
            syncConfirmState();
            setFeedback("", false);
            if (typeof api?.uploadCheck === "function") {
              checkTimer = setTimeout(async () => {
                try {
                  setFeedback(`<p class="conflict-feedback-checking">${e(t("uploadConflictChecking"))}</p>`, false);
                  const item = await runAvailabilityCheck(targetName);
                  if (buildTargetName() !== targetName || settled) return;
                  if (item.status === "conflict" && item.conflict) {
                    showRenameConflict(targetName, item.conflict);
                  } else if (item.status === "ok" || item.status === "instant") {
                    setFeedback(`<p class="conflict-feedback-success">${e(t("uploadConflictRenameAvailable"))}</p>`, false);
                    syncConfirmState();
                  } else {
                    setFeedback(`<p class="conflict-feedback-checking">${e(t("uploadConflictCheckUnavailable"))}</p>`, false);
                    syncConfirmState();
                  }
                } catch (err) {
                  if (err?.name === "AbortError") return;
                  if (buildTargetName() === targetName && !settled) {
                    setFeedback(`<p class="conflict-feedback-checking">${e(t("uploadConflictCheckUnavailable"))}</p>`, false);
                    syncConfirmState();
                  }
                }
              }, 220);
            }
          };

          choicesEl?.addEventListener(
            "keydown",
            (event) => {
              if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const opts = getOptions(activeConflict), index = opts.findIndex(o => o.id === (document.activeElement?.dataset.choice || selectedAction));
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? opts.length - 1
                : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + opts.length) % opts.length;
              choose(opts[next].id);
            },
            { signal: controller.signal },
          );
          choicesEl?.addEventListener(
            "click",
            (event) => {
              const btn = event.target.closest("[data-choice]");
              if (!btn) return;
              choose(btn.dataset.choice);
            },
            { signal: controller.signal },
          );
          input?.addEventListener("input", syncRenameInput, { signal: controller.signal });
          input?.addEventListener(
            "keydown",
            (event) => {
              if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault();
                if (!confirmBtn.disabled && confirmBtn.getAttribute("aria-disabled") !== "true") {
                  confirmBtn.click();
                }
              }
            },
            { signal: controller.signal },
          );
          modal.querySelector("form")?.addEventListener(
            "submit",
            (event) => {
              event.preventDefault();
              if (!confirmBtn.disabled && confirmBtn.getAttribute("aria-disabled") !== "true") {
                confirmBtn.click();
              }
            },
            { signal: controller.signal },
          );
          renderChoices();
          if (initialRenameBase && initialRenameBase !== defaultBase) {
            syncRenameInput();
          }

          actions(
            modal,
            {
              "conflict-confirm": async () => {
                if (confirmBtn.getAttribute("aria-disabled") === "true") return;
                if (selectedAction === "rename") {
                  const nextName = buildTargetName();
                  if (!nextName) return;
                  if (typeof api?.uploadCheck === "function" && lastCheckedName !== nextName) {
                    setConfirmEnabled(false);
                    try {
                      setFeedback(`<p class="conflict-feedback-checking">${e(t("uploadConflictChecking"))}</p>`, false);
                      const item = await runAvailabilityCheck(nextName);
                      if (settled) return;
                      if (selectedAction !== "rename" || buildTargetName() !== nextName) {
                        syncConfirmState();
                        return;
                      }
                      if (item.status === "conflict" && item.conflict) {
                        showRenameConflict(nextName, item.conflict);
                        input?.focus();
                        input?.select();
                        return;
                      }
                    } catch (err) {
                      if (err?.name === "AbortError") return;
                    }
                  }
                  if (settled || selectedAction !== "rename" || buildTargetName() !== nextName) return;
                  finish({ action: "rename", filename: nextName, applyToAll: applyAll() });
                  modal.close();
                  return;
                }
                if (selectedAction === "replace") {
                  if (!(activeConflict?.code === "NAME_CONFLICT" && !activeConflict?.locked)) return;
                  finish({
                    action: "replace",
                    filename: activeConflict?.filename || buildTargetName() || localName,
                    target: activeConflict,
                    applyToAll: applyAll(),
                  });
                  modal.close();
                  return;
                }
                finish({ action: selectedAction, target: activeConflict, applyToAll: applyAll() });
                modal.close();
              },
            },
            controller.signal,
          );
          modal.addEventListener(
            "close",
            () => {
              if (checkTimer) clearTimeout(checkTimer);
              if (checkAbort) checkAbort.abort();
              controller.abort();
              finish({ action: "skip", applyToAll: false });
            },
            { once: true },
          );
        },
      },
    ).catch((err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}
