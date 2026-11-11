import { e, icon } from "../ui.mjs";
import { t } from "../locale.mjs";

/** A single column model with compact, content-first rows on narrow containers. */
export function collection(columns, rows, { className = "", empty = "" } = {}) {
  if (!rows.length) return empty;
  const widths = {size:'104px',date:'168px',deleted:'168px',protection:'100px',actions:'148px'};
  const columnClass = column => `column-${column.key} ${column.className || ''}`;
  return `<div class="collection-shell"><table class="collection ${e(className)}"><colgroup>${columns.map(column => `<col${column.width || widths[column.key] ? ` style="width:${e(column.width || widths[column.key])}"` : ''}>`).join('')}</colgroup><thead><tr class="collection-head">${columns.map(column => `<th scope="col" class="${e(columnClass(column))}">${e(t(column.label))}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr class="collection-row">${columns.map((column) => `<td class="collection-cell ${e(columnClass(column))}" data-label="${e(t(column.label))}">${row[column.key] ?? '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
export function fileIdentity(item, { href = "", meta = "", thumbnail = "", previewId = "", summary = "" } = {}) {
  const content = `<span class="row-thumbnail">${thumbnail || icon(item.isImage ? 'image' : 'file')}</span><span class="identity-text"><strong title="${e(item.filename)}">${e(item.filename)}</strong>${meta ? `<small>${e(meta)}</small>` : ''}${summary ? `<span class="collection-summary">${summary}</span>` : ''}</span>`;
  if (previewId) return `<button type="button" class="file-row-link file-preview-link" data-action="preview-trash" data-id="${e(previewId)}">${content}</button>`;
  return href ? `<a class="file-row-link" href="${e(href)}">${content}</a>` : `<div class="file-row-link">${content}</div>`;
}
