import { getTheme } from "../theme.mjs";
import { mountClientIntegration } from "./operations.mjs";
import { schemas, sectionValues, sectionPatch } from "./settings-schema.mjs";
import { t } from "../locale.mjs";
import {
  e,
  button,
  heading,
  notice,
  actions,
  confirm,
  toast,
  icon,
  dialog,
  copy,
} from "../ui.mjs";

function fieldHtml(def, value) {
  const attrs = `id="f_${e(def.key)}" name="${e(def.key)}" ${def.required ? "required" : ""}`;
  const options = def.options?.map(([v,key])=>`<option value="${e(v)}" ${String(v)===String(value)?"selected":""}>${e(t(key))}</option>`).join("");
  const secret=def.type==='password';
  const input=`<input ${attrs} type="${def.type}" value="${e(value)}" ${secret?`autocomplete="${def.key==='password'?'new-password':'off'}" spellcheck="false" placeholder="${e(t('secretKeep'))}"`:""} ${def.min!=null?`min="${def.min}"`:""} ${def.max!=null?`max="${def.max}"`:""} ${def.step!=null?`step="${def.step}"`:""}>`;
  const toggle=secret?`<button type="button" class="secret-toggle" data-action="toggle-secret" data-key="${e(def.key)}" title="${e(t('btnShowSecret'))}" aria-label="${e(t('btnShowSecret'))} · ${e(t(def.label))}" aria-pressed="false">${icon('eye')}</button>`:"";
  const control=secret?`<div class="secret-control">${input}${toggle}</div>`:input;
  const test=def.key==='rclone_target'?button('testConnection','test-rclone'):def.key==='bark_url'?button('testPush','test-bark'):def.key==='api_token'?button('copyCurrentToken','copy-current-token','secondary','copy'):"";
  return `<div class="field" data-field="${e(def.key)}"><label for="f_${e(def.key)}">${e(t(def.label))}</label>${def.type==='select'?`<select ${attrs}>${options}</select>`:`<div class="input-row">${control}${test}</div>`}<span class="field-error" id="error_${e(def.key)}"></span></div>`;
}
const samplePreview = () => `<aside class="watermark-preview"><h3>${e(t("watermarkPreview"))}</h3><label class="sr-only" for="sample-select">${e(t("chooseSample"))}</label><select id="sample-select"><option value="">${e(t("chooseSample"))}</option></select><div id="sample-output" class="sample-output">${icon("image")}</div><p id="sample-state" class="muted" role="status"></p></aside>`;
function sectionFields(name,state) {
  const render=keys=>keys.map(key=>schemas[name].find(def=>def.key===key)).filter(Boolean).map(def=>fieldHtml(def,state.draft[def.key])).join('');
  const section=(title,keys,extra="")=>`<section class="form-section"><h2>${e(t(title))}</h2><div class="fields">${render(keys)}${extra}</div></section>`;
  if(name==='site') return section('siteIdentity',['site_name'], `<div class="field"><label for="appearance-select">${e(t('theme'))}</label><select id="appearance-select" data-theme-select>${[['auto','themeAuto'],['light','themeLight'],['dark','themeDark']].map(([value,label])=>`<option value="${value}" ${getTheme()===value?'selected':''}>${e(t(label))}</option>`).join('')}</select></div>${render(['base_url','port'])}`) + section('accountAccess',['username','password','admin_path','max_login_attempts','api_token']) + section('fileLinks',['raw_secret_path','pub_secret_path','card_copy_format']);
  if(name==='media') return section('compression',schemas.compression.map(def=>def.key)) + `<section class="form-section"><h2>${e(t('watermark'))}</h2><div class="watermark-workspace"><div class="fields">${render(schemas.watermark.map(def=>def.key))}</div>${samplePreview()}</div></section>`;
  return `<div class="fields">${schemas[name].map(def=>fieldHtml(def,state.draft[def.key])).join('')}</div>`;
}

export async function mountSettings(ctx, root, route, signal) {
  const name = route.section;
  const isMedia = name === "media";
  await ctx.loadConfig();
  if (signal.aborted) return;
  const help = {
    general: "addressHelp",
    site: "connectionSettingsChange",
    security: "securityHelp",
    compression: "mediaHelp",
    watermark: "mediaHelp",
    backup: "backupHelp",
    advanced: "advancedHelp",
  }[name];
  if (name === "integration") return mountClientIntegration(ctx, root, signal);
  if (name === "advanced") return mountAdvanced(ctx, root, signal);
  if (name === "updates") return ctx.mountUpdates(root, signal);
  const state = ctx.drafts.section(name, sectionValues(name, ctx.config));
  root.innerHTML =
    heading(name, help) +
    `<div class="settings-layout"><div class="settings-content"><form id="section-form" class="panel" novalidate>${name === "backup" ? `<h2>${e(t("backupSettings"))}</h2>` : ""}${sectionFields(name,state)}<div id="section-error" role="alert"></div><footer class="save-bar"><strong id="save-state"></strong><div class="actions">${button("discard", "discard")}<button class="button primary" type="submit" id="save-section">${e(t("save"))}</button></div></footer></form>${name === "backup" ? `<section class="panel" id="backup-runtime"></section><section class="panel restore-guide"><h2>${e(t("restoreGuide"))}</h2><p>${e(t("restorePlain"))}</p></section>` : ""}</div></div>`;
  let schedulePreview = () => {};
  const form = root.querySelector("#section-form");
  const sync = () => {
    for (const def of schemas[name]) {
      const wrap = form.querySelector(`[data-field="${def.key}"]`);
      const visible = !def.when || def.when(state.draft);
      wrap.hidden = !visible;
      wrap.querySelector("input,select").disabled = !visible || state.saving;
    }
    if (isMedia) form.querySelector(".watermark-preview").hidden = !state.draft.watermark_enable;
    root.querySelector("#save-state").textContent = t(
      state.saving ? "saving" : ctx.drafts.dirty(name) ? "unsaved" : "",
    );
    form.querySelector(".save-bar").hidden =
      !state.saving && !ctx.drafts.dirty(name);
    root.querySelector("#save-section").disabled =
      state.saving || !ctx.drafts.dirty(name);
    root.querySelector('[data-action="discard"]').disabled =
      state.saving || !ctx.drafts.dirty(name);
  };
  form.addEventListener(
    "input",
    (event) => {
      const def = schemas[name].find((f) => f.key === event.target.name);
      if (!def) return;
      const raw = event.target.value;
      ctx.drafts.edit(
        name,
        def.key,
        def.boolean
          ? raw === "true"
          : def.type === "number" || def.numeric
            ? raw === ""
              ? ""
              : Number(raw)
            : raw,
      );
      sync();
      schedulePreview();
    },
    { signal },
  );
  form.addEventListener("change", () => sync(), { signal });
  form.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      if (state.saving || !form.reportValidity()) return;
      const sensitiveKeys = name === 'site'
        ? ['username','password','api_token','admin_path','max_login_attempts','base_url','port','raw_secret_path','pub_secret_path']
        : name === 'general' ? ['base_url','port','raw_secret_path','pub_secret_path'] : [];
      if (name === 'security' || sensitiveKeys.some(key => state.draft[key] !== state.baseline[key])) {
        if (!(await confirm(t(name), t('connectionSettingsChange')))) return;
      }
      state.saving = true;
      sync();
      root.querySelector("#section-error").textContent = "";
      try {
        const session = ctx.sessionVersion;
        const data = await ctx.api.save(sectionPatch(name, state.draft));
        ctx.acceptConfig(data, name, session);
        toast(t("configSaved"));
        ctx.drafts.accept(name, sectionValues(name, data.config));
        if (data.adminPathChanged) {
          location.assign("/" + data.newAdminPath + "#/settings/site");
          return;
        }
        await ctx.refreshStatus();
        ctx.invalidateFiles();
        if (!signal.aborted) ctx.render();
      } catch (error) {
        if (!signal.aborted)
          root.querySelector("#section-error").innerHTML = notice(
            error.message,
            "danger",
          );
      } finally {
        state.saving = false;
        if (!signal.aborted) sync();
      }
    },
    { signal },
  );
  actions(
    root,
    {
      discard: () => {
        ctx.drafts.discard(name);
        ctx.render();
      },
      "toggle-secret": async (target) => {
        const input = root.querySelector(`#f_${target.dataset.key}`);
        if (target.dataset.key === 'api_token') {
          if (input.type === 'password' && !state.draft.api_token) {
            const result = await ctx.api.config(true);
            if (signal.aborted) return;
            if (!state.draft.api_token) input.value = result.config.api_token || '';
          } else if (input.type !== 'password' && !state.draft.api_token) input.value = '';
        }
        input.type = input.type === "password" ? "text" : "password";
        const revealed=input.type!=="password",label=t(revealed?"btnHideSecret":"btnShowSecret");
        target.innerHTML=icon(revealed?"eyeOff":"eye");
        target.setAttribute("title",label);
        target.setAttribute("aria-label",label+" · "+t(schemas[name].find(def=>def.key===target.dataset.key).label));
        target.setAttribute("aria-pressed",String(revealed));
      },
      "copy-current-token": async () => {
        const result = await ctx.api.config(true);
        if (!signal.aborted) await copy(result.config.api_token);
      },
      "test-rclone": async () => {
        if (!state.draft.rclone_target) throw new Error(t("required"));
        await ctx.api.testBackup("rclone", state.draft.rclone_target);
        toast(t("connected"));
      },
      "test-bark": async () => {
        if (!state.draft.bark_url) throw new Error(t("required"));
        await ctx.api.testBackup("bark", state.draft.bark_url);
        toast(t("completed"));
      },
    },
    signal,
  );
  sync();
  if (name === "backup")
    ctx.mountBackup(root.querySelector("#backup-runtime"), signal);
  if (isMedia) {
    await ctx.loadFiles();
    if (signal.aborted) return;
    const eligible = ctx.files.items
      .filter((i) => i.isProcessableImage)
      .slice(0, 20);
    const select = root.querySelector("#sample-select");
    select.innerHTML += eligible
      .map(
        (item, index) =>
          `<option value="${index}">${e(item.filename)}</option>`,
      )
      .join("");
    let timer,
      requestController,
      objectUrl,
      revision = 0;
    const preview = async () => {
      const current = ++revision;
      requestController?.abort();
      if (select.value === "" || !state.draft.watermark_enable) {
        root.querySelector("#sample-output").innerHTML = icon("image");
        return;
      }
      const item = eligible[Number(select.value)];
      requestController = new AbortController();
      const output = root.querySelector("#sample-output"),
        status = root.querySelector("#sample-state");
      status.textContent = t("renderingPreview");
      try {
        const compression = state.draft;
        const watermark = state.draft;
        const blob = await ctx.api.previewDraft(
          {
            year: item.year,
            month: item.month,
            filename: item.filename,
            image_host: { ...compression, ...watermark },
          },
          requestController.signal,
        );
        if (signal.aborted || current !== revision) return;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(blob);
        output.innerHTML = `<img src="${e(objectUrl)}" alt="${e(item.filename)}">`;
        status.textContent = !compression.enable_optimization
          ? t("optimizationOff")
          : t("draftPreview");
      } catch (error) {
        if (
          error.name !== "AbortError" &&
          !signal.aborted &&
          current === revision
        )
          status.textContent = error.message;
      }
    };
    schedulePreview = () => {
      clearTimeout(timer);
      requestController?.abort();
      revision++;
      timer = setTimeout(preview, 450);
    };
    select.addEventListener("change", preview, { signal });
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        requestController?.abort();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      },
      { once: true },
    );
    if (eligible.length) {
      select.value = "0";
      preview();
    } else
      root.querySelector("#sample-state").textContent = t("noPreviewSample");
  }
}

async function mountAdvanced(ctx, root, signal) {
  const state=ctx.drafts.section('advanced',{raw:ctx.rawYaml,revision:ctx.configRevision});
  root.innerHTML=heading('advanced')+`<div class="settings-content"><form class="panel configuration-editor" id="yaml-form"><div class="editor-heading"><span class="editor-filename">config.yaml</span><p>${e(t('configEditorHelp'))}</p></div><label class="sr-only" for="rawYamlEditor">${e(t('advanced'))}</label><textarea id="rawYamlEditor" name="raw" class="code-editor" spellcheck="false" aria-describedby="yaml-error">${e(state.draft.raw)}</textarea><p class="editor-secret-note">${e(t('credentialsManagedIn'))}<a href="#/settings/site">${e(t('site'))}</a>${e(t('credentialsManagedAfter'))}</p><div id="yaml-error" role="alert"></div><footer class="save-bar"><span id="yaml-state"></span><div class="actions">${button('discard','discard')}${button('saveConfigFile','validate','primary')}</div></footer></form></div>`;
  const editor=root.querySelector('#rawYamlEditor');
  const sync=()=>{
    if(signal.aborted)return;const dirty=ctx.drafts.dirty('advanced');
    editor.disabled=Boolean(state.saving);
    root.querySelector('[data-action="validate"]').disabled=Boolean(state.saving)||!dirty;
    root.querySelector('[data-action="discard"]').hidden=!dirty;
    root.querySelector('[data-action="discard"]').disabled=Boolean(state.saving);
    root.querySelector('#yaml-state').textContent=state.saving?t('saving'):'';
  };
  editor.addEventListener('input',()=>{ctx.drafts.edit('advanced','raw',editor.value);editor.removeAttribute('aria-invalid');root.querySelector('#yaml-error').replaceChildren();sync();},{signal});
  const fieldName=key=>{
    const leaf=key.split('.').at(-1), def=Object.values(schemas).flat().find(def=>def.key===leaf);
    return def?t(def.label):t(key);
  };
  const valueText=value=>value===null?t('notSet'):typeof value==='boolean'?t(value?'enabled':'disabled'):typeof value==='object'?JSON.stringify(value):String(value);
  const errorText=error=>{
    if(error.message==='EDIT_CREDENTIALS_IN_SECURITY')return t('credentialsEditorError');
    if(error.message==='CONFIG_CHANGED')return t('rawStale');
    const line=error.details?.line;
    if(line){
      const code=error.details.code;
      const reason=t(code==='DUPLICATE_KEY'?'yamlDuplicate':code==='MISSING_CHAR'?'yamlMissingChar':code==='TAB_AS_INDENT'?'yamlTabs':'yamlFormatError');
      const start=editor.value.split('\n').slice(0,line-1).reduce((total,value)=>total+value.length+1,0);
      editor.focus();editor.setSelectionRange(start,start+(editor.value.split('\n')[line-1]?.length||0));
      return t('yamlLineError',{line,reason});
    }
    return error.message;
  };
  actions(root,{
    discard:()=>{ctx.drafts.accept('advanced',{raw:ctx.rawYaml,revision:ctx.configRevision});ctx.rawStale=false;ctx.render();},
    validate:async()=>{
      if(state.saving)return;state.saving=true;sync();
      const error=root.querySelector('#yaml-error');error.replaceChildren();
      try{
        if(ctx.rawStale)throw new Error(t('rawStale'));
        if(Object.keys(schemas).some(name=>ctx.drafts.dirty(name)))throw new Error(t('rawConflict'));
        const session=ctx.sessionVersion;
        const preview=await ctx.api.validateRaw(state.draft.raw,state.draft.revision);if(signal.aborted)return;
        if(preview.changes?.length){
          const accepted=await dialog(t('reviewConfigChanges'),`<ul class="config-changes">${preview.changes.map(change=>`<li><strong>${e(fieldName(change.key))}</strong><div><span>${e(valueText(change.before))}</span><span aria-label="${e(t('changesTo'))}">→</span><span>${e(valueText(change.after))}</span></div></li>`).join('')}</ul>${preview.changes.some(change=>['admin_path','username','base_url','port'].includes(change.key))?notice(t('connectionSettingsChange'),'warning'):''}`,{submit:t('confirmSave'),cancel:t('backToEdit')});
          if(!accepted || signal.aborted)return;
        }
        const result=await ctx.api.saveRaw(state.draft.raw,state.draft.revision);
        ctx.acceptConfig(result,'advanced',session);ctx.drafts.accept('advanced',{raw:result.rawYaml,revision:result.revision});ctx.rawStale=false;
        ctx.invalidateFiles();await ctx.refreshStatus();toast(t('rawSaved'));
        if(result.adminPathChanged)location.assign('/'+result.newAdminPath+'#/settings/advanced');else ctx.render();
      }catch(err){if(!signal.aborted){editor.disabled=false;editor.setAttribute('aria-invalid','true');error.innerHTML=notice(errorText(err),'danger');}}
      finally{state.saving=false;sync();}
    }
  },signal);sync();
}
