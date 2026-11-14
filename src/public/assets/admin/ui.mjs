import { t, getLocale } from "./locale.mjs";
export const e = (value = "") =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const bytes = (value = 0) => {
  if (!value) return "0 B";
  const i = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** i).toFixed(i > 1 ? 2 : 0)} ${["B", "KB", "MB", "GB", "TB"][i]}`;
};
export const date = (value) =>
  value
    ? new Date(value).toLocaleString(getLocale() === "zh" ? "zh-CN" : "en")
    : "—";
export const compactDate = value => value ? new Intl.DateTimeFormat(getLocale() === 'zh' ? 'zh-CN' : 'en-GB', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)) : '—';
const paths = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
  moon: '<path d="M20.8 13.2A9 9 0 0 1 10.8 3.2 9 9 0 1 0 20.8 13.2Z"/>',
  theme: '<path d="M12 3a9 9 0 1 0 0 18V3Z"/><circle cx="12" cy="12" r="9"/>',
  branch: '<circle cx="6" cy="5" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="19" r="3"/><path d="M6 8v8M18 9a10 10 0 0 1-10 10"/>',
  external: '<path d="M14 3h7v7M21 3 10 14M10 3H3v18h18v-7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  github: '<path d="M9 19c-4 1-4-2-6-2m12 4v-3.4a3 3 0 0 0-.8-2.3c2.7-.3 5.5-1.3 5.5-6a4.7 4.7 0 0 0-1.3-3.3 4.4 4.4 0 0 0-.1-3.3s-1-.3-3.4 1.3a11.5 11.5 0 0 0-6.2 0C6.3 2.4 5.3 2.7 5.3 2.7a4.4 4.4 0 0 0-.1 3.3A4.7 4.7 0 0 0 4 9.3c0 4.7 2.8 5.7 5.5 6a3 3 0 0 0-.8 2.3V21"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="m3 3 18 18M10 5a13 13 0 0 1 12 7 18 18 0 0 1-4 5M6 6a18 18 0 0 0-4 6s3 7 10 7a13 13 0 0 0 5-1M10 10a3 3 0 0 0 4 4"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  sort: '<path d="M4 6h16M4 12h11M4 18h6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/>',
  trash: '<path d="M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  fit: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',

  files:
    '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  share:
    '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  plug: '<path d="M8 2v5m8-5v5M6 7h12v4a6 6 0 0 1-12 0Zm6 10v5"/>',
  status: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  settings:
    '<path d="m9 3-1 3-3 1v4l3 1 1 3h4l1-3 3-1V7l-3-1-1-3Z" transform="translate(1 2)"/><circle cx="12" cy="11" r="3"/>',
  upload:
    '<path d="M12 16V3m-5 5 5-5 5 5M3 16v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
  arrow: '<path d="m10 5-7 7 7 7M3 12h18"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  alert: '<path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  tasks:
    '<rect x="4" y="4" width="16" height="17" rx="2"/><path d="M8 2v4h8V2M8 11h8M8 15h6"/>',
  logout: '<path d="M9 3H4v18h5m6-14 5 5-5 5M8 12h12"/>',
  calendar:
    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  download:
    '<path d="M12 3v13m-5-5 5 5 5-5M3 16v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4"/>',
  hardDrive:
    '<rect x="2" y="13" width="20" height="8" rx="2"/><path d="M5.5 13 7 6a2 2 0 0 1 2-1.5h6A2 2 0 0 1 17 6l1.5 7M6 17h.01M10 17h.01"/>',
};
export const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
export const metaItem = (symbol, text, { cls = "", title = "" } = {}) =>
  `<span class="${cls ? `meta-item ${e(cls)}` : "meta-item"}"${title ? ` title="${e(title)}"` : ""}>${symbol ? icon(symbol) : ""}<span>${e(text)}</span></span>`;
export const button = (label, action, variant = "secondary", symbol = "", attrs = "") => {
  const iconOnly = variant.split(" ").includes("icon-button");
  return `<button type="button" class="${iconOnly ? variant : "button " + variant}" data-action="${e(action)}" ${iconOnly ? `title="${e(t(label))}" aria-label="${e(t(label))}"` : ""} ${attrs}>${symbol ? icon(symbol) : ""}${iconOnly ? "" : e(t(label))}</button>`;
};
export const heading = (title, description, actions = "") =>
  `<header class="page-heading"><h1 tabindex="-1">${e(t(title))}</h1><div class="actions">${actions}</div></header>`;
export const empty = (title, description, action = "", symbol = "files") =>
  `<div class="empty-state"><div class="empty-icon">${icon(symbol)}</div><h2>${e(t(title))}</h2><p>${e(t(description))}</p>${action}</div>`;
export const notice = (text, kind = "info") =>
  `<div class="notice ${kind}" role="${kind === "danger" ? "alert" : "status"}">${e(text)}</div>`;
export const errorView = (error) =>
  empty("failed", "retry", button("retry", "reload")) +
  notice(error.message, "danger");
export const storageWarning = (health) =>
  health?.atomicUploads === true ? "" : notice(t("storageWarning"), "warning");
export const kv = (label, value) =>
  `<div class="property"><dt>${e(t(label))}</dt><dd>${e(value ?? "—")}</dd></div>`;
export function toast(message) {
  const region = document.getElementById("toast");
  region.textContent = message;
  region.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    region.hidden = true;
  }, 4000);
}
export async function copy(value) {
  try {
    await navigator.clipboard.writeText(value);
    toast(t("copiedNew"));
  } catch {
    await dialog(
      t("copyManually"),
      `<textarea readonly aria-label="${e(t("copy"))}">${e(value)}</textarea>`,
      { className: "dialog-compact" },
    );
  }
}
export function downloadJson(value, filename) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Native modal provides inert background, focus containment, Escape, and focus restoration. */
export function dialog(
  title,
  content,
  { submit, cancel, danger = false, className = "", onMount } = {},
) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const el = document.createElement("dialog");
    el.className = className ? `dialog ${className}` : "dialog";
    el.innerHTML = `<form method="dialog"><header><h2 id="dialog-title">${e(title)}</h2><button type="button" data-dialog-cancel class="icon-button" aria-label="${e(t("close"))}">${icon("close")}</button></header><div class="dialog-content">${content}</div><footer><button type="button" data-dialog-cancel class="button secondary">${e(cancel || t(submit ? "cancel" : "close"))}</button>${submit ? `<button value="confirm" class="button ${danger ? "danger" : "primary"}">${e(submit)}</button>` : ""}</footer></form>`;
    el.setAttribute("aria-labelledby", "dialog-title");
    document.body.append(el);
    el.addEventListener("click", (event) => {
      if (event.target === el || event.target.closest("[data-dialog-cancel]"))
        el.close("cancel");
    });
    el.addEventListener(
      "close",
      () => {
        const data = Object.fromEntries(new FormData(el.querySelector("form")));
        const ok = el.returnValue === "confirm";
        el.remove();
        previous?.isConnected && previous.focus();
        resolve(ok ? data : null);
      },
      { once: true },
    );
    onMount?.(el);
    el.querySelector(
      ".dialog-content input:not([readonly]), .dialog-content textarea:not([readonly]), .dialog-content select",
    )?.setAttribute("autofocus", "");
    el.showModal();
  });
}
export async function confirm(title, body, danger = false) {
  return (
    (await dialog(
      title,
      `<div class="confirm-body"><span class="confirm-icon ${danger ? "is-danger" : "is-warn"}">${icon(danger ? "trash" : "alert")}</span><p class="confirm-message">${e(body)}</p></div>`,
      {
        submit: t("confirm"),
        danger,
        className: "dialog-compact",
      },
    )) !== null
  );
}
export function actions(root, handlers, signal) {
  root.addEventListener(
    "click",
    async (event) => {
      const target = event.target.closest("[data-action]");
      if (!target || !root.contains(target) || target.disabled) return;
      const handler = handlers[target.dataset.action];
      if (!handler) return;
      event.preventDefault();
      const hadFocus = document.activeElement === target;
      target.disabled = true;
      try {
        await handler(target, event);
      } catch (error) {
        if (error.name !== "AbortError") toast(error.message);
      } finally {
        if (target.isConnected) {
          target.disabled = target.getAttribute("aria-disabled") === "true";
          if (hadFocus && document.activeElement === document.body)
            target.focus({ preventScroll: true });
        }
      }
    },
    { signal },
  );
}
