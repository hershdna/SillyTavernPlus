import { initObservers, refreshObservers } from './observers.js';
import { isGalleryEnabled } from './settings.js';

const STYLE_ID = 'stplus-gallery-styles';
let observersStarted = false;

function syncStylesheet(enabled) {
  let stylesheet = document.getElementById(STYLE_ID);
  if (!enabled) {
    stylesheet?.remove();
    return;
  }
  if (stylesheet instanceof HTMLLinkElement) return;
  stylesheet = document.createElement('link');
  stylesheet.id = STYLE_ID;
  stylesheet.rel = 'stylesheet';
  const url = new URL('./style.css', import.meta.url);
  url.searchParams.set('v', new URL(import.meta.url).searchParams.get('v') || '0');
  stylesheet.href = url.href;
  document.head.appendChild(stylesheet);
}

export function initialize() {
  refresh();
}

export function refresh() {
  const enabled = isGalleryEnabled();
  syncStylesheet(enabled);
  if (enabled) {
    if (!observersStarted) {
      initObservers();
      observersStarted = true;
    }
    refreshObservers();
    return;
  }

  document.getElementById('stplus-gallery-topbar-button')?.remove();
  document.querySelectorAll('.galleryImageDraggable[data-stplus-gallery-direct-slideshow="1"]').forEach((window) => window.remove());
  // Existing gallery windows retain listeners added by this module. Closing
  // them makes disabling immediate; the native gallery can be reopened later.
  document.querySelectorAll('#gallery[data-stplus-gallery-gallery-wired="1"]').forEach((window) => window.remove());
}
