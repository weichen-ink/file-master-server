import { e, icon, empty } from "../ui.mjs";
import { t } from "../locale.mjs";

/** Image viewer uses actual pixel scale; drag and wheel work only inside its viewport. */
export function mountViewer(stage, image, { onScale = () => {}, signal }) {
  let scale = 1,
    fitScale = 1,
    x = 0,
    y = 0,
    drag = null;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const render = () => {
    const width = image.naturalWidth * scale,
      height = image.naturalHeight * scale;
    // Allow repositioning at every scale while keeping part of the image reachable.
    const limitX = (width + stage.clientWidth) / 2 - Math.min(40, width / 2);
    const limitY = (height + stage.clientHeight) / 2 - Math.min(40, height / 2);
    x = clamp(x, -Math.max(0, limitX), Math.max(0, limitX));
    y = clamp(y, -Math.max(0, limitY), Math.max(0, limitY));
    image.style.width = image.naturalWidth + "px";
    image.style.height = image.naturalHeight + "px";
    image.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
    stage.classList.toggle(
      "can-pan",
      Boolean(image.naturalWidth),
    );
    onScale(Math.round(scale * 100));
  };
  const fit = () => {
    if (!image.naturalWidth) return;
    fitScale = Math.min(
      (stage.clientWidth - 32) / image.naturalWidth,
      (stage.clientHeight - 32) / image.naturalHeight,
      1,
    );
    scale = fitScale;
    x = 0;
    y = 0;
    render();
  };
  const zoom = (factor, anchor) => {
    const old = scale;
    scale = clamp(scale * factor, Math.min(fitScale, 0.1), 8);
    if (anchor) {
      x = anchor.x - ((anchor.x - x) * scale) / old;
      y = anchor.y - ((anchor.y - y) * scale) / old;
    }
    render();
  };
  image.draggable = false;
  image.addEventListener("load", fit, { signal });
  if (image.complete) fit();
  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15, {
        x: event.clientX - rect.left - stage.clientWidth / 2,
        y: event.clientY - rect.top - stage.clientHeight / 2,
      });
    },
    { passive: false, signal },
  );
  stage.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      stage.setPointerCapture(event.pointerId);
      stage.classList.add("dragging");
    },
    { signal },
  );
  stage.addEventListener(
    "pointermove",
    (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      x += event.clientX - drag.x;
      y += event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      render();
    },
    { signal },
  );
  const release = () => {
    drag = null;
    stage.classList.remove("dragging");
  };
  stage.addEventListener("pointerup", release, { signal });
  stage.addEventListener("pointercancel", release, { signal });
  stage.addEventListener(
    "keydown",
    (event) => {
      const moves = {
        ArrowLeft: [32, 0],
        ArrowRight: [-32, 0],
        ArrowUp: [0, 32],
        ArrowDown: [0, -32],
      };
      if (moves[event.key]) {
        event.preventDefault();
        x += moves[event.key][0];
        y += moves[event.key][1];
        render();
      } else if (["+", "=", "-", "0"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "0") fit();
        else zoom(event.key === "-" ? 1 / 1.2 : 1.2);
      }
    },
    { signal },
  );
  const resize = new ResizeObserver(fit);
  resize.observe(stage);
  signal.addEventListener("abort", () => resize.disconnect(), { once: true });
  return {
    fit,
    zoomIn: () => zoom(1.25),
    zoomOut: () => zoom(1 / 1.25),
    setScale: (percent) => {
      scale = clamp(Number(percent) / 100, 0.05, 8);
      x = y = 0;
      render();
    },
  };
}


/** The same controls and canvas power inline and dialog previews. */
export function viewerControls({ expand = false } = {}) {
  return `<div class="viewer-controls" role="group" aria-label="${e(t('viewerZoom'))}"><button type="button" class="icon-button viewer-zoom-button" data-viewer="out" aria-label="${e(t('zoomOut'))}" title="${e(t('zoomOut'))}">${icon('minus')}</button><details class="zoom-presets"><summary class="viewer-zoom-value" aria-label="${e(t('chooseZoom'))}" title="${e(t('chooseZoom'))}"><span data-zoom-value>—</span></summary><div class="zoom-preset-menu"><button type="button" data-viewer="fit">${e(t('fit'))}</button>${[25,50,75,100,150,200,400].map(value=>`<button type="button" data-viewer="scale" data-scale="${value}">${value}%</button>`).join('')}</div></details><button type="button" class="icon-button viewer-zoom-button" data-viewer="in" aria-label="${e(t('zoomIn'))}" title="${e(t('zoomIn'))}">${icon('plus')}</button>${expand ? `<span class="viewer-zoom-divider" aria-hidden="true"></span><button type="button" class="icon-button viewer-zoom-button" data-viewer="expand" aria-label="${e(t('largePreview'))}" title="${e(t('largePreview'))}">${icon('fit')}</button>` : ''}</div>`;
}

export function bindViewerControls(root, getViewer, { signal, onExpand } = {}) {
  const menu = root.querySelector('.zoom-presets');
  root.addEventListener('click', event => {
    const target = event.target.closest('[data-viewer]');
    if (!target) return;
    const viewer = getViewer();
    if (target.dataset.viewer === 'expand') onExpand?.();
    if (target.dataset.viewer === 'in') viewer?.zoomIn();
    if (target.dataset.viewer === 'out') viewer?.zoomOut();
    if (target.dataset.viewer === 'fit') viewer?.fit();
    if (target.dataset.viewer === 'scale') viewer?.setScale(Number(target.dataset.scale));
    if (menu.open) { menu.open = false; menu.querySelector('summary').focus(); }
  }, { signal });
  document.addEventListener('click', event => { if (!menu.contains(event.target)) menu.open = false; }, { signal });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.open) { event.preventDefault(); event.stopPropagation(); menu.open = false; menu.querySelector('summary').focus(); }
  }, { signal });
  return value => {
    root.querySelector('[data-zoom-value]').textContent = value + '%';
    menu.querySelector('summary').setAttribute('aria-label', t('zoomPercent', {value}));
    menu.querySelectorAll('[data-scale]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.scale) === value)));
  };
}

export function openImagePreview({ src, filename, signal }) {
  if (signal?.aborted) return;
  const previous = document.activeElement;
  const controller = new AbortController();
  const modal = document.createElement('dialog');
  modal.className = 'image-preview-dialog';
  modal.innerHTML = `<header><h2>${e(filename)}</h2><div class="image-preview-actions">${viewerControls()}<span class="viewer-zoom-divider" aria-hidden="true"></span><button type="button" class="icon-button" data-preview-close aria-label="${e(t('close'))}" title="${e(t('close'))}">${icon('close')}</button></div></header><div class="image-preview-canvas image-viewport" tabindex="0" aria-label="${e(t('viewerHelp'))}"><img src="${e(src)}" alt="${e(filename)}" draggable="false"></div><p class="image-preview-hint">${e(t('viewerHelp'))}</p>`;
  document.body.append(modal);
  modal.showModal();
  const stage = modal.querySelector('.image-viewport'), image = stage.querySelector('img');
  let viewer;
  const setScale = bindViewerControls(modal.querySelector('.viewer-controls'), () => viewer, {signal:controller.signal});
  viewer = mountViewer(stage, image, {signal:controller.signal, onScale:setScale});
  image.addEventListener('error', () => { stage.innerHTML = empty('previewFailed','unsupportedDesc','','image'); }, {signal:controller.signal});
  const close = () => modal.close();
  let backdropDown = false;
  const outside = event => { const rect=modal.getBoundingClientRect(); return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom; };
  modal.addEventListener('pointerdown',event=>{backdropDown=event.target===modal && outside(event);},{signal:controller.signal});
  modal.addEventListener('click',event=>{if(backdropDown && event.target===modal && outside(event))close();backdropDown=false;},{signal:controller.signal});
  modal.querySelector('[data-preview-close]').addEventListener('click',close,{signal:controller.signal});
  signal?.addEventListener('abort',close,{once:true});
  modal.addEventListener('close', () => {
    controller.abort(); signal?.removeEventListener('abort',close); modal.remove();
    if (previous?.isConnected && !signal?.aborted) previous.focus();
  }, {once:true});
  stage.focus();
}
