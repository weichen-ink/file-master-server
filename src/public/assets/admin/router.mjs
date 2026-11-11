const aliases = {
  "image-host": "/files",
  "future-files": "/shares",
  media: "/media",
  integration: "/integration",
  status: "/status",
  settings: "/settings/general",
  security: "/settings/security",
  maintenance: "/settings/updates",
  platform: "/settings/general",
};
export function parseRoute(hash = "") {
  let value = hash.replace(/^#/, "");
  value = aliases[value] || value || "/files";
  const [path, search = ""] = value.split("?");
  const parts = path.split("/").filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(search));
  try {
    if (parts[0] === "files" && parts.length === 4)
      return {
        page: "detail",
        key: parts.slice(1).map(decodeURIComponent).join("/"),
        query,
      };
    if (parts[0] === "media")
      return {
        page: "settings",
        section: "media",
        query,
      };
    if (parts[0] === "integration") return { page: "settings", section: "integration", query };
    if (parts[0] === "settings")
      return {
        page: "settings",
        section: [
          "site",
          "media",
          "backup",
          "updates",
          "advanced",
          "integration",
        ].includes(parts[1])
          ? parts[1]
          : "site",
        query,
      };
    if (
      ["files", "shares", "trash", "integration", "status"].includes(
        parts[0],
      ) &&
      parts.length === 1
    )
      return { page: parts[0], query };
  } catch {
    /* Invalid encoded file identifiers fall back to the library. */
  }
  return { page: "files", query: {} };
}
export const assetKey = (item) => `${item.year}/${item.month}/${item.filename}`;
export function detailHref(item, query = {}) {
  const path =
    "#/files/" +
    [item.year, item.month, item.filename].map(encodeURIComponent).join("/");
  const search = new URLSearchParams(
    Object.entries(query).filter(([, value]) => value !== "" && value != null),
  );
  return path + (search.size ? "?" + search : "");
}
// A detail backlink can only target our own library route.
export function libraryBacklink(value) {
  return typeof value === "string" &&
    /^#\/files(?:\?|$)/.test(value) &&
    parseRoute(value).page === "files"
    ? value
    : null;
}
export function filesHref(query = {}) {
  const search = new URLSearchParams(
    Object.entries(query).filter(([, value]) => value !== "" && value != null),
  );
  return "#/files" + (search.size ? "?" + search : "");
}
export function navigate(href, replace = false) {
  if (replace) {
    history.replaceState(null, "", href);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else if (location.hash !== href) location.hash = href;
}
