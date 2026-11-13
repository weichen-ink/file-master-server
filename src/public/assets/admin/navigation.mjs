import { e, icon } from "./ui.mjs";
import { t } from "./locale.mjs";
export const groups = [
  {
    key: "assets",
    label: "assetManagement",
    icon: "files",
    children: [
      ["library", "#/files"],
      ["shares", "#/shares"],
      ["trash", "#/trash"],
    ],
  },
  {
    key: "config",
    label: "serviceConfig",
    icon: "settings",
    children: [
      ["site", "#/settings/site"],
      ["media", "#/settings/media"],
      ["navIntegration", "#/settings/integration"],
    ],
  },
  {
    key: "ops",
    label: "systemOps",
    icon: "activity",
    children: [
      ["status", "#/status"],
      ["backup", "#/settings/backup"],
      ["updates", "#/settings/updates"],
      ["advanced", "#/settings/advanced"],
    ],
  },
];
export function routeHref(route) {
  if (route.page === "settings") return "#/settings/" + route.section;
  if (route.page === "media")
    return "#/settings/media";
  if (route.page === "integration")
    return "#/settings/integration";
  return "#/" + (route.page === "detail" ? "files" : route.page);
}
export function navigationHtml(route) {
  const active = routeHref(route);
  return groups.map(group => `<section class="nav-group" aria-label="${e(t(group.label))}"><h2 class="nav-group-heading">${icon(group.icon)}<span>${e(t(group.label))}</span></h2><div>${group.children.map(([label, href]) => `<a class="nav-link" href="${href}" ${href === active ? 'aria-current="page"' : ""}>${e(t(label))}</a>`).join("")}</div></section>`).join("");
}
