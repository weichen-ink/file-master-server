import { e, icon } from "../ui.mjs";
import { t } from "../locale.mjs";

/** Shared thumbnail for the library, upload results, and other file collections. */
export const fileThumbnail = (item) =>
  item.isImage && (item.thumbnailUrl || item.rawPreviewPath)
    ? `<img src="${e(item.thumbnailUrl || item.rawPreviewPath)}" alt="" loading="lazy"><span class="thumbnail-fallback" hidden>${icon("image")}</span>`
    : `<span class="file-type-icon">${icon(item.isImage ? "image" : "file")}<span>${e(item.ext?.replace(".", "").toUpperCase() || "")}</span></span>`;

export function thumbnailFallback(event) {
  const image = event.target;
  const fallback = image?.nextElementSibling;
  if (image?.tagName !== "IMG" || !fallback?.classList.contains("thumbnail-fallback")) return;
  image.hidden = true;
  fallback.hidden = false;
}

/** A single column model with compact, content-first rows on narrow containers. */
export function collection(columns, rows, { className = "", empty = "" } = {}) {
  if (!rows.length) return empty;
  const columnClass = column => `column-${column.key} ${column.className || ''}`;
  return `<div class="collection-shell"><table class="collection ${e(className)}"><thead><tr class="collection-head">${columns.map(column => `<th scope="col" class="${e(columnClass(column))}">${column.headerHtml ?? e(t(column.label))}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr class="collection-row ${e(row._rowClass || '')}">${columns.map((column) => `<td class="collection-cell ${e(columnClass(column))}" data-label="${column.label ? e(t(column.label)) : ''}">${row[column.key] ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
export function fileIdentity(item, { href = "", meta = "", thumbnail = "", previewId = "", summary = "" } = {}) {
  const content = `<span class="row-thumbnail">${thumbnail || icon(item.isImage ? 'image' : 'file')}</span><span class="identity-text"><strong title="${e(item.filename)}">${e(item.filename)}</strong>${meta ? `<small>${e(meta)}</small>` : ''}${summary ? `<span class="collection-summary">${summary}</span>` : ''}</span>`;
  if (previewId) return `<button type="button" class="file-row-link file-preview-link" data-action="preview-trash" data-id="${e(previewId)}">${content}</button>`;
  return href ? `<a class="file-row-link" href="${e(href)}">${content}</a>` : `<div class="file-row-link">${content}</div>`;
}
