import { getTheme, setTheme } from "./theme.mjs";
import { createClient } from "./api/client.mjs";
import { createApi } from "./api/index.mjs";
import { createSettingsStore } from "./state/settings.mjs";
import { createTasks } from "./state/tasks.mjs";
import { mountFiles, mountDetail } from "./features/files.mjs";
import { mountSettings } from "./features/settings.mjs";
import {
  mountTrash,
  mountShares,
  mountStatus,
  mountBackup,
  mountUpdates,
} from "./features/operations.mjs";
import { navigationHtml } from "./navigation.mjs";
import { openUpload, openIntegrity } from "./features/activity.mjs";
import { sectionValues, schemas } from "./features/settings-schema.mjs";
import { parseRoute, navigate } from "./router.mjs";
import { t, setLocale, getLocale } from "./locale.mjs";
import { e, icon, button, dialog, notice, actions, errorView } from "./ui.mjs";

export async function start() {
  const shell = document.getElementById("shell"),
    login = document.getElementById("login"),
    root = document.getElementById("page");
  let pageController,
    configPromise,
    filesPromise,
    generation = 0,
    fileRevision = 0;
  const ctx = {
    config: null,
    rawYaml: "",
    configRevision: "",
    rawStale: false,
    status: {},
    drafts: createSettingsStore(),
    files: { loaded: false, items: [], stats: {} },
    route: null,
    authenticated: false,
  };
  const expired = (message = t("sessionExpired")) => {
    if (!ctx.authenticated) return;
    ctx.authenticated = false;
    generation++;
    pageController?.abort();
    ctx.drafts.clear();
    ctx.config = null;
    ctx.rawYaml = "";
    ctx.rawStale = false;
    configPromise = null;
    filesPromise = null;
    ctx.files = { loaded: false, items: [], stats: {} };
    document.querySelectorAll("dialog").forEach((el) => el.close("cancel"));
    root.replaceChildren();
    ctx.tasks.clear();
    shell.hidden = true;
    showLogin(message);
  };
  Object.defineProperty(ctx, "sessionVersion", { get: () => generation });
  ctx.api = createApi(createClient(undefined, expired));
  ctx.refreshStatus = async () => {
    const data = await ctx.api.status();
    if (data.endpoints) delete data.endpoints.apiToken;
    ctx.status = data;
    document.title = (data.siteName || "File Master") + " · File Master";
    document.getElementById("mobile-heading").textContent =
      data.siteName || "File Master";
    document
      .querySelectorAll("[data-site-name]")
      .forEach((el) => (el.textContent = data.siteName || "File Master"));
    return data;
  };
  ctx.loadConfig = async () => {
    if (ctx.config) return ctx.config;
    if (!configPromise) {
      const session = generation;
      const pending = ctx.api
        .config()
        .then((data) => {
          if (session !== generation)
            throw new DOMException("Session ended", "AbortError");
          ctx.config = data.config;
          ctx.rawYaml = data.rawYaml;
          ctx.configRevision = data.revision;
          return data.config;
        })
        .finally(() => {
          if (configPromise === pending) configPromise = null;
        });
      configPromise = pending;
    }
    return configPromise;
  };
  ctx.acceptConfig = (data, savedSection, session = generation) => {
    if (!ctx.authenticated || session !== generation)
      throw new DOMException("Session ended", "AbortError");
    if (ctx.drafts.dirty("advanced") && savedSection !== "advanced")
      ctx.rawStale = true;
    ctx.config = data.config;
    ctx.rawYaml = data.rawYaml;
    ctx.configRevision = data.revision;
    for (const section of Object.keys(schemas))
      if (section !== savedSection)
        ctx.drafts.merge(section, sectionValues(section, data.config));
    if (savedSection !== "advanced")
      ctx.drafts.merge("advanced", { raw: data.rawYaml, revision: data.revision });
  };
  ctx.invalidateFiles = () => {
    fileRevision++;
    filesPromise = null;
    ctx.files.loaded = false;
  };
  ctx.loadFiles = async (force = false) => {
    if (force) ctx.invalidateFiles();
    if (ctx.files.loaded) return;
    if (!filesPromise) {
      const session = generation,
        revision = fileRevision;
      const pending = ctx.api
        .files()
        .then((data) => {
          if (session !== generation) return;
          if (revision !== fileRevision) return ctx.loadFiles();
          Object.assign(ctx.files, {
            loaded: true,
            items: data.images || [],
            stats: data.stats || {},
            optimizationEnabled: data.optimizationEnabled !== false,
          });
          document
            .querySelectorAll("[data-file-count]")
            .forEach((el) => (el.textContent = ctx.files.items.length));
        })
        .finally(() => {
          if (filesPromise === pending) filesPromise = null;
        });
      filesPromise = pending;
    }
    return filesPromise;
  };
  ctx.tasks = createTasks(ctx.api, async () => {
    if (!ctx.authenticated) return;
    await ctx.loadFiles(true);
    if (["files", "detail"].includes(ctx.route?.page)) ctx.render();
  });
  ctx.mountBackup = (target, signal) => mountBackup(ctx, target, signal);
  ctx.mountUpdates = (target, signal) => mountUpdates(ctx, target, signal);
  ctx.chooseUpload = () => openUpload(ctx);
  ctx.checkIntegrity = () => openIntegrity(ctx);
  ctx.render = async () => {
    if (!ctx.authenticated) return;
    pageController?.abort();
    pageController = new AbortController();
    const signal = pageController.signal;
    const route = (ctx.route = parseRoute(location.hash));
    document.documentElement.lang = getLocale() === "zh" ? "zh-CN" : "en";
    const nav = document.getElementById("main-navigation");
    nav.innerHTML = navigationHtml(route);
    root.setAttribute("aria-busy", "true");
    root.innerHTML = `<div class="loading-state" role="status"><span class="spinner"></span>${e(t("loading"))}</div>`;
    try {
      const mounts = {
        files: mountFiles,
        detail: mountDetail,
        settings: (ctx, root, route, signal) => mountSettings(ctx, root, route, signal),
        media: mountSettings,
        shares: mountShares,
        trash: mountTrash,
        status: mountStatus,
      };
      await mounts[route.page](ctx, root, route, signal);
    } catch (error) {
      if (!signal.aborted && ctx.authenticated) {
        root.innerHTML = errorView(error);
        actions(root, { reload: () => ctx.render() }, signal);
      }
    } finally {
      if (!signal.aborted) {
        root.removeAttribute("aria-busy");
        if (ctx.focusRoute) {
          (root.querySelector("h1") || root).setAttribute("tabindex", "-1");
          (root.querySelector("h1") || root).focus({ preventScroll: true });
          ctx.focusRoute = false;
        }
      }
    }
  };
  const themeHtml = () => {
    const dark=document.documentElement.dataset.theme === 'dark';
    const label=t(dark?'switchToLight':'switchToDark');
    return `<button type="button" class="icon-button" data-action="toggle-theme" data-theme-toggle title="${e(label)}" aria-label="${e(label)}">${icon(dark?'moon':'sun')}</button>`;
  };
  const syncThemeControls = () => {
    const dark=document.documentElement.dataset.theme === 'dark';
    const label=t(dark?'switchToLight':'switchToDark');
    document.querySelectorAll('[data-theme-toggle]').forEach(el=>{
      el.title=label;el.setAttribute('aria-label',label);el.innerHTML=icon(dark?'moon':'sun');
    });
    document.querySelectorAll('[data-theme-select]').forEach(el=>el.value=getTheme());
  };
  document.addEventListener('change',event=>{
    if(!event.target.matches('[data-theme-select]'))return;
    setTheme(event.target.value);
    syncThemeControls();
  });
  new MutationObserver(syncThemeControls).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  const utilityHtml = () => `<div class="sidebar-tools">${themeHtml()}${button(getLocale() === "zh" ? "English" : "简体中文", "language", "icon-button", "globe")}<a class="icon-button" href="https://github.com/weichen-ink/file-master-server" target="_blank" rel="noopener noreferrer" title="GitHub" aria-label="GitHub">${icon('github')}</a>${button("navLogout", "logout", "icon-button", "logout")}</div>`;
  const renderShell = () => {
    document.documentElement.lang = getLocale() === "zh" ? "zh-CN" : "en";
    document.getElementById("sidebar-content").innerHTML =
      `<a class="brand" href="#/files"><span class="brand-mark">${icon("bolt")}</span><strong data-site-name>${e(ctx.status.siteName || "File Master")}</strong></a><nav id="main-navigation" aria-label="${e(t("openMenu"))}">${navigationHtml(ctx.route || parseRoute(location.hash))}</nav><div class="sidebar-bottom">${utilityHtml()}</div>`;
    document.getElementById("mobile-heading").textContent =
      ctx.status.siteName || "File Master";
    document
      .getElementById("mobile-menu")
      .setAttribute("aria-label", t("openMenu"));
    document.getElementById("skip-link").textContent = t("skipContent");
  };
  function showLogin(message = "") {
    shell.hidden = true;
    login.hidden = false;
    login.innerHTML = `<div class="login-intro"><a class="brand" href="/"><span class="brand-mark">${icon("bolt")}</span><strong data-site-name>${e(ctx.status.siteName || "File Master")}</strong></a><p class="eyebrow">YOUR PERSONAL FILE WORKSPACE</p><h1>${e(t("welcome"))}</h1><p>${e(t("signInDesc"))}</p></div><section class="login-panel"><div class="login-locale">${button(getLocale() === "zh" ? "English" : "简体中文", "language", "quiet")}</div><h2>${e(t("signInTitle"))}</h2><p class="muted">${e(t("loginSub"))}</p><form id="login-form"><div class="field"><label for="login-username">${e(t("loginUsername"))}</label><input id="login-username" name="username" autocomplete="username" required></div><div class="field"><label for="login-password">${e(t("loginPassword"))}</label><input id="login-password" name="password" type="password" autocomplete="current-password" required></div><label class="inline-check"><input type="checkbox" name="rememberMe" checked>${e(t("loginRemember"))}</label><div id="login-error" role="alert">${message ? notice(message, "danger") : ""}</div><button class="button primary full-width" type="submit">${e(t("loginSubmit"))}</button></form></section>`;
    login
      .querySelector("#login-form")
      .addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget,
          submit = form.querySelector('[type="submit"]');
        submit.disabled = true;
        try {
          const values = Object.fromEntries(new FormData(form));
          await ctx.api.login({
            ...values,
            rememberMe: values.rememberMe === "on",
          });
          await enter();
        } catch (error) {
          form.querySelector("#login-error").innerHTML = notice(
            error.message,
            "danger",
          );
        } finally {
          submit.disabled = false;
        }
      });
  }
  async function enter() {
    const status = await ctx.refreshStatus();
    if (status.needsSetup) {
      location.assign("/setup");
      return;
    }
    if (!status.authenticated) {
      showLogin();
      return;
    }
    ctx.authenticated = true;
    login.hidden = true;
    shell.hidden = false;
    renderShell();
    if (!location.hash) history.replaceState(null, "", "#/files");
    await ctx.render();
    ctx.tasks.resume();
  }
  const confirmLogout = async () =>
    Boolean(
      await dialog(t("unsaved"), `<p>${e(t("draftKept"))}</p>`, {
        submit: t("navLogout"),
      }),
    );
  actions(
    document.body,
    {
      "toggle-theme": () => {
        setTheme(document.documentElement.dataset.theme === 'dark'?'light':'dark');
        syncThemeControls();
      },
      language: () => {
        setLocale(getLocale() === "zh" ? "en" : "zh");
        if (ctx.authenticated) {
          renderShell();
          ctx.render();
        } else showLogin();
      },
      logout: async () => {
        if (ctx.drafts.anyDirty() && !(await confirmLogout())) return;
        await ctx.api.logout();
        expired("");
      },
      "mobile-menu": () =>
        dialog(
          t("workspace"),
          `<nav class="mobile-nav">${navigationHtml(ctx.route)}</nav><div class="sidebar-bottom">${utilityHtml()}</div>`,
          {
            onMount: (el) =>
              el.addEventListener("click", (event) => {
                if (event.target.closest("a,[data-action]")) el.close();
              }),
          },
        ),
    },
    new AbortController().signal,
  );
  ctx.drafts.subscribe(() => {
    const target = document.getElementById("dirty-indicator");
    const names = ctx.drafts.dirtyNames();
    target.hidden = !names.length;
    target.innerHTML = `<button class="button secondary" aria-describedby="dirty-sections">${icon("settings")}${e(t("unsavedCount", { count: names.length }))}</button><div id="dirty-sections" class="dirty-sections"><strong>${e(t("unsaved"))}</strong>${names.map((name) => `<a href="#/settings/${["compression", "watermark"].includes(name) ? "media" : name}">${e(t(name))}</a>`).join("")}</div>`;
  });
  document.getElementById("skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    (ctx.authenticated ? root : login.querySelector("input"))?.focus();
  });
  // A file dropped outside the explicitly opened upload dialog must never upload or navigate.
  for (const type of ["dragover", "drop"])
    window.addEventListener(type, (event) => {
      if (Array.from(event.dataTransfer?.types || []).includes("Files"))
        event.preventDefault();
    });
  window.addEventListener("beforeunload", (event) => {
    if (ctx.drafts.anyDirty() || ctx.tasks.jobs.upload?.state === "running") {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  window.addEventListener("hashchange", () => {
    const next = parseRoute(location.hash);
    if (ctx.route?.page === "detail" && next.page === "files")
      ctx.restoreFileScroll = true;
    ctx.focusRoute = true;
    window.scrollTo(0, 0);
    ctx.render();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
      if (ctx.route?.page === "detail") {
        ctx.restoreFileScroll = true;
        navigate(ctx.lastFilesHref || "#/files");
      }
    }
  });
  try {
    await enter();
  } catch (error) {
    showLogin(error.message);
  }
}
