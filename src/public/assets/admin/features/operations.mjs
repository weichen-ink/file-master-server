import { t, getLocale } from "../locale.mjs";
import {
  e,
  icon,
  button,
  heading,
  notice,
  empty,
  bytes,
  date,
  compactDate,
  kv,
  actions,
  confirm,
  toast,
  copy,
  dialog,
} from "../ui.mjs";
import { openImagePreview } from "./viewer.mjs";
import { collection, fileIdentity } from "./collection.mjs";
import { restartAndReconnect } from "./service-control.mjs";
import { sectionValues, sectionPatch } from "./settings-schema.mjs";
import { detailHref } from "../router.mjs";

export async function mountShares(ctx, root, route, signal) {
  const [{ shares }] = await Promise.all([ctx.api.shares(), ctx.loadFiles()]);
  if (signal.aborted) return;
  root.innerHTML =
    heading("shares", "", button("refresh", "refresh")) +
    `<div class="share-filters"><label for="share-state">${e(t("shareColStatus"))}</label><select id="share-state"><option value="all">${e(t("allStates"))}</option>${["active", "expired", "quotaUsed", "fileMissing"].map((key) => `<option value="${key}">${e(t(key))}</option>`).join("")}</select></div><div id="shares-results"></div>`;
  const fileFor = item => ctx.files.items.find(file => file.year === item.year && file.month === item.month && file.filename === item.filename);
  const state = item => item.state || shareState(item);
  const render = () => {
    const filter = root.querySelector("#share-state").value,
      items = shares.filter((i) => filter === "all" || state(i) === filter);
    root.querySelector("#shares-results").innerHTML = collection(
      [
        { key: "file", label: "file" },
        { key: "expires", label: "shareColExpires", width: "156px" },
        { key: "downloads", label: "shareColDownloads", width: "136px" },
        { key: "state", label: "shareColStatus", width: "132px" },
        { key: "actions", label: "shareColActions", className: "share-actions", width: "156px" },
      ],
      items.map((i) => ({
        file: fileIdentity(fileFor(i) || i, {
          href: i.fileExists === false ? '' : detailHref(i),
          summary: `<span>${e(t('shareColExpires'))} ${e(i.expiresAt ? compactDate(i.expiresAt) : t('shareNeverExpire'))}</span><span>${e(t('downloadCount',{count:i.downloads}))}${i.maxDownloads ? ' / '+e(i.maxDownloads) : ''}</span><span class="collection-status ${state(i) === 'active' ? 'success' : ''}">${e(t(state(i)))}</span>`,
          thumbnail: fileFor(i)?.isImage ? `<img src="${e(fileFor(i).thumbnailUrl || fileFor(i).rawPreviewPath)}" alt="" loading="lazy">` : '',
        }),
        expires: i.expiresAt ? `<time class="share-expiry" datetime="${e(new Date(i.expiresAt).toISOString())}">${e(compactDate(i.expiresAt))}</time>` : e(t('shareNeverExpire')),
        downloads: `<span class="share-downloads">${e(t('downloadCount',{count:i.downloads}))}<small>${e(i.maxDownloads ? t('downloadLimit',{count:i.maxDownloads}) : t('unlimitedDownloads'))}</small></span>`,
        state: `<span class="collection-status ${state(i) === 'active' ? 'success' : ''}">${e(t(state(i)))}</span>`,
        actions: `<div class="actions">${state(i) === 'active' ? button('copy', 'copy', 'quiet', '', `data-id="${e(i.id)}"`) : ''}${button('shareBtnRevoke', 'revoke', 'quiet share-revoke', '', `data-id="${e(i.id)}"`)}</div>`,
      })),
      { className: "share-collection", empty: empty("shares", "noShareLinks") },
    );
  };
  root
    .querySelector("#share-state")
    .addEventListener("change", render, { signal });
  actions(
    root,
    {
      refresh: () => ctx.render(),
      copy: (target) =>
        copy(shares.find((i) => i.id === target.dataset.id).shareUrl),
      revoke: async (target) => {
        if (!(await confirm(t("shareBtnRevoke"), t("revokedHelp"), true)))
          return;
        await ctx.api.revoke(target.dataset.id);
        toast(t("shareRevoked"));
        ctx.render();
      },
    },
    signal,
  );
  render();
}

export async function mountTrash(ctx, root, route, signal) {
  const { items } = await ctx.api.trash();
  if (signal.aborted) return;
  root.innerHTML =
    heading("trash", "", button("refresh", "refresh")) +
    collection(
      [
        { key: "file", label: "file" },
        { key: "size", label: "sizeColumn" },
        { key: "deleted", label: "deletedAt" },
        { key: "actions", label: "shareColActions", width: "220px" },
      ],
      items.map((i) => ({
        file: fileIdentity(i, {previewId: i.isImage ? i.id : "", thumbnail: i.isImage ? `<img src="/api/modules/image-host/trash/${e(i.id)}/preview?thumbnail=1" alt="" loading="lazy">` : "", summary: `<span>${e(bytes(i.size))}</span><span>${e(t("deletedAt"))} ${e(compactDate(i.deletedAt))}</span>`}),
        size: e(bytes(i.size)),
        deleted: e(compactDate(i.deletedAt)),
        actions: `<div class="actions">${button("restore", "restore", "quiet", "", `data-id="${e(i.id)}"`)}${button("deleteForever", "delete-forever", "quiet destructive", "", `data-id="${e(i.id)}"`)}</div>`,
      })),
      {
        className: "trash-collection",
        empty: empty("trashEmpty", "trashEmptyHelp", "", "trash"),
      },
    );
  actions(
    root,
    {
      refresh: () => ctx.render(),
      "preview-trash": target => {
        const item = items.find(item => item.id === target.dataset.id);
        if (item?.isImage) openImagePreview({src:`/api/modules/image-host/trash/${item.id}/preview`,filename:item.filename,signal});
      },
      restore: async (target) => {
        await ctx.api.restoreTrash(target.dataset.id);
        ctx.invalidateFiles();
        toast(t("restored"));
        ctx.render();
      },
      "delete-forever": async (target) => {
        const item = items.find((i) => i.id === target.dataset.id);
        if (
          !(await confirm(
            t("deleteForever"),
            t("deleteForeverConfirm", { filename: item.filename }),
            true,
          ))
        )
          return;
        await ctx.api.deleteTrash(item.id);
        toast(t("deletedForever"));
        ctx.render();
      },
    },
    signal,
  );
}

export function mountClientIntegration(ctx, root, signal) {
  const fields = [['piclistUploadUrl',ctx.config.base_url + '/api/image/upload'],['piclistField','file'],['piclistResponse','url']];
  const renderField = ([label,value],index) => `<div class="field"><label for="client-value-${index}">${e(t(label))}</label><div class="input-row"><input id="client-value-${index}" readonly value="${e(value)}"><button type="button" class="icon-button" data-action="copy-field" data-value="${e(value)}" aria-label="${e(t('copy'))} ${e(t(label))}">${icon('copy')}</button></div></div>`;
  root.innerHTML = heading('navIntegration') + `<div class="settings-layout"><div class="settings-content"><section id="client-piclist" class="panel client-guide"><h2>PicList</h2><div class="fields">${fields.map(renderField).join('')}</div><p class="client-token-note">${e(t('piclistTokenSame'))} <a href="#/settings/site">${e(t('site'))}</a></p></section></div></div>`;
  actions(root, {'copy-field': target => copy(target.dataset.value)}, signal);
}

export function shareState(item, now = Date.now()) {
  if (item.fileExists === false) return 'fileMissing';
  if (item.expiresAt > 0 && now >= item.expiresAt) return 'expired';
  if (item.maxDownloads > 0 && item.downloads >= item.maxDownloads) return 'quotaUsed';
  return 'active';
}

export function resourceMeter(label, value, detail, extra = "") {
  const available = Number.isFinite(value);
  const percent = available ? Math.max(0, Math.min(100, value)) : 0;
  return `<section class="panel resource-card"><h2>${e(t(label))}</h2><div class="resource-value">${available ? e(value.toFixed(1)) + '<span>%</span>' : '—'}</div><div class="resource-track ${percent >= 85 ? "resource-high" : ""}" role="meter" aria-label="${e(t(label))}" aria-valuemin="0" aria-valuemax="100" ${available ? `aria-valuenow="${percent}"` : 'aria-valuetext="' + e(t("metricUnavailable")) + '"'}><span style="width:${percent}%"></span></div><p>${e(detail)}</p>${extra ? `<small>${e(extra)}</small>` : ""}</section>`;
}

export async function mountStatus(ctx, root, route, signal) {
  const fact = (label,key) => `<div><dt>${e(t(label))}</dt><dd id="${key}">—</dd></div>`;
  root.innerHTML = heading('status') + `<section class="resources-section"><div class="resource-grid">${['diskUsage','cpuUsage','memoryUsage'].map(key => `<div data-resource="${key}">${resourceMeter(key,null,'')}</div>`).join('')}</div><footer class="resources-footer"><span id="metrics-updated"></span><span id="metrics-error" role="status"></span></footer></section><section class="panel service-panel"><div class="section-heading"><h2>${e(t('serviceInformation'))}</h2><span class="muted service-version">v${e(ctx.status.version)}</span></div><dl class="service-facts">${fact('serviceUptime','service-uptime')}${fact('serviceMemory','service-memory')}${fact('nodeVersion','service-node')}${fact('mKeyOs','service-os')}</dl><div class="storage-summary"><span>${e(t('library'))}<strong id="service-files">—</strong></span><span>${e(t('cacheStorage'))}<strong id="service-cache">—</strong></span></div><div id="storage-warning"></div><div class="service-restart"><div><h3>${e(t('restart'))}</h3><p>${e(t('restartHelp'))}</p></div>${button('restart','restart')}</div><p id="service-progress" role="status"></p></section>`;
  let timer, refreshing = false, restarting = false;
  const text = (id,value) => {root.querySelector('#'+id).textContent = value;};
  const schedule = () => { clearTimeout(timer); if (!signal.aborted && !document.hidden && !restarting) timer = setTimeout(refresh,5000); };
  const progress = value => {if (!signal.aborted) text('service-progress',value);};
  const updateMeter = (key,value,detail,extra='') => {
    const card = root.querySelector(`[data-resource="${key}"]`), valid=Number.isFinite(value), percent=valid?Math.min(100,Math.max(0,value)):0;
    card.querySelector('.resource-value').innerHTML = valid?e(percent.toFixed(1))+'<span>%</span>':'—';
    const track=card.querySelector('.resource-track');
    track.classList.toggle('resource-high',percent>=85);
    if(valid){track.setAttribute('aria-valuenow',percent);track.removeAttribute('aria-valuetext');}
    else{track.removeAttribute('aria-valuenow');track.setAttribute('aria-valuetext',t('metricUnavailable'));}
    track.firstElementChild.style.width=percent+'%';
    card.querySelector('p').textContent=detail;
    let small=card.querySelector('small');if(!small){small=document.createElement('small');card.querySelector('.resource-card').append(small);}
    small.textContent=extra;
  };
  const refresh = async () => {
    if(refreshing || restarting || signal.aborted || document.hidden) return;
    refreshing=true;
    try{
      const {host,site,timestamp}=await ctx.api.metrics({signal});if(signal.aborted)return;
      text('metrics-error','');
      updateMeter('diskUsage',host.disk.total?host.disk.usagePercent:null,host.disk.total?t('usedOfTotal',{used:bytes(host.disk.used),total:bytes(host.disk.total)}):t('metricUnavailable'),host.disk.total?t('availableSpace',{size:bytes(host.disk.free)}):'');
      updateMeter('cpuUsage',host.cpu.usagePercent,t('cpuCores',{count:host.cpu.cores}),host.cpu.model);
      updateMeter('memoryUsage',host.memory.total?host.memory.usagePercent:null,t('usedOfTotal',{used:bytes(host.memory.used),total:bytes(host.memory.total)}));
      text('service-uptime',duration(site.uptimeSec));text('service-memory',bytes(site.processMemory.rss));text('service-node',site.nodeVersion);text('service-os',host.platform);
      text('service-files',t('storageFileCount',{count:site.storage.imageCount,size:bytes(site.storage.rawBytes)}));text('service-cache',bytes(site.storage.cacheBytes));
      text('metrics-updated',t('updatedAt',{time:new Date(timestamp).toLocaleTimeString(getLocale()==='zh'?'zh-CN':'en-GB',{hour12:false})}));
      root.querySelector('#storage-warning').innerHTML=host.disk.total && host.disk.usagePercent>=85?notice(t('diskLow'),'warning'):'';
    }catch(error){if(!signal.aborted)text('metrics-error',t('metricsUpdateFailed'));}
    finally{refreshing=false;schedule();}
  };
  document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden)refresh();},{signal});
  signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});
  actions(root,{restart:async()=>{
    if(ctx.drafts.anyDirty())throw new Error(t('saveBeforeRestart'));
    if(!(await confirm(t('restart'),t('restartConfirm'))) || signal.aborted)return;
    restarting=true;clearTimeout(timer);root.querySelector('[data-action="restart"]').disabled=true;
    try{await restartAndReconnect(ctx,signal,{onProgress:progress});}
    catch(error){progress(error.message);throw error;}
    finally{restarting=false;if(!signal.aborted){root.querySelector('[data-action="restart"]').disabled=false;schedule();}}
  }},signal);
  await refresh();
}
function duration(seconds) {
  const minutes = Math.floor(seconds / 60);
  return t("uptimeValue", {days:Math.floor(minutes / 1440), hours:Math.floor(minutes / 60) % 24, minutes:minutes % 60});
}

export function mountBackup(ctx, root, signal) {
  root.innerHTML = `<div class="section-heading"><h2>${e(t("backupActivity"))}</h2>${button("backupRun", "run-backup", "primary")}</div><div id="backup-details"></div><div class="actions">${button("viewBackups", "view-backups")}${button("viewConfigExports", "config-exports")}</div>`;
  const unsubscribe = ctx.tasks.subscribe(({ backup: data }) => {
    if (!data) return;
    const last = data.lastBackup;
    root.querySelector("#backup-details").innerHTML =
      `${data.pollError ? notice(data.pollError, "warning") : ""}<div class="backup-facts"><div><span>${e(t("nextBackup"))}</span><strong>${e(data.config.enabled === false ? t("scheduleOff") : data.nextRunAt ? date(data.nextRunAt) : t("scheduleNeedsReview"))}</strong><small>${e(t("timezoneLabel"))} ${e(data.timezone || "UTC")}</small></div><div><span>${e(t("lastBackup"))}</span><strong>${e(data.isBackingUp ? t("running") : !last ? t("neverBackedUp") : t(last.success ? "completed" : "error"))}</strong><small>${e(data.isBackingUp ? data.currentStep || "" : last ? date(last.completedAt) : t("startFirstBackup"))}</small></div></div>${data.isBackingUp ? "<progress></progress>" : ""}${last?.error ? notice(last.error, "danger") : ""}${last?.rcloneError ? notice(last.rcloneError, "warning") : ""}${data.liveLogs?.length ? `<details><summary>${e(t("executionLog"))}</summary><pre class="code-panel">${e(data.liveLogs.join("\n"))}</pre></details>` : ""}`;
    const run = root.querySelector('[data-action="run-backup"]');
    run.disabled = Boolean(data.isBackingUp);
    run.setAttribute("aria-disabled", String(Boolean(data.isBackingUp)));
  });
  signal.addEventListener("abort", unsubscribe, { once: true });
  actions(
    root,
    {
      "run-backup": () => ctx.tasks.runBackup(),
      "view-backups": async () => {
        const { files } = await ctx.api.backupFiles();
        if (signal.aborted) return;
        await dialog(
          t("viewBackups"),
          collection(
            [
              { key: "file", label: "file" },
              { key: "date", label: "backupCreated" },
              { key: "size", label: "archiveSize" },
              { key: "actions", label: "shareColActions", width: "220px" },
            ],
            files.map((i) => ({
              file: fileIdentity(i, {summary: `<span>${e(bytes(i.size))}</span><time>${e(compactDate(i.createdAt))}</time>`}),
              date: e(date(i.createdAt)),
              size: e(bytes(i.size)),
              actions: `<a class="button secondary" download href="/api/platform/backup/files/${encodeURIComponent(i.filename)}">${e(t("downloadArchive"))}</a>`,
            })),
            {
              className: "backup-collection",
              empty: empty("noBackups", "startFirstBackup"),
            },
          ),
        );
      },
      "config-exports": () =>
        dialog(
          t("viewConfigExports"),
          `<p>${e(t("exportConfigHelp"))}</p><div class="export-choice"><strong>${e(t("configAndIndex"))}</strong><a class="button secondary" download href="/api/platform/backup/download?scope=config">${e(t("exportConfig"))}</a></div><div class="export-choice"><div><strong>${e(t("freshFullBackup"))}</strong><p>${e(t("freshFullHelp"))}</p></div><a class="button secondary" download href="/api/platform/backup/download?scope=full">${e(t("exportFull"))}</a></div>`,
        ),
    },
    signal,
  );
  ctx.tasks.pollBackup();
}

export async function mountUpdates(ctx, root, signal) {
  const state=ctx.drafts.section('updates',sectionValues('updates',ctx.config));
  const mirrors=['https://ghproxy.net/','https://gh-proxy.com/','https://mirror.ghproxy.com/'];
  root.innerHTML=heading('updates')+`<div class="settings-content update-content"><section class="panel update-control-card"><div class="update-control-layout"><a class="update-repository" href="https://github.com/weichen-ink/file-master-server" target="_blank" rel="noopener noreferrer"><span class="update-repository-icon">${icon('github')}</span><span class="update-repository-name"><strong>file-master-server ${icon('external')}</strong><span><span class="source-branch">${icon('branch')}${e(ctx.config.upstream_branch || 'main')}</span><span aria-hidden="true">·</span><span>${e(t('versionStatus'))} <strong id="version-value">v${e(ctx.status.version)}</strong></span></span></span></a><div class="update-connection-card"><div class="update-connection-toolbar"><label class="proxy-check" for="enable-proxy"><input id="enable-proxy" type="checkbox">${e(t('useUpdateProxy'))}</label><div id="proxy-options" class="update-proxy-fields"><div class="field"><label class="sr-only" for="update-mirror">${e(t('proxyWebsite'))}</label><select id="update-mirror">${mirrors.map(value=>`<option value="${value}">${e(new URL(value).hostname)}</option>`).join('')}<option value="custom">${e(t('customProxy'))}</option></select></div><div class="field" id="custom-proxy-field"><label class="sr-only" for="custom-mirror">${e(t('proxyAddress'))}</label><input id="custom-mirror" type="url" placeholder="https://" value="${e(state.draft.upstream_mirror || '')}"></div></div><div class="update-check-actions">${button('checkUpdate','check-update','primary')}</div></div><p id="update-source-error" class="field-error" role="status"></p></div></div></section><section id="update-details" aria-live="polite"></section><details id="update-log" open hidden><summary>${e(t('executionLog'))}</summary><pre class="code-panel"></pre></details></div>`;
  let available=false, checked=false, busy=false;
  const sync=()=>{
    if(signal.aborted)return;
    const enabled=state.draft.mirror_enabled;
    root.querySelector('#enable-proxy').checked=enabled;
    root.querySelector('#update-mirror').value=state.draft.mirror_preset;
    root.querySelector('#proxy-options').hidden=!enabled;
    root.querySelector('#custom-proxy-field').hidden=state.draft.mirror_preset!=='custom';
    const custom=root.querySelector('#custom-mirror');
    if(document.activeElement!==custom)custom.value=state.draft.upstream_mirror || '';
    root.querySelectorAll('button,input,select').forEach(el=>el.disabled=busy || state.saving);
    root.querySelector('#update-mirror').disabled=!enabled || busy || state.saving;
    custom.disabled=!enabled || state.draft.mirror_preset!=='custom' || busy || state.saving;
    const install=root.querySelector('[data-action="install"]');
    if(install){install.hidden=!available;install.disabled=busy || state.saving || !checked || ctx.drafts.dirty('updates') || ctx.config.hot_update===false;}
  };
  const invalidate=()=>{available=false;checked=false;root.querySelector('#update-details').replaceChildren();sync();};
  const sourceError=error=>{if(!signal.aborted)root.querySelector('#update-source-error').textContent=error?.message || '';};
  const saveSource=()=>{
    if(state.pending)return state.pending;
    if(!ctx.drafts.dirty('updates'))return Promise.resolve();
    const custom=root.querySelector('#custom-mirror');
    if(state.draft.mirror_enabled && state.draft.mirror_preset==='custom'){
      let parsed;try{parsed=new URL(custom.value);}catch{}
      if(!parsed || !['https:','http:'].includes(parsed.protocol))return Promise.reject(new Error(t('validProxyUrl')));
    }
    const session=ctx.sessionVersion, patch=sectionPatch('updates',state.draft);
    ctx.drafts.setSaving('updates',true);sourceError();sync();
    state.pending=(async()=>{
      try{
        const result=await ctx.api.save(patch);
        ctx.acceptConfig(result,'updates',session);
        state.saving=false;
        ctx.drafts.accept('updates',sectionValues('updates',result.config));
        if(!signal.aborted)root.querySelector('#custom-mirror').value=state.draft.upstream_mirror || '';
      }finally{state.pending=null;ctx.drafts.setSaving('updates',false);sync();}
    })();return state.pending;
  };
  root.querySelector('#enable-proxy').addEventListener('change',async event=>{
    ctx.drafts.edit('updates','mirror_enabled',event.target.checked);
    invalidate();sourceError();
    if(state.draft.mirror_enabled && state.draft.mirror_preset==='custom' && !state.draft.upstream_mirror){root.querySelector('#custom-mirror').focus();return;}
    try{await saveSource();}catch(error){sourceError(error);}
  },{signal});
  root.querySelector('#update-mirror').addEventListener('change',async event=>{
    ctx.drafts.edit('updates','mirror_preset',event.target.value);
    invalidate();sourceError();
    if(event.target.value==='custom'){root.querySelector('#custom-mirror').focus();return;}
    try{await saveSource();}catch(error){sourceError(error);}
  },{signal});
  const customMirror=root.querySelector('#custom-mirror');
  customMirror.addEventListener('input',event=>{ctx.drafts.edit('updates','upstream_mirror',event.target.value);sourceError();invalidate();},{signal});
  customMirror.addEventListener('change',async()=>{try{await saveSource();}catch(error){sourceError(error);}},{signal});
  const log=value=>{if(signal.aborted)return;const box=root.querySelector('#update-log');box.hidden=false;box.open=true;box.querySelector('pre').textContent=value;};
  actions(root,{
    'check-update':async()=>{
      busy=true;sync();
      try{
        try{await saveSource();}catch(error){sourceError(error);return;}
        if(signal.aborted)return;
        root.querySelector('#update-details').innerHTML=`<p class="section-description">${e(t('checkingUpdates'))}</p>`;
        const data=await ctx.api.update(true);if(signal.aborted)return;
        checked=true;available=Boolean(data.hasUpdate || data.dependenciesPending);
        root.querySelector('#version-value').textContent='v'+data.version;
        root.querySelector('#update-details').innerHTML=releaseResult(data,{available,enabled:ctx.config.hot_update!==false});
      }catch(error){checked=false;available=false;if(!signal.aborted)root.querySelector('#update-details').innerHTML=notice(error.message,'danger');}
      finally{busy=false;sync();}
    },
    install:async()=>{
      if(signal.aborted || !checked || !available || busy || state.saving || ctx.drafts.dirty('updates'))return;
      if(ctx.drafts.anyDirty())throw new Error(t('saveBeforeRestart'));
      busy=true;sync();log(t('pullingUpdate'));try{await restartAndReconnect(ctx,signal,{install:true,onProgress:log});available=false;checked=false;}
      catch(error){log(error.message);throw error;}finally{busy=false;sync();}
    }
  },signal);
  const unsubscribe=ctx.drafts.subscribe(sync);
  signal.addEventListener('abort',unsubscribe,{once:true});
  sync();
}

/** Preserve commit titles and paragraphs without displaying raw Git log formatting. */
export function releaseChanges(data) {
  if (Array.isArray(data.incomingChanges) && data.incomingChanges.length) return data.incomingChanges.map(change=>({title:String(change.title || ''),body:String(change.body || '').trim(),hash:String(change.hash || '').slice(0,7)}));
  const lines=data.incomingCommits?.length?data.incomingCommits:data.remoteCommitMessage?[data.remoteCommitMessage]:[];
  return lines.map(line=>{const match=String(line).match(/^([a-f0-9]{7,40})\s+([\s\S]*)$/i);return {title:match?match[2]:String(line),hash:match?match[1].slice(0,7):'',body:''};});
}


/** Same-version commits are updates too; avoid implying a version number change. */
export function releaseResult(data, {available=Boolean(data.hasUpdate || data.dependenciesPending), enabled=true} = {}) {
  const changes=releaseChanges(data);
  const current=String(data.version || '').replace(/^v/,''), remote=String(data.remoteVersion || '').replace(/^v/,'');
  const count=Math.max(changes.length,Number(data.commitsBehind)||0);
  const title=data.dependenciesPending ? t('updateDependenciesPending') : !available ? t('latest') : count ? t('updatesAvailableCount',{count}) : t('updateAvailable');
  const notes=available ? `<section class="release-changes">${changes.length ? `<ul class="release-notes">${changes.map(change=>`<li><article><h3>${e(change.title)}</h3>${change.body ? `<div class="release-note-body">${change.body.split(/\n\s*\n/).map(paragraph=>`<p>${e(paragraph).replace(/\n/g,'<br>')}</p>`).join('')}</div>` : ''}${change.hash ? `<code class="release-commit">${e(change.hash)}</code>` : ''}</article></li>`).join('')}</ul>` : `<p class="section-description">${e(t('releaseNotesUnavailable'))}</p>`}</section>` : '';
  return `<div class="panel release-result"><header class="release-result-heading"><h2>${e(title)}</h2>${available && remote && remote!==current ? `<span class="release-target-version">v${e(remote)}</span>` : ''}</header>${notes}${available ? `<footer class="release-actions">${button('installUpdate','install','primary')}${!enabled?notice(t('updatesDisabled'),'warning'):''}</footer>` : ''}</div>`;
}
