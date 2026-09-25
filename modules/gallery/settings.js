const EXT_ID = 'SillyTavernPlus';
const GALLERY_KEY = 'gallery';

export const FAVORITES_CHANGED_EVENT = 'stplus-gallery:favorites-changed';
export const RESUME_SESSION_CHANGED_EVENT = 'stplus-gallery:resume-session-changed';
const RESUME_STORAGE_KEY = 'SillyTavernPlus.gallery.resumeSessions.v1';
let resumeSessionMemory = {};
let pendingResumeRequest = null;

const DEFAULTS = {
  diag: Date.now(),
  openHeight: 800,
  hoverZoom: false,
  hoverZoomScale: 1.08,
  zoomLock: false,
  viewerRect: null,
  masonryDense: false,
  showCaptions: true,
  webpOnly: false,
  slideshowSpeedSec: 3,
  slideshowTransition: 'fade',
  videoMuted: false,
  videoControlsVisible: true,
  videoLoopTimeSec: 10,
  autoHideControls: false,
  presentationMode: 'all',
  favoritesByGallery: {},
  externalSources: {},
  groupGalleryFolders: {},
  fileTypeFilters: {},
  customOrders: {},
};

function ctx() {
  try {
    return window.SillyTavern?.getContext?.();
  } catch {
    return null;
  }
}

function _settingsBag() {
  const c = ctx();
  if (c?.extensionSettings) {
    const extensionSettings = c.extensionSettings[EXT_ID] ??= {};
    if (!extensionSettings[GALLERY_KEY] || typeof extensionSettings[GALLERY_KEY] !== 'object') {
      extensionSettings[GALLERY_KEY] = { ...DEFAULTS };
    }
    return extensionSettings[GALLERY_KEY];
  }
  const raw = localStorage.getItem('STPLUS_GALLERY_SETTINGS');
  if (!raw) {
    const init = { ...DEFAULTS };
    localStorage.setItem('STPLUS_GALLERY_SETTINGS', JSON.stringify(init));
    return init;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const init = { ...DEFAULTS };
    localStorage.setItem('STPLUS_GALLERY_SETTINGS', JSON.stringify(init));
    return init;
  }
}

export function stplusGallerySettings() {
  return _settingsBag();
}

export function stplusGallerySaveSettings(partial = {}) {
  const c = ctx();
  if (c?.extensionSettings) {
    c.extensionSettings[EXT_ID][GALLERY_KEY] = { ..._settingsBag(), ...partial };
    c.saveSettingsDebounced?.();
  } else {
    const merged = { ..._settingsBag(), ...partial };
    localStorage.setItem('STPLUS_GALLERY_SETTINGS', JSON.stringify(merged));
  }
}

export function isGalleryEnabled() {
  return ctx()?.extensionSettings?.[EXT_ID]?.galleryEnabled !== false;
}

export function stplusGalleryGetGroupGalleryFolder(groupId = '') {
  const key = String(groupId || '').trim();
  if (!key) return '';
  const stored = stplusGallerySettings().groupGalleryFolders;
  const folder = stored && typeof stored === 'object' ? stored[key] : '';
  return typeof folder === 'string' ? folder.trim() : '';
}

export function stplusGallerySetGroupGalleryFolder(groupId, folder = '') {
  const key = String(groupId || '').trim();
  if (!key) return;

  const stored = stplusGallerySettings().groupGalleryFolders;
  const groupGalleryFolders = stored && typeof stored === 'object' ? { ...stored } : {};
  const value = String(folder || '').trim();
  if (value) groupGalleryFolders[key] = value;
  else delete groupGalleryFolders[key];

  stplusGallerySaveSettings({ groupGalleryFolders });
}

export function stplusGalleryClearGroupGalleryFolder(groupId) {
  stplusGallerySetGroupGalleryFolder(groupId, '');
}

export function stplusGalleryFavoriteGalleryKey(folder = '') {
  return String(folder || '') || '__default__';
}

export function stplusGalleryFavoriteIdentity(source) {
  try {
    const url = new URL(String(source), location.href);
    return `${url.pathname}${url.search}`;
  } catch {
    return String(source || '');
  }
}

export function stplusGalleryGetFavoriteSet(folder = '') {
  const favorites = stplusGallerySettings().favoritesByGallery;
  const entries = favorites && typeof favorites === 'object'
    ? favorites[stplusGalleryFavoriteGalleryKey(folder)]
    : null;
  return new Set(Array.isArray(entries) ? entries.map(String) : []);
}

export function stplusGalleryToggleFavorite(folder, source) {
  const identity = stplusGalleryFavoriteIdentity(source);
  if (!identity) return false;

  const galleryKey = stplusGalleryFavoriteGalleryKey(folder);
  const stored = stplusGallerySettings().favoritesByGallery;
  const favoritesByGallery = stored && typeof stored === 'object' ? { ...stored } : {};
  const favorites = new Set(Array.isArray(favoritesByGallery[galleryKey])
    ? favoritesByGallery[galleryKey].map(String)
    : []);
  const favorite = !favorites.has(identity);
  if (favorite) favorites.add(identity);
  else favorites.delete(identity);
  favoritesByGallery[galleryKey] = [...favorites];
  stplusGallerySaveSettings({ favoritesByGallery });
  document.dispatchEvent(new CustomEvent(FAVORITES_CHANGED_EVENT, {
    detail: { galleryKey, identity, favorite },
  }));
  return favorite;
}

function readResumeSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RESUME_STORAGE_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      resumeSessionMemory = parsed;
    }
  } catch {
    // Use the in-memory copy if storage is unavailable or corrupt.
  }
  return resumeSessionMemory;
}

function writeResumeSessions(sessions) {
  resumeSessionMemory = sessions;
  try {
    localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(sessions));
  } catch (error) {
    console.warn('[SillyTavernPlus Gallery] Could not persist the complete resume session', error);
  }
}

export function stplusGalleryGetResumeSession(folder = '') {
  const session = readResumeSessions()[stplusGalleryFavoriteGalleryKey(folder)];
  return session && typeof session === 'object' ? session : null;
}

export function stplusGallerySaveResumeSession(folder, session) {
  const galleryKey = stplusGalleryFavoriteGalleryKey(folder);
  const sessions = { ...readResumeSessions(), [galleryKey]: session };
  writeResumeSessions(sessions);
  document.dispatchEvent(new CustomEvent(RESUME_SESSION_CHANGED_EVENT, {
    detail: { galleryKey, session },
  }));
}

export function stplusGalleryClearResumeSession(folder = '') {
  const galleryKey = stplusGalleryFavoriteGalleryKey(folder);
  const sessions = { ...readResumeSessions() };
  delete sessions[galleryKey];
  writeResumeSessions(sessions);
  document.dispatchEvent(new CustomEvent(RESUME_SESSION_CHANGED_EVENT, {
    detail: { galleryKey, session: null },
  }));
}

export function stplusGalleryQueueResumeRequest(folder, autoPlay = false) {
  pendingResumeRequest = {
    galleryKey: stplusGalleryFavoriteGalleryKey(folder),
    autoPlay: Boolean(autoPlay),
    expiresAt: Date.now() + 5000,
  };
}

export function stplusGalleryConsumeResumeRequest(folder) {
  const request = pendingResumeRequest;
  pendingResumeRequest = null;
  if (!request || request.expiresAt < Date.now()) return null;
  return request.galleryKey === stplusGalleryFavoriteGalleryKey(folder) ? request : null;
}
