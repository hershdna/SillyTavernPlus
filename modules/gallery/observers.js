import { wireViewer } from './ui-controls.js';
import { installCustomOrderFetchHook, wireGallery } from './gallery-controls.js';
import { isGalleryEnabled } from './settings.js';

const PERFORMANCE_NOTICE = 'Open the full gallery in Character Library for better performance';
const TOPBAR_BUTTON_ID = 'stplus-gallery-topbar-button';
let performanceNoticeShown = false;

function isPerformanceNotice(value) {
  return String(value ?? '').includes(PERFORMANCE_NOTICE);
}

function installPerformanceNoticeDeduper(attempt = 0) {
  const toaster = window.toastr;
  if (!toaster || typeof toaster !== 'object') {
    if (attempt < 20) setTimeout(() => installPerformanceNoticeDeduper(attempt + 1), 250);
    return;
  }

  ['info', 'warning', 'success', 'error'].forEach((method) => {
    const original = toaster[method];
    if (typeof original !== 'function' || original._stplusGalleryPerformanceNoticeDeduper) return;
    const wrapped = function (...args) {
      if (isPerformanceNotice(args[0])) {
        if (performanceNoticeShown) return undefined;
        performanceNoticeShown = true;
      }
      return original.apply(this, args);
    };
    wrapped._stplusGalleryPerformanceNoticeDeduper = true;
    toaster[method] = wrapped;
  });
}

function observePerformanceNoticeDuplicates() {
  let noticeElementSeen = false;
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const candidates = [
          ...(node.matches('.toast, .popup, .dialogue_popup') ? [node] : []),
          ...node.querySelectorAll('.toast, .popup, .dialogue_popup'),
        ];
        candidates.forEach((candidate) => {
          if (!isPerformanceNotice(candidate.textContent)) return;
          if (noticeElementSeen) candidate.remove();
          else noticeElementSeen = true;
        });
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function applyGalleryTitle() {
  if (!isGalleryEnabled()) return;
  const t = document.querySelector('#gallery .dragTitle span');
  if (t && t.textContent !== 'Image Gallery') {
    t.textContent = 'Image Gallery';
  }
}

function openGalleryFromTopbar() {
  // The core Gallery extension owns the actual gallery-opening routine. Use
  // its existing action so the toolbar button stays compatible with ST.
  const galleryAction = document.querySelector('#show_gallery_wand_button');
  if (galleryAction instanceof HTMLElement) {
    galleryAction.click();
    return;
  }

  // Older ST builds expose the same action through the character-management
  // dropdown instead of the extensions menu.
  const management = document.querySelector('#char-management-dropdown');
  const galleryOption = management?.querySelector('#show_char_gallery');
  if (!(management instanceof HTMLSelectElement) || !galleryOption) return;
  const previous = management.value;
  management.value = 'show_char_gallery';
  management.dispatchEvent(new Event('change', { bubbles: true }));
  if (previous && previous !== 'show_char_gallery') {
    setTimeout(() => { management.value = previous; }, 0);
  }
}

function installTopbarGalleryButton() {
  if (!isGalleryEnabled()) {
    document.getElementById(TOPBAR_BUTTON_ID)?.remove();
    return;
  }
  // ST's main icon row is #top-settings-holder. Use the same drawer structure
  // as native icons and as Character Library so extensions can coexist in the
  // same flex row without introducing a differently sized/block-level button.
  const host = document.querySelector('#top-settings-holder') || document.querySelector('#top-bar');
  if (!(host instanceof HTMLElement)) return;

  let button = document.getElementById(TOPBAR_BUTTON_ID);
  if (!(button instanceof HTMLElement)) {
    button = document.createElement('div');
    button.id = TOPBAR_BUTTON_ID;
    button.title = 'Open image gallery';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.addEventListener('click', openGalleryFromTopbar);
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openGalleryFromTopbar();
    });
  }

  button.className = 'drawer stplus-gallery-topbar-gallery-button';
  if (!button.querySelector('.stplus-gallery-topbar-gallery-icon')) {
    button.replaceChildren();
    const toggle = document.createElement('div');
    toggle.className = 'drawer-toggle drawer-header';
    const icon = document.createElement('div');
    icon.className = 'drawer-icon fa-solid fa-image fa-fw closedIcon stplus-gallery-topbar-gallery-icon';
    icon.title = button.title;
    icon.setAttribute('aria-hidden', 'true');
    toggle.appendChild(icon);
    button.appendChild(toggle);
  }

  // Append only when absent. Re-moving the button after every toolbar change
  // can ping-pong with other extensions that also place their icon last.
  if (button.parentElement !== host) {
    host.appendChild(button);
  }
}

export function initObservers() {
  installPerformanceNoticeDeduper();
  observePerformanceNoticeDuplicates();
  installCustomOrderFetchHook();
  installTopbarGalleryButton();

  const galleryObserver = new MutationObserver((mutations) => {
    if (!isGalleryEnabled()) return;
    applyGalleryTitle();
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.('#gallery')) wireGallery(node);
        node.querySelectorAll?.('#gallery')?.forEach(wireGallery);
      }
    }
  });
  galleryObserver.observe(document.body, { childList: true, subtree: true });
  const topbarObserver = new MutationObserver(installTopbarGalleryButton);
  topbarObserver.observe(document.body, { childList: true, subtree: true });
  applyGalleryTitle();
  document.querySelectorAll('#gallery').forEach(wireGallery);

  const viewerObserver = new MutationObserver((muts) => {
    if (!isGalleryEnabled()) return;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.matches?.('.draggable.galleryImageDraggable')) wireViewer(n);
        n.querySelectorAll?.('.draggable.galleryImageDraggable')?.forEach(wireViewer);
      }
    }
  });
  viewerObserver.observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll('.draggable.galleryImageDraggable').forEach(wireViewer);
}

export function refreshObservers() {
  installTopbarGalleryButton();
  if (!isGalleryEnabled()) return;
  applyGalleryTitle();
  document.querySelectorAll('#gallery').forEach(wireGallery);
  document.querySelectorAll('.draggable.galleryImageDraggable').forEach(wireViewer);
}

