export const copyFormats = ["raw", "webp", "markdown_raw", "markdown_webp"];
export function cardCopy(item, format = "raw", optimizationEnabled = true) {
  const webp =
    optimizationEnabled && item.isProcessableImage && format.includes("webp");
  const url = webp ? item.pubUrl : item.rawUrl;
  return format.startsWith("markdown")
    ? item.isImage
      ? `![](${url})`
      : `[${item.filename.replace(/[\[\]\\]/g, "\\$&")}](${url})`
    : url;
}
