import { FAVORITES_CHANGED_EVENT, stplusGalleryConsumeResumeRequest, stplusGalleryFavoriteGalleryKey, stplusGalleryFavoriteIdentity, stplusGalleryGetFavoriteSet, stplusGalleryGetResumeSession, stplusGallerySaveResumeSession, stplusGallerySettings, stplusGallerySaveSettings, stplusGalleryToggleFavorite, isGalleryEnabled } from './settings.js';
import { isVideoSource, MEDIA_DISPLAYED_EVENT, transitionTo } from './transitions.js';
import { getCachedExternalGalleryPaths, omitFailedExternalMedia } from './gallery-controls.js';

const GALLERY_FILE_TYPES = ['bmp', 'gif', 'jfif', 'jpeg', 'jpg', 'png', 'webp', 'mov', 'mp4', 'webm'];
const MEDIA_LOAD_TIMEOUT_MS = 10000;

export function wireViewer(root) {
  if (!isGalleryEnabled() || !root || root.dataset.stplusGalleryWired === '1' || root.dataset.stplusGalleryWiring === '1') return;

  const pcBar = root.querySelector('.panelControlBar');
  if (!pcBar) return;

  root.dataset.stplusGalleryWiring = '1';
  injectLeftControls(root, pcBar);

  const setupSteps = [
    ['gallery list', initializeGalleryList],
    ['zoom and pan', wireZoomAndPan],
    ['keyboard navigation', wireKeyboardNav],
    ['default viewer position', applyDefaultRect],
    ['window repositioning', wireWindowDrag],
    ['fullscreen state', wireFullscreenStateSync],
  ];

  for (const [name, setup] of setupSteps) {
    try {
      setup(root);
    } catch (error) {
      console.error(`[SillyTavernPlus Gallery] Failed to initialize ${name}`, error);
    }
  }

  let resumedMedia = null;
  try {
    resumedMedia = restorePendingResumeSession(root);
  } catch (error) {
    console.error('[SillyTavernPlus Gallery] Failed to restore slideshow position', error);
  }
  wireResumeCheckpointing(root);

  const revealViewer = () => {
    root.dataset.stplusGalleryWired = '1';
    root.dataset.stplusGalleryResuming = '0';
    queueResumeCheckpoint(root);
  };
  if (resumedMedia?.dataset.stplusGalleryTransitionPending === '1') {
    root.dataset.stplusGalleryResuming = '1';
    root.addEventListener(MEDIA_DISPLAYED_EVENT, revealViewer, { once: true });
    setTimeout(() => {
      if (root.dataset.stplusGalleryWired !== '1') revealViewer();
    }, MEDIA_LOAD_TIMEOUT_MS);
  } else {
    revealViewer();
  }
  delete root.dataset.stplusGalleryWiring;
}

function injectLeftControls(root, pcBar) {
  let left = root.querySelector(':scope > .stplus-gallery-controls-left');
  if (!left) {
    left = document.createElement('div');
    left.className = 'stplus-gallery-controls-left';
    root.insertBefore(left, pcBar);
  } else {
    left.innerHTML = '';
  }

  let progressRow = root.querySelector(':scope > .stplus-gallery-progress-row');
  if (!progressRow) {
    progressRow = document.createElement('div');
    progressRow.className = 'stplus-gallery-progress-row';
    root.insertBefore(progressRow, pcBar);
  } else {
    progressRow.innerHTML = '';
  }

  // 💾 save default size/pos
  const saveBtn = document.createElement('button');
  saveBtn.className = 'stplus-gallery-btn stplus-gallery-save';
  const saveTip = 'Save as default size and location';
  saveBtn.title = saveTip;
  saveBtn.setAttribute('aria-label', saveTip);
  const saveIcon = document.createElement('span');
  saveIcon.setAttribute('aria-hidden', 'true');
  saveIcon.textContent = '💾';
  saveBtn.appendChild(saveIcon);
  saveBtn.addEventListener('click', () => saveDefaultRect(root));

  // 🔍 toggle hover zoom
  const zoomBtn = document.createElement('button');
  zoomBtn.className = 'stplus-gallery-btn stplus-gallery-zoom';
  const zoomTip = 'Toggle hover zoom (off = scroll zoom + pan)';
  zoomBtn.title = zoomTip;
  zoomBtn.setAttribute('aria-label', zoomTip);
  const zoomIcon = document.createElement('span');
  zoomIcon.setAttribute('aria-hidden', 'true');
  zoomIcon.textContent = '🔍';
  zoomBtn.appendChild(zoomIcon);
  zoomBtn.classList.toggle('active', !!stplusGallerySettings().hoverZoom);
  zoomBtn.addEventListener('click', () => {
    const ns = !stplusGallerySettings().hoverZoom;
    stplusGallerySaveSettings({ hoverZoom: ns });
    zoomBtn.classList.toggle('active', ns);
  });

  // 🔓 keep image zoom and pan when progressing to another slide
  const zoomLockBtn = document.createElement('button');
  zoomLockBtn.className = 'stplus-gallery-btn stplus-gallery-zoom-lock';
  const zoomLockIcon = document.createElement('span');
  zoomLockIcon.setAttribute('aria-hidden', 'true');
  zoomLockBtn.appendChild(zoomLockIcon);
  const refreshZoomLockButton = () => {
    const locked = !!stplusGallerySettings().zoomLock;
    const label = locked
      ? 'Unlock zoom reset between slides'
      : 'Lock zoom and pan across slides';
    zoomLockBtn.classList.toggle('active', locked);
    zoomLockBtn.setAttribute('aria-pressed', String(locked));
    zoomLockBtn.title = label;
    zoomLockBtn.setAttribute('aria-label', label);
    zoomLockIcon.textContent = locked ? '🔒' : '🔓';
  };
  zoomLockBtn.addEventListener('click', () => {
    stplusGallerySaveSettings({ zoomLock: !stplusGallerySettings().zoomLock });
    refreshZoomLockButton();
  });
  refreshZoomLockButton();

  function stepSlideshow(direction) {
    if (direction < 0) goPrev(root); else goNext(root);
  }

  // ⏮️ previous image
  const prevBtn = document.createElement('button');
  prevBtn.className = 'stplus-gallery-btn stplus-gallery-prev';
  const prevTip = 'Previous image (Ctrl+Left Arrow)';
  prevBtn.title = prevTip;
  prevBtn.setAttribute('aria-label', prevTip);
  const prevIcon = document.createElement('span');
  prevIcon.setAttribute('aria-hidden', 'true');
  prevIcon.textContent = '⏮️';
  prevBtn.appendChild(prevIcon);
  prevBtn.addEventListener('click', () => stepSlideshow(-1));

  // ▶️/⏸️ start/pause slideshow
  const playBtn = document.createElement('button');
  playBtn.className = 'stplus-gallery-btn stplus-gallery-play';
  const playTip = 'Play slideshow (Ctrl+Space)';
  playBtn.title = playTip;
  playBtn.setAttribute('aria-label', playTip);
  playBtn.setAttribute('aria-pressed', 'false');
  const playIcon = document.createElement('span');
  playIcon.setAttribute('aria-hidden', 'true');
  playIcon.textContent = '▶️';
  playBtn.appendChild(playIcon);
  playBtn.addEventListener('click', () => {
    if (root.dataset.stplusGalleryPlaying === '1') stopSlideshow(root);
    else startSlideshow(root);
  });

  // ⏭️ next image
  const nextBtn = document.createElement('button');
  nextBtn.className = 'stplus-gallery-btn stplus-gallery-next';
  const nextTip = 'Next image (Ctrl+Right Arrow)';
  nextBtn.title = nextTip;
  nextBtn.setAttribute('aria-label', nextTip);
  const nextIcon = document.createElement('span');
  nextIcon.setAttribute('aria-hidden', 'true');
  nextIcon.textContent = '⏭️';
  nextBtn.appendChild(nextIcon);
  nextBtn.addEventListener('click', () => stepSlideshow(1));

  // 🔀 randomize slideshow order
  const randomBtn = document.createElement('button');
  randomBtn.className = 'stplus-gallery-btn stplus-gallery-random';
  const randomTip = 'Toggle randomized slideshow order';
  randomBtn.title = randomTip;
  randomBtn.setAttribute('aria-label', randomTip);
  randomBtn.setAttribute('aria-pressed', 'false');
  const randomIcon = document.createElement('span');
  randomIcon.setAttribute('aria-hidden', 'true');
  randomIcon.textContent = '🔀';
  randomBtn.appendChild(randomIcon);
  randomBtn.addEventListener('click', () => {
    const randomized = toggleRandomizedGalleryOrder(root);
    randomBtn.classList.toggle('active', randomized);
    randomBtn.setAttribute('aria-pressed', String(randomized));
    queueResumeCheckpoint(root);
  });

  // ⭐ favorite the current item for this gallery
  const favoriteBtn = document.createElement('button');
  favoriteBtn.className = 'stplus-gallery-btn stplus-gallery-favorite';
  favoriteBtn.setAttribute('aria-pressed', 'false');
  const favoriteIcon = document.createElement('span');
  favoriteIcon.setAttribute('aria-hidden', 'true');
  favoriteIcon.textContent = '☆';
  favoriteBtn.appendChild(favoriteIcon);
  favoriteBtn.addEventListener('click', () => toggleCurrentFavorite(root));

  // Content filter used by sequential and shuffled playback.
  const presentationWrap = document.createElement('label');
  presentationWrap.className = 'stplus-gallery-presentation-wrap';
  presentationWrap.title = 'Presentation mode';
  const presentationLabel = document.createElement('span');
  presentationLabel.textContent = 'Mode';
  const presentation = document.createElement('select');
  presentation.className = 'stplus-gallery-presentation-mode';
  presentation.setAttribute('aria-label', 'Presentation mode');
  [
    ['all', 'All media'],
    ['favorites', 'Favorites only'],
    ['images', 'Images only'],
    ['videos', 'Videos only'],
  ].forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    presentation.appendChild(option);
  });
  presentation.value = normalizePresentationMode(stplusGallerySettings().presentationMode);
  presentation.addEventListener('change', () => {
    const mode = normalizePresentationMode(presentation.value);
    stplusGallerySaveSettings({ presentationMode: mode });
    root.dataset.stplusGalleryPresentationMode = mode;
    applyPresentationMode(root, true);
    queueResumeCheckpoint(root);
  });
  presentationWrap.appendChild(presentationLabel);
  presentationWrap.appendChild(presentation);

  // 🔊 globally mute/unmute slideshow videos
  const muteBtn = document.createElement('button');
  muteBtn.className = 'stplus-gallery-btn stplus-gallery-mute';
  muteBtn.setAttribute('aria-pressed', String(!!stplusGallerySettings().videoMuted));
  const muteIcon = document.createElement('span');
  muteIcon.setAttribute('aria-hidden', 'true');
  muteBtn.appendChild(muteIcon);

  function refreshMuteButton() {
    const muted = !!stplusGallerySettings().videoMuted;
    muteIcon.textContent = muted ? '🔇' : '🔊';
    muteBtn.classList.toggle('active', muted);
    muteBtn.setAttribute('aria-pressed', String(muted));
    muteBtn.title = muted ? 'Unmute all slideshow videos' : 'Mute all slideshow videos';
    muteBtn.setAttribute('aria-label', muteBtn.title);
  }
  muteBtn.addEventListener('click', () => {
    const muted = !stplusGallerySettings().videoMuted;
    stplusGallerySaveSettings({ videoMuted: muted });
    document.querySelectorAll('.galleryImageDraggable video').forEach((video) => {
      video.muted = muted;
    });
    refreshMuteButton();
  });
  refreshMuteButton();

  // Show/hide the browser's native video playback controls.
  const videoControlsBtn = document.createElement('button');
  videoControlsBtn.className = 'stplus-gallery-btn stplus-gallery-video-controls';
  const videoControlsIcon = document.createElement('span');
  videoControlsIcon.setAttribute('aria-hidden', 'true');
  videoControlsBtn.appendChild(videoControlsIcon);

  function refreshVideoControlsButton() {
    const visible = stplusGallerySettings().videoControlsVisible !== false;
    videoControlsIcon.textContent = visible ? '🎛️' : '🚫';
    videoControlsBtn.classList.toggle('active', visible);
    videoControlsBtn.setAttribute('aria-pressed', String(visible));
    videoControlsBtn.title = visible ? 'Hide browser video controls' : 'Show browser video controls';
    videoControlsBtn.setAttribute('aria-label', videoControlsBtn.title);
  }
  videoControlsBtn.addEventListener('click', () => {
    const visible = stplusGallerySettings().videoControlsVisible === false;
    stplusGallerySaveSettings({ videoControlsVisible: visible });
    document.querySelectorAll('.galleryImageDraggable video').forEach((video) => {
      video.controls = visible;
    });
    refreshVideoControlsButton();
  });
  refreshVideoControlsButton();

  // Hide slideshow controls after a short period of pointer inactivity.
  const autoHideBtn = document.createElement('button');
  autoHideBtn.className = 'stplus-gallery-btn stplus-gallery-auto-hide';
  autoHideBtn.setAttribute('aria-pressed', String(!!stplusGallerySettings().autoHideControls));
  const autoHideIcon = document.createElement('span');
  autoHideIcon.setAttribute('aria-hidden', 'true');
  autoHideBtn.appendChild(autoHideIcon);

  function refreshAutoHideButton() {
    const enabled = root.dataset.stplusGalleryAutoHideControls === '1';
    autoHideIcon.textContent = enabled ? '🫥' : '👁️';
    autoHideBtn.classList.toggle('active', enabled);
    autoHideBtn.setAttribute('aria-pressed', String(enabled));
    autoHideBtn.title = enabled ? 'Disable auto-hide slideshow controls' : 'Enable auto-hide slideshow controls';
    autoHideBtn.setAttribute('aria-label', autoHideBtn.title);
  }
  autoHideBtn.addEventListener('click', () => {
    const enabled = root.dataset.stplusGalleryAutoHideControls !== '1';
    stplusGallerySaveSettings({ autoHideControls: enabled });
    setAutoHideControls(root, enabled);
    refreshAutoHideButton();
  });
  setAutoHideControls(root, !!stplusGallerySettings().autoHideControls);
  refreshAutoHideButton();

  // minimum total video play time; advancement always waits for a loop boundary
  const videoLoopWrap = document.createElement('label');
  videoLoopWrap.className = 'stplus-gallery-video-loop-wrap';
  videoLoopWrap.title = 'Minimum video play time; short videos repeat to the next completed loop';
  const videoLoopLabel = document.createElement('span');
  videoLoopLabel.textContent = 'Video';
  const videoLoop = document.createElement('input');
  videoLoop.type = 'number';
  videoLoop.min = '0';
  videoLoop.max = '3600';
  videoLoop.step = '1';
  videoLoop.className = 'stplus-gallery-video-loop';
  videoLoop.value = String(stplusGallerySettings().videoLoopTimeSec ?? 10);
  videoLoop.setAttribute('aria-label', 'Minimum video play time in seconds');
  const videoLoopUnit = document.createElement('span');
  videoLoopUnit.textContent = 's';
  videoLoop.addEventListener('input', () => {
    const value = Number(videoLoop.value);
    if (Number.isFinite(value) && value >= 0 && value <= 3600) {
      stplusGallerySaveSettings({ videoLoopTimeSec: value });
    }
  });
  videoLoop.addEventListener('change', () => {
    let value = Number(videoLoop.value);
    if (!Number.isFinite(value) || value < 0) value = 0;
    if (value > 3600) value = 3600;
    videoLoop.value = String(value);
    stplusGallerySaveSettings({ videoLoopTimeSec: value });
  });
  videoLoopWrap.appendChild(videoLoopLabel);
  videoLoopWrap.appendChild(videoLoop);
  videoLoopWrap.appendChild(videoLoopUnit);

  // ⛶ fullscreen
  const fsBtn = document.createElement('button');
  fsBtn.className = 'stplus-gallery-btn stplus-gallery-fs';
  const fsTip = 'Fullscreen slideshow';
  fsBtn.title = fsTip;
  fsBtn.setAttribute('aria-label', fsTip);
  const fsIcon = document.createElement('span');
  fsIcon.setAttribute('aria-hidden', 'true');
  fsIcon.textContent = '⛶';
  fsBtn.appendChild(fsIcon);
  fsBtn.addEventListener('click', () => toggleFullscreen(root));

  // image slideshow delay
  const speedWrap = document.createElement('label');
  speedWrap.className = 'stplus-gallery-speed-wrap';
  speedWrap.title = 'Image slideshow delay in seconds';
  const speedLabel = document.createElement('span');
  speedLabel.textContent = 'Image';
  const speed = document.createElement('input');
  speed.type = 'number';
  speed.min = '0.1';
  speed.max = '3600';
  speed.step = '0.1';
  speed.className = 'stplus-gallery-speed';
  speed.value = String(stplusGallerySettings().slideshowSpeedSec ?? 3);
  speed.setAttribute('aria-label', 'Image slideshow delay in seconds');
  const speedUnit = document.createElement('span');
  speedUnit.textContent = 's';
  speed.addEventListener('input', () => {
    const value = Number(speed.value);
    if (Number.isFinite(value) && value >= 0.1 && value <= 3600) {
      stplusGallerySaveSettings({ slideshowSpeedSec: value });
    }
  });
  speed.addEventListener('change', () => {
    let v = parseFloat(speed.value);
    if (!Number.isFinite(v) || v < 0.1) v = 0.1;
    if (v > 3600) v = 3600;
    speed.value = String(v);
    stplusGallerySaveSettings({ slideshowSpeedSec: v });
    if (root.dataset.stplusGalleryPlaying === '1' && !(currentMedia(root) instanceof HTMLVideoElement)) {
      scheduleCurrentMedia(root, false);
    }
  });
  speedWrap.appendChild(speedLabel);
  speedWrap.appendChild(speed);
  speedWrap.appendChild(speedUnit);

  // Current slide and direct position control.
  const progressWrap = document.createElement('label');
  progressWrap.className = 'stplus-gallery-progress-wrap';
  progressWrap.title = 'Slideshow position';
  const progress = document.createElement('input');
  progress.type = 'range';
  progress.min = '1';
  progress.max = '1';
  progress.step = '1';
  progress.value = '1';
  progress.className = 'stplus-gallery-progress';
  progress.setAttribute('aria-label', 'Slideshow position');
  const progressValue = document.createElement('output');
  progressValue.className = 'stplus-gallery-progress-value';
  progressValue.setAttribute('aria-live', 'polite');
  progress.addEventListener('input', () => {
    showGalleryIndex(root, Number(progress.value) - 1);
  });
  progressWrap.appendChild(progress);
  progressWrap.appendChild(progressValue);

  // transition select
  const sel = document.createElement('select');
  sel.className = 'stplus-gallery-transition';
  sel.title = 'Transition style';
  const savedTransition = stplusGallerySettings().slideshowTransition;
  const initialTransition = savedTransition === 'cut' ? 'cut' : 'fade';
  if (savedTransition !== initialTransition) {
    stplusGallerySaveSettings({ slideshowTransition: initialTransition });
  }
  [
    ['cut', 'Cut'],
    ['fade', 'Fade'],
  ].forEach(([v, lbl]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = lbl;
    if (initialTransition === v) o.selected = true;
    sel.appendChild(o);
  });
  root.dataset.stplusGalleryTransition = initialTransition;
  sel.addEventListener('change', () => {
    const v = sel.value;
    root.dataset.stplusGalleryTransition = v;
    stplusGallerySaveSettings({ slideshowTransition: v });
  });

  left.appendChild(saveBtn);
  left.appendChild(zoomBtn);
  left.appendChild(zoomLockBtn);
  left.appendChild(prevBtn);
  left.appendChild(playBtn);
  left.appendChild(nextBtn);
  left.appendChild(randomBtn);
  left.appendChild(favoriteBtn);
  left.appendChild(muteBtn);
  left.appendChild(videoControlsBtn);
  left.appendChild(autoHideBtn);
  left.appendChild(fsBtn);
  left.appendChild(speedWrap);
  left.appendChild(videoLoopWrap);
  left.appendChild(presentationWrap);
  left.appendChild(sel);
  progressRow.appendChild(progressWrap);
  updateSlideshowButton(root);
  updateProgressControl(root);
  updateFavoriteButton(root);
}
function saveDefaultRect(root) {
  const st = root.style;
  const rect = {
    top: st.top || (root.offsetTop + 'px'),
    left: st.left || (root.offsetLeft + 'px'),
    width: st.width || (root.clientWidth + 'px'),
    height: st.height || (root.clientHeight + 'px'),
  };
  stplusGallerySaveSettings({ viewerRect: rect });
  root.classList.add('stplus-gallery-saved-pulse');
  setTimeout(() => root.classList.remove('stplus-gallery-saved-pulse'), 350);
}

function applyDefaultRect(root) {
  const r = stplusGallerySettings().viewerRect;
  if (!r) return;
  const st = root.style;
  st.top = r.top; st.left = r.left; st.width = r.width; st.height = r.height;
}

function resumeSourceKey(source) {
  try {
    return new URL(String(source), location.href).href;
  } catch {
    return String(source || '');
  }
}

function nextAvailableResumeSource(session, available) {
  const savedOrder = Array.isArray(session?.order) ? session.order : [];
  if (!savedOrder.length) return '';
  const currentKey = resumeSourceKey(session.currentSource);
  const savedIndex = savedOrder.findIndex(source => resumeSourceKey(source) === currentKey);
  for (let offset = 0; offset < savedOrder.length; offset += 1) {
    const index = (Math.max(0, savedIndex) + offset) % savedOrder.length;
    const match = available.get(resumeSourceKey(savedOrder[index]));
    if (match) return match;
  }
  return '';
}

function reconcileResumeOrder(root, session) {
  const canonical = filterPresentationList(root, root._stplusGallerySourceGalleryList || []);
  root._stplusGalleryCanonicalGalleryList = [...canonical];
  const available = new Map(canonical.map(source => [resumeSourceKey(source), source]));
  const savedOrder = Array.isArray(session.order) ? session.order : [];
  const seen = new Set();
  const surviving = [];
  savedOrder.forEach((source) => {
    const key = resumeSourceKey(source);
    const current = available.get(key);
    if (current && !seen.has(key)) {
      seen.add(key);
      surviving.push(current);
    }
  });
  const added = canonical.filter(source => !seen.has(resumeSourceKey(source)));
  let target = available.get(resumeSourceKey(session.currentSource))
    || (session.randomized
      ? nextAvailableResumeSource(session, available)
      : canonical[Math.min(canonical.length - 1, Math.max(0, Number(session.position) - 1))])
    || canonical[0]
    || '';

  if (session.randomized && canonical.length > 1) {
    const order = [...surviving];
    if (target && !order.some(source => resumeSourceKey(source) === resumeSourceKey(target))) {
      order.unshift(target);
    }
    let targetIndex = order.findIndex(source => resumeSourceKey(source) === resumeSourceKey(target));
    if (targetIndex < 0) targetIndex = 0;
    shuffleInPlace(added);
    added.forEach((source) => {
      const firstUnplayed = Math.min(order.length, targetIndex + 1);
      const insertAt = firstUnplayed + Math.floor(Math.random() * (order.length - firstUnplayed + 1));
      order.splice(insertAt, 0, source);
    });
    root._stplusGalleryGalleryList = order;
    root.dataset.stplusGalleryRandomized = '1';
  } else {
    root._stplusGalleryGalleryList = [...canonical];
    root.dataset.stplusGalleryRandomized = '0';
    target = available.get(resumeSourceKey(target)) || canonical[0] || '';
  }
  return target;
}

function restorePendingResumeSession(root) {
  const request = stplusGalleryConsumeResumeRequest(root._stplusGalleryGalleryFolder);
  if (!request) return null;
  const session = stplusGalleryGetResumeSession(root._stplusGalleryGalleryFolder);
  if (!session) return null;

  const mode = normalizePresentationMode(session.presentationMode);
  root.dataset.stplusGalleryPresentationMode = mode;
  const presentation = root.querySelector('.stplus-gallery-presentation-mode');
  if (presentation instanceof HTMLSelectElement) presentation.value = mode;
  const target = reconcileResumeOrder(root, session);
  const randomButton = root.querySelector('.stplus-gallery-random');
  if (randomButton instanceof HTMLButtonElement) {
    const randomized = root.dataset.stplusGalleryRandomized === '1';
    randomButton.classList.toggle('active', randomized);
    randomButton.setAttribute('aria-pressed', String(randomized));
  }

  const rect = session.rect;
  if (rect && typeof rect === 'object') {
    ['top', 'left', 'width', 'height'].forEach((property) => {
      if (typeof rect[property] === 'string') root.style[property] = rect[property];
    });
  }
  root.dataset.stplusGalleryPlaying = request.autoPlay ? '1' : '0';
  updateSlideshowButton(root);
  updateProgressControl(root);
  if (!target) return null;

  const media = currentMedia(root);
  if (!media) return null;
  if (resumeSourceKey(media.src) === resumeSourceKey(target)) {
    root._stplusGalleryActiveMedia = media;
    root._stplusGalleryDisplayedMedia = media;
    scheduleCurrentMedia(root, true);
    return media;
  }
  const nextMedia = transitionTo(root, media, target);
  root._stplusGalleryActiveMedia = nextMedia;
  scheduleCurrentMedia(root, true);
  return nextMedia;
}

function resumeWindowRect(root) {
  const previous = stplusGalleryGetResumeSession(root._stplusGalleryGalleryFolder)?.rect;
  if (document.fullscreenElement === root || root.classList.contains('stplus-gallery-fullscreen')) return previous || null;
  const bounds = root.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return previous || null;
  return {
    top: `${Math.round(bounds.top)}px`,
    left: `${Math.round(bounds.left)}px`,
    width: `${Math.round(bounds.width)}px`,
    height: `${Math.round(bounds.height)}px`,
  };
}

function saveResumeCheckpoint(root) {
  clearTimeout(root._stplusGalleryResumeSaveTimer);
  root._stplusGalleryResumeSaveTimer = null;
  if (root.dataset.stplusGalleryResuming === '1') return;
  const media = currentMedia(root);
  const list = [...currentGalleryList(root)];
  if (!media?.src || !list.length) return;
  const index = indexInList(list, media.src);
  const randomized = root.dataset.stplusGalleryRandomized === '1';
  stplusGallerySaveResumeSession(root._stplusGalleryGalleryFolder, {
    currentSource: media.src,
    order: randomized ? list : [],
    randomized,
    presentationMode: normalizePresentationMode(root.dataset.stplusGalleryPresentationMode),
    playing: root.dataset.stplusGalleryPlaying === '1',
    position: index >= 0 ? index + 1 : 1,
    count: list.length,
    rect: resumeWindowRect(root),
    savedAt: Date.now(),
  });
}

function queueResumeCheckpoint(root, immediate = false) {
  clearTimeout(root._stplusGalleryResumeSaveTimer);
  if (immediate) {
    saveResumeCheckpoint(root);
    return;
  }
  root._stplusGalleryResumeSaveTimer = setTimeout(() => saveResumeCheckpoint(root), 350);
}

function wireResumeCheckpointing(root) {
  if (root.dataset.stplusGalleryResumeCheckpointWired === '1') return;
  root.dataset.stplusGalleryResumeCheckpointWired = '1';
  root.addEventListener('pointerup', () => queueResumeCheckpoint(root));
  const beforeUnload = () => saveResumeCheckpoint(root);
  root.querySelector('.dragClose')?.addEventListener('click', () => {
    queueResumeCheckpoint(root, true);
    window.removeEventListener('beforeunload', beforeUnload);
  }, true);
  window.addEventListener('beforeunload', beforeUnload);
}

function wireZoomAndPan(root) {
  let scale = 1;
  let tx = 0, ty = 0;

  let isPanning = false;
  let panStartX = 0, panStartY = 0;
  let panBaseX = 0, panBaseY = 0;
  const observedWraps = new WeakSet();
  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => applyTransform())
    : null;

  function observeZoomLayer(wrap) {
    if (!(wrap instanceof HTMLElement) || observedWraps.has(wrap)) return;
    observedWraps.add(wrap);
    resizeObserver?.observe(wrap);
  }

  function ensureZoomLayer() {
    const media = currentMedia(root);
    if (!(media instanceof HTMLImageElement)) return;
    if (media.parentElement?.classList.contains('stplus-gallery-layer-wrap')) {
      observeZoomLayer(media.parentElement);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'stplus-gallery-layer-wrap';
    media.replaceWith(wrap);
    wrap.appendChild(media);
    media.classList.add('stplus-gallery-layer', 'base');
    media.draggable = false;
    media.setAttribute('draggable', 'false');
    media.style.webkitUserDrag = 'none';
    observeZoomLayer(wrap);
  }

  function getZoomViewport(img) {
    const wrap = img.parentElement;
    return wrap?.classList.contains('stplus-gallery-layer-wrap')
      ? wrap.getBoundingClientRect()
      : img.getBoundingClientRect();
  }

  function getImage() {
    const media = currentMedia(root);
    return media instanceof HTMLImageElement ? media : null;
  }

  function applyTransform() {
    const img = getImage();
    if (!img) return;
    const wrap = img.parentElement;
    if (wrap?.classList.contains('stplus-gallery-layer-wrap')) {
      observeZoomLayer(wrap);
      const viewport = wrap.getBoundingClientRect();
      const naturalWidth = img.naturalWidth;
      const naturalHeight = img.naturalHeight;
      if (!viewport.width || !viewport.height || !naturalWidth || !naturalHeight) {
        img.addEventListener('load', applyTransform, { once: true });
        return;
      }

      // Size from the source's intrinsic pixels. Resizing the CSS box forces a
      // fresh image raster at each zoom level; scaling a transformed viewport-
      // sized layer can leave Chrome showing its stale low-resolution texture.
      const fit = Math.min(viewport.width / naturalWidth, viewport.height / naturalHeight);
      const width = naturalWidth * fit * scale;
      const height = naturalHeight * fit * scale;
      img.style.width = `${width}px`;
      img.style.height = `${height}px`;
      img.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px))`;
      img.style.transformOrigin = 'center center';
      img.style.willChange = 'auto';
      return;
    }
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.style.transformOrigin = 'center center';
    img.style.willChange = 'auto';
  }

  function onWheel(e) {
    if (stplusGallerySettings().hoverZoom) return;
    const img = getImage();
    if (!img) return;
    if (!e.ctrlKey) {
      e.preventDefault();
      const delta = -Math.sign(e.deltaY) * 0.1;
      const newScale = Math.min(8, Math.max(0.1, scale + delta));
      if (newScale !== scale) {
        const rect = getZoomViewport(img);
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const dx = (cx - rect.width / 2) / scale;
        const dy = (cy - rect.height / 2) / scale;
        tx -= dx * (newScale - scale);
        ty -= dy * (newScale - scale);
        scale = newScale;
        applyTransform();
      }
    }
  }

  function onMoveHover(e) {
    if (!stplusGallerySettings().hoverZoom) return;
    const img = getImage();
    if (!img) return;
    const rect = getZoomViewport(img);
    const nx = ((e.clientX - rect.left) / rect.width - 0.5) * -1;
    const ny = ((e.clientY - rect.top) / rect.height - 0.5) * -1;
    const z = stplusGallerySettings().hoverZoomScale || 1.08;
    scale = z;
    tx = nx * rect.width * 0.05;
    ty = ny * rect.height * 0.05;
    applyTransform();
  }
  function onLeaveHover() {
    if (!stplusGallerySettings().hoverZoom) return;
    scale = 1; tx = 0; ty = 0;
    applyTransform();
  }

  function onMouseDown(e) {
    if (stplusGallerySettings().hoverZoom) return;
    if (e.button !== 0) return;
    if (scale <= 1.001) return;
    const img = getImage();
    if (!img || e.target !== img) return;
    isPanning = true;
    root.classList.add('stplus-gallery-panning');
    panStartX = e.clientX;
    panStartY = e.clientY;
    panBaseX = tx;
    panBaseY = ty;
    e.preventDefault();
    window.addEventListener('mousemove', onMouseMovePan);
    window.addEventListener('mouseup', onMouseUpPan, { once: true });
  }
  function onMouseMovePan(e) {
    if (!isPanning) return;
    const dx = e.clientX - panStartX;
    const dy = e.clientY - panStartY;
    tx = panBaseX + dx;
    ty = panBaseY + dy;
    applyTransform();
  }
  function onMouseUpPan() {
    isPanning = false;
    root.classList.remove('stplus-gallery-panning');
    window.removeEventListener('mousemove', onMouseMovePan);
  }

  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('mousemove', onMoveHover);
  root.addEventListener('mouseleave', onLeaveHover);
  root.addEventListener('mousedown', onMouseDown);
  root.addEventListener(MEDIA_DISPLAYED_EVENT, (event) => {
    if (!(event.target instanceof HTMLImageElement)) {
      if (!stplusGallerySettings().zoomLock) {
        scale = 1; tx = 0; ty = 0;
      }
      return;
    }
    event.target.draggable = false;
    event.target.setAttribute('draggable', 'false');
    event.target.style.webkitUserDrag = 'none';
    if (!stplusGallerySettings().zoomLock) {
      scale = 1; tx = 0; ty = 0;
    }
    applyTransform();
  });

  root.addEventListener('dragstart', (event) => {
    if (event.target instanceof HTMLImageElement && root.contains(event.target)) {
      event.preventDefault();
    }
  }, true);

  ensureZoomLayer();
  observeZoomLayer(root);
  applyTransform();
  // Let the floating window complete its first flex layout before choosing the
  // image's fitted dimensions. This avoids measuring the thumbnail-sized box
  // used briefly while the viewer is being inserted.
  requestAnimationFrame(() => requestAnimationFrame(applyTransform));
}

function wireKeyboardNav(root) {
  function handler(e) {
    if (!document.body.contains(root)) {
      window.removeEventListener('keydown', handler, true);
      return;
    }
    if (e.key === 'Escape') {
      root.querySelector('.dragClose')?.click();
      return;
    }
    if (!e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;

    let handled = true;
    if (e.code === 'ArrowRight' || e.key === 'ArrowRight') goNext(root);
    else if (e.code === 'ArrowLeft' || e.key === 'ArrowLeft') goPrev(root);
    else if (e.code === 'Space' || e.key === ' ') {
      root.dataset.stplusGalleryPlaying === '1' ? stopSlideshow(root) : startSlideshow(root);
    } else handled = false;

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
  // Capture before SillyTavern and browser-history handlers can consume Ctrl+Arrow.
  window.addEventListener('keydown', handler, true);
}

function wireWindowDrag(root) {
  if (root.dataset.stplusGalleryDirectSlideshow !== '1') return;
  const handle = root.querySelector('.drag-grabber');
  if (!(handle instanceof HTMLElement) || handle.dataset.stplusGalleryDragWired === '1') return;
  handle.dataset.stplusGalleryDragWired = '1';

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  const stop = (event) => {
    if (pointerId === null || (event && event.pointerId !== pointerId)) return;
    pointerId = null;
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', stop, true);
    document.removeEventListener('pointercancel', stop, true);
    root.classList.remove('stplus-gallery-window-dragging');
  };

  const move = (event) => {
    if (pointerId === null || event.pointerId !== pointerId) return;
    event.preventDefault();
    const nextLeft = Math.max(0, Math.min(
      window.innerWidth - Math.min(root.offsetWidth, window.innerWidth),
      startLeft + event.clientX - startX,
    ));
    const nextTop = Math.max(0, Math.min(
      window.innerHeight - Math.min(root.offsetHeight, window.innerHeight),
      startTop + event.clientY - startY,
    ));
    root.style.left = `${Math.round(nextLeft)}px`;
    root.style.top = `${Math.round(nextTop)}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointerId !== null) return;
    const bounds = root.getBoundingClientRect();
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startLeft = bounds.left;
    startTop = bounds.top;
    root.style.position = 'fixed';
    root.style.left = `${Math.round(startLeft)}px`;
    root.style.top = `${Math.round(startTop)}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.classList.add('stplus-gallery-window-dragging');
    event.preventDefault();
    document.addEventListener('pointermove', move, { capture: true, passive: false });
    document.addEventListener('pointerup', stop, true);
    document.addEventListener('pointercancel', stop, true);
  });
}

function toggleFullscreen(root) {
  const isFS = document.fullscreenElement === root;
  if (isFS) {
    document.exitFullscreen?.();
  } else {
    root.requestFullscreen?.({ navigationUI: 'hide' }).catch(()=>{});
  }
}

function wireFullscreenStateSync(root) {
  function onFSChange() {
    const isFS = document.fullscreenElement === root;
    root.classList.toggle('stplus-gallery-fullscreen', isFS);
  }
  document.addEventListener('fullscreenchange', onFSChange);
  const obs = new MutationObserver(() => {
    if (!document.body.contains(root)) {
      document.removeEventListener('fullscreenchange', onFSChange);
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

function startSlideshow(root) {
  root.dataset.stplusGalleryPlaying = '1';
  updateSlideshowButton(root);
  scheduleCurrentMedia(root, false);
  scheduleAutoHideControls(root);
  queueResumeCheckpoint(root);
}
function stopSlideshow(root) {
  root.dataset.stplusGalleryPlaying = '0';
  updateSlideshowButton(root);
  clearSlideshowTimer(root);
  revealSlideshowControls(root);
  const media = currentMedia(root);
  if (media instanceof HTMLVideoElement) media.pause();
  queueResumeCheckpoint(root);
}

function setAutoHideControls(root, enabled) {
  root.dataset.stplusGalleryAutoHideControls = enabled ? '1' : '0';
  if (root.dataset.stplusGalleryAutoHideWired !== '1') {
    root.dataset.stplusGalleryAutoHideWired = '1';
    const reveal = () => {
      revealSlideshowControls(root);
      scheduleAutoHideControls(root);
    };
    root.addEventListener('pointermove', reveal, { passive: true });
    root.addEventListener('pointerdown', reveal, { passive: true });
    root.addEventListener('focusin', reveal);
  }
  revealSlideshowControls(root);
  scheduleAutoHideControls(root);
}

function revealSlideshowControls(root) {
  clearTimeout(root._stplusGalleryAutoHideTimer);
  root._stplusGalleryAutoHideTimer = null;
  root.classList.remove('stplus-gallery-controls-hidden');
}

function scheduleAutoHideControls(root) {
  clearTimeout(root._stplusGalleryAutoHideTimer);
  root._stplusGalleryAutoHideTimer = null;
  if (root.dataset.stplusGalleryAutoHideControls !== '1' || root.dataset.stplusGalleryPlaying !== '1') return;
  root._stplusGalleryAutoHideTimer = setTimeout(() => {
    if (root.dataset.stplusGalleryAutoHideControls === '1' && root.dataset.stplusGalleryPlaying === '1') {
      root.classList.add('stplus-gallery-controls-hidden');
    }
  }, 2200);
}

function updateSlideshowButton(root) {
  const button = root.querySelector('.stplus-gallery-play');
  if (!(button instanceof HTMLButtonElement)) return;
  const playing = root.dataset.stplusGalleryPlaying === '1';
  const label = playing ? 'Pause slideshow (Ctrl+Space)' : 'Play slideshow (Ctrl+Space)';
  button.classList.toggle('active', playing);
  button.setAttribute('aria-pressed', String(playing));
  button.title = label;
  button.setAttribute('aria-label', label);
  const icon = button.querySelector('[aria-hidden="true"]');
  if (icon) icon.textContent = playing ? '⏸️' : '▶️';
}

function clearSlideshowTimer(root) {
  if (!root._stplusGalleryTimer) return;
  clearTimeout(root._stplusGalleryTimer);
  root._stplusGalleryTimer = null;
}

function detachVideoTracking(root) {
  const tracked = root._stplusGalleryTrackedVideo;
  if (!(tracked instanceof HTMLVideoElement)) return;
  if (root._stplusGalleryVideoEndedHandler) tracked.removeEventListener('ended', root._stplusGalleryVideoEndedHandler);
  root._stplusGalleryTrackedVideo = null;
  root._stplusGalleryVideoEndedHandler = null;
}

function configureVideo(root, video, resetProgress) {
  clearSlideshowTimer(root);
  video.controls = stplusGallerySettings().videoControlsVisible !== false;
  video.playsInline = true;
  video.preload = 'auto';
  video.loop = false;
  video.muted = !!stplusGallerySettings().videoMuted;

  if (root._stplusGalleryTrackedVideo !== video) {
    detachVideoTracking(root);
    root._stplusGalleryTrackedVideo = video;
    root._stplusGalleryVideoCompletedSec = 0;
    root._stplusGalleryVideoEndedHandler = () => {
      if (root.dataset.stplusGalleryPlaying !== '1' || currentMedia(root) !== video) return;
      const duration = Number(video.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        goNext(root);
        return;
      }

      root._stplusGalleryVideoCompletedSec = (Number(root._stplusGalleryVideoCompletedSec) || 0) + duration;
      const minimum = Math.max(0, Number(stplusGallerySettings().videoLoopTimeSec) || 0);
      if (root._stplusGalleryVideoCompletedSec + 0.01 >= minimum) {
        goNext(root);
        return;
      }

      video.currentTime = 0;
      video.play().catch(() => {});
    };
    video.addEventListener('ended', root._stplusGalleryVideoEndedHandler);
  } else if (resetProgress) {
    root._stplusGalleryVideoCompletedSec = 0;
  }

  if (root.dataset.stplusGalleryPlaying === '1') video.play().catch(() => {});
}

function scheduleCurrentMedia(root, resetVideoProgress = true) {
  clearSlideshowTimer(root);
  const media = currentMedia(root);
  if (!media) return;
  root._stplusGalleryActiveMedia = media;
  updateProgressControl(root);
  updateFavoriteButton(root);
  wireMediaFailureHandling(root, media);

  if (media.dataset.stplusGalleryTransitionPending === '1') {
    if (root._stplusGalleryPendingScheduleMedia !== media) {
      root._stplusGalleryPendingScheduleMedia = media;
      media.addEventListener(MEDIA_DISPLAYED_EVENT, () => {
        if (root._stplusGalleryPendingScheduleMedia === media) root._stplusGalleryPendingScheduleMedia = null;
        if (currentMedia(root) === media) scheduleCurrentMedia(root, resetVideoProgress);
      }, { once: true });
    }
    return;
  }
  if (root._stplusGalleryPendingScheduleMedia === media) root._stplusGalleryPendingScheduleMedia = null;
  queueResumeCheckpoint(root);

  if (media instanceof HTMLVideoElement) {
    configureVideo(root, media, resetVideoProgress);
    return;
  }

  detachVideoTracking(root);
  if (root.dataset.stplusGalleryPlaying !== '1') return;
  const seconds = Math.max(0.1, Number(stplusGallerySettings().slideshowSpeedSec) || 3);
  root._stplusGalleryTimer = setTimeout(() => {
    root._stplusGalleryTimer = null;
    if (root.dataset.stplusGalleryPlaying === '1') goNext(root);
  }, seconds * 1000);
}

function wireMediaFailureHandling(root, media) {
  if (media._stplusGalleryFailureHandlingWired) return;
  media._stplusGalleryFailureHandlingWired = true;
  let handled = false;
  let loadConfirmed = false;
  let metadataTimer = null;
  const failed = () => {
    if (handled) return;
    handled = true;
    clearTimeout(metadataTimer);
    if (!media.isConnected || currentMedia(root) !== media) return;
    const failedUrl = media.currentSrc || media.src;
    root._stplusGalleryGalleryList = currentGalleryList(root).filter(item => {
      try {
        return new URL(item, location.href).href !== new URL(failedUrl, location.href).href;
      } catch {
        return item !== failedUrl;
      }
    });
    omitFailedExternalMedia(root._stplusGalleryGalleryFolder, failedUrl);
    if (!root._stplusGalleryGalleryList.length) {
      stopSlideshow(root);
      return;
    }
    const nextMedia = transitionTo(root, media, root._stplusGalleryGalleryList[0]);
    root._stplusGalleryActiveMedia = nextMedia;
    scheduleCurrentMedia(root, true);
  };
  media.addEventListener('error', failed, { once: true });

  if (media instanceof HTMLVideoElement) {
    const validateDuration = () => {
      clearTimeout(metadataTimer);
      if (!Number.isFinite(media.duration) || media.duration <= 0) failed();
      else loadConfirmed = true;
    };
    media.addEventListener('loadedmetadata', validateDuration, { once: true });
    if (media.readyState >= 1) validateDuration();
  } else if (media.complete) {
    if (media.naturalWidth > 0) loadConfirmed = true;
    else failed();
  } else {
    media.addEventListener('load', () => {
      loadConfirmed = true;
      clearTimeout(metadataTimer);
    }, { once: true });
  }
  if (!handled && !loadConfirmed) metadataTimer = setTimeout(failed, MEDIA_LOAD_TIMEOUT_MS);
}

function goNext(root) {
  const media = currentMedia(root);
  let list = currentGalleryList(root);
  if (!media || !list.length) return;
  let i = indexInList(list, media.src);
  if (root.dataset.stplusGalleryRandomized === '1' && (i < 0 || i === list.length - 1)) {
    list = beginNextShuffleCycle(root, media.src);
    i = indexInList(list, media.src);
  }
  const nextIdx = i >= 0 ? (i + 1) % list.length : 0;
  showGalleryIndex(root, nextIdx);
}
function goPrev(root) {
  const list = currentGalleryList(root);
  const media = currentMedia(root);
  if (!media || !list.length) return;
  const i = indexInList(list, media.src);
  const prevIdx = i >= 0 ? (i - 1 + list.length) % list.length : list.length - 1;
  showGalleryIndex(root, prevIdx, -1);
}

function showGalleryIndex(root, requestedIndex, preloadDirection = 1) {
  const list = currentGalleryList(root);
  const media = currentMedia(root);
  if (!media || !list.length) return;
  const index = Math.max(0, Math.min(list.length - 1, Math.trunc(requestedIndex)));
  if (indexInList(list, media.src) === index) {
    updateProgressControl(root);
    return;
  }
  const nextMedia = transitionTo(root, media, list[index]);
  root._stplusGalleryActiveMedia = nextMedia;
  scheduleCurrentMedia(root, true);
  const preloadIndex = (index + preloadDirection + list.length) % list.length;
  preload(list[preloadIndex]);
}

function updateProgressControl(root) {
  const progress = root.querySelector('.stplus-gallery-progress');
  const output = root.querySelector('.stplus-gallery-progress-value');
  if (!(progress instanceof HTMLInputElement) || !(output instanceof HTMLOutputElement)) return;
  const list = currentGalleryList(root);
  const media = currentMedia(root);
  const index = media ? indexInList(list, media.src) : -1;
  const position = index >= 0 ? index + 1 : (list.length ? 1 : 0);
  progress.max = String(Math.max(1, list.length));
  progress.value = String(Math.max(1, position));
  progress.disabled = list.length < 2;
  progress.setAttribute('aria-valuetext', `${position} of ${list.length}`);
  output.textContent = `${position} / ${list.length}`;
}

function currentMedia(root) {
  if (root._stplusGalleryActiveMedia instanceof Element && root._stplusGalleryActiveMedia.isConnected) {
    return root._stplusGalleryActiveMedia;
  }
  return root.querySelector('.stplus-gallery-layer.base, :scope > video, :scope > img, .stplus-gallery-layer.next');
}

function normalizePresentationMode(value) {
  return ['all', 'favorites', 'images', 'videos'].includes(value) ? value : 'all';
}

function favoriteGalleryKey(root) {
  return stplusGalleryFavoriteGalleryKey(root._stplusGalleryGalleryFolder);
}

function getFavoriteSet(root) {
  return stplusGalleryGetFavoriteSet(root._stplusGalleryGalleryFolder);
}

function isFavoriteSource(root, source) {
  return getFavoriteSet(root).has(stplusGalleryFavoriteIdentity(source));
}

function updateFavoriteButton(root) {
  const button = root.querySelector('.stplus-gallery-favorite');
  if (!(button instanceof HTMLButtonElement)) return;
  const media = currentMedia(root);
  const favorite = !!media && isFavoriteSource(root, media.src);
  button.classList.toggle('active', favorite);
  button.setAttribute('aria-pressed', String(favorite));
  button.title = favorite ? 'Remove current item from favorites' : 'Add current item to favorites';
  button.setAttribute('aria-label', button.title);
  const icon = button.querySelector('[aria-hidden="true"]');
  if (icon) icon.textContent = favorite ? '★' : '☆';
}

function toggleCurrentFavorite(root) {
  const media = currentMedia(root);
  if (!media?.src) return;
  stplusGalleryToggleFavorite(root._stplusGalleryGalleryFolder, media.src);
}

function filterPresentationList(root, sourceList) {
  const mode = normalizePresentationMode(root.dataset.stplusGalleryPresentationMode || stplusGallerySettings().presentationMode);
  if (mode === 'images') return sourceList.filter(source => !isVideoSource(source));
  if (mode === 'videos') return sourceList.filter(isVideoSource);
  if (mode === 'favorites') {
    const favorites = getFavoriteSet(root);
    return sourceList.filter(source => favorites.has(stplusGalleryFavoriteIdentity(source)));
  }
  return [...sourceList];
}

function applyPresentationMode(root, navigateIfExcluded = false) {
  const sourceList = Array.isArray(root._stplusGallerySourceGalleryList)
    ? root._stplusGallerySourceGalleryList
    : (Array.isArray(root._stplusGalleryCanonicalGalleryList) ? root._stplusGalleryCanonicalGalleryList : currentGalleryList(root));
  const filtered = filterPresentationList(root, sourceList);
  root._stplusGalleryCanonicalGalleryList = [...filtered];

  const media = currentMedia(root);
  const currentIndex = media ? indexInList(filtered, media.src) : -1;
  if (root.dataset.stplusGalleryRandomized === '1') {
    const shuffled = [...filtered];
    const current = currentIndex >= 0 ? shuffled.splice(currentIndex, 1)[0] : null;
    shuffleInPlace(shuffled);
    root._stplusGalleryGalleryList = current ? [current, ...shuffled] : shuffled;
  } else {
    root._stplusGalleryGalleryList = [...filtered];
  }

  if (navigateIfExcluded && media && currentIndex < 0) {
    if (root._stplusGalleryGalleryList.length) {
      const nextMedia = transitionTo(root, media, root._stplusGalleryGalleryList[0]);
      root._stplusGalleryActiveMedia = nextMedia;
      scheduleCurrentMedia(root, true);
    } else {
      stopSlideshow(root);
    }
  }
  updateProgressControl(root);
  updateFavoriteButton(root);
}

function toggleRandomizedGalleryOrder(root) {
  if (root.dataset.stplusGalleryRandomized === '1') {
    root.dataset.stplusGalleryRandomized = '0';
    const canonical = Array.isArray(root._stplusGalleryCanonicalGalleryList)
      ? root._stplusGalleryCanonicalGalleryList
      : currentGalleryList(root);
    root._stplusGalleryGalleryList = [...canonical];
    updateProgressControl(root);
    return false;
  }

  const list = [...currentGalleryList(root)];
  if (list.length < 2) return false;

  if (!Array.isArray(root._stplusGalleryCanonicalGalleryList)) {
    root._stplusGalleryCanonicalGalleryList = [...list];
  }

  const media = currentMedia(root);
  const currentIndex = media ? indexInList(list, media.src) : -1;
  const current = currentIndex >= 0 ? list.splice(currentIndex, 1)[0] : null;
  shuffleInPlace(list);
  root._stplusGalleryGalleryList = current ? [current, ...list] : list;
  root.dataset.stplusGalleryRandomized = '1';
  updateProgressControl(root);
  return true;
}

function beginNextShuffleCycle(root, currentSource) {
  const canonical = Array.isArray(root._stplusGalleryCanonicalGalleryList)
    ? [...root._stplusGalleryCanonicalGalleryList]
    : [...currentGalleryList(root)];
  const currentIndex = indexInList(canonical, currentSource);
  const current = currentIndex >= 0 ? canonical.splice(currentIndex, 1)[0] : null;
  shuffleInPlace(canonical);
  root._stplusGalleryGalleryList = current ? [current, ...canonical] : canonical;
  updateProgressControl(root);
  return root._stplusGalleryGalleryList;
}

function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function initializeGalleryList(root) {
  const galleryRoot = root._stplusGalleryGalleryRoot instanceof HTMLElement
    ? root._stplusGalleryGalleryRoot
    : document.querySelector('#gallery');
  const folderInput = galleryRoot?.querySelector('.gallery-folder-input');
  root._stplusGalleryGalleryFolder = folderInput && 'value' in folderInput
    ? String(folderInput.value || '')
    : '';
  root.dataset.stplusGalleryPresentationMode = normalizePresentationMode(stplusGallerySettings().presentationMode);
  const galleryList = readGalleryDataList() ?? readVisibleGalleryList();
  root._stplusGallerySourceGalleryList = [...galleryList];
  root._stplusGalleryCanonicalGalleryList = filterPresentationList(root, galleryList);
  root._stplusGalleryGalleryList = [...root._stplusGalleryCanonicalGalleryList];
  root.dataset.stplusGalleryRandomized = '0';

  const onFavoritesChanged = (event) => {
    if (event.detail?.galleryKey !== favoriteGalleryKey(root)) return;
    if (!root.isConnected) {
      document.removeEventListener(FAVORITES_CHANGED_EVENT, onFavoritesChanged);
      return;
    }
    updateFavoriteButton(root);
    if (root.dataset.stplusGalleryPresentationMode === 'favorites') applyPresentationMode(root, true);
  };
  document.addEventListener(FAVORITES_CHANGED_EVENT, onFavoritesChanged);

  const media = currentMedia(root);
  root._stplusGalleryActiveMedia = media;
  if (media instanceof HTMLVideoElement) {
    media.muted = !!stplusGallerySettings().videoMuted;
    media.loop = false;
    media.controls = stplusGallerySettings().videoControlsVisible !== false;
  }
  try {
    root._stplusGalleryGalleryBaseUrl = root._stplusGalleryGalleryFolder
      ? new URL(`/user/images/${encodeURIComponent(root._stplusGalleryGalleryFolder)}/`, location.origin).href
      : (media?.src ? new URL('.', media.src).href : '');
  } catch {
    root._stplusGalleryGalleryBaseUrl = '';
  }

  scheduleGalleryListSync(root);
  applyPresentationMode(root, true);
  updateProgressControl(root);
  updateFavoriteButton(root);
}

function scheduleGalleryListSync(root) {
  async function sync() {
    root._stplusGalleryListTimer = null;
    if (!document.body.contains(root)) return;

    await refreshGalleryList(root);

    if (document.body.contains(root)) {
      root._stplusGalleryListTimer = setTimeout(sync, 2000);
    }
  }

  root._stplusGalleryListTimer = setTimeout(sync, 2000);
}

async function refreshGalleryList(root) {
  const updated = await fetchGalleryList(root);
  if (updated === null) return;

  root._stplusGallerySourceGalleryList = [...updated];
  const filtered = filterPresentationList(root, updated);
  root._stplusGalleryCanonicalGalleryList = [...filtered];
  const current = Array.isArray(root._stplusGalleryGalleryList) ? root._stplusGalleryGalleryList : [];
  const next = root.dataset.stplusGalleryRandomized === '1'
    ? mergeRandomizedGalleryList(root, current, filtered)
    : filtered;
  if (!sameGalleryList(current, next)) {
    root._stplusGalleryGalleryList = next;
  }
  updateProgressControl(root);
  updateFavoriteButton(root);
}

function mergeRandomizedGalleryList(root, current, updated) {
  const available = new Set(updated);
  const merged = current.filter(item => available.has(item));
  const included = new Set(merged);
  const added = shuffleInPlace(updated.filter(item => !included.has(item)));
  const media = currentMedia(root);
  const currentIndex = media ? indexInList(merged, media.src) : -1;
  const firstUnplayedIndex = Math.max(0, currentIndex + 1);

  for (const item of added) {
    const insertAt = firstUnplayedIndex
      + Math.floor(Math.random() * (merged.length - firstUnplayedIndex + 1));
    merged.splice(insertAt, 0, item);
  }
  return merged;
}

async function fetchGalleryList(root) {
  const context = getSillyTavernContext();
  if (root._stplusGalleryGalleryFolder && root._stplusGalleryGalleryBaseUrl) {
    try {
      const sortValue = context?.extensionSettings?.gallery?.sort ?? 'dateAsc';
      const [sortField, sortOrder] = {
        nameAsc: ['name', 'asc'],
        nameDesc: ['name', 'desc'],
        dateDesc: ['date', 'desc'],
        dateAsc: ['date', 'asc'],
      }[sortValue] ?? ['date', 'asc'];

      const response = await fetch('/api/images/list', {
        method: 'POST',
        headers: context?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folder: root._stplusGalleryGalleryFolder,
          sortField,
          sortOrder,
          type: 0b011,
        }),
      });
      if (!response.ok) return await fetchGalleryListFromCommand(context, root._stplusGalleryGalleryFolder);

      const files = await response.json();
      if (!Array.isArray(files)) return null;
      const allFiles = [...files, ...getCachedExternalGalleryPaths(root._stplusGalleryGalleryFolder)];
      return normalizeGalleryUrls(allFiles.map(file => new URL(String(file), root._stplusGalleryGalleryBaseUrl).href));
    } catch {
      // Fall through to SillyTavern's gallery command for compatibility.
    }
  }

  return await fetchGalleryListFromCommand(context, root._stplusGalleryGalleryFolder);
}

async function fetchGalleryListFromCommand(context, folder = '') {
  if (typeof context?.executeSlashCommandsWithOptions !== 'function') return null;

  try {
    const result = await context.executeSlashCommandsWithOptions('/list-gallery', {
      handleParserErrors: false,
      handleExecutionErrors: false,
      source: 'SillyTavernPlus Gallery',
    });
    const value = result?.pipe;
    const items = Array.isArray(value) ? value : JSON.parse(value);
    return Array.isArray(items) ? filterGalleryUrls(folder, normalizeGalleryUrls(items)) : null;
  } catch {
    return null;
  }
}

function filterGalleryUrls(folder, items) {
  const filters = stplusGallerySettings().fileTypeFilters;
  if (!folder || !filters || !Object.prototype.hasOwnProperty.call(filters, folder)) return items;
  const stored = Array.isArray(filters[folder]) ? filters[folder] : GALLERY_FILE_TYPES;
  const enabled = new Set(stored.map(type => String(type).toLowerCase()));
  return items.filter((item) => {
    try {
      const name = decodeURIComponent(new URL(item, location.href).pathname.split('/').pop() || '');
      return enabled.has(name.split('.').pop()?.toLowerCase());
    } catch {
      return false;
    }
  });
}

function getSillyTavernContext() {
  try {
    return window.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

function readGalleryDataList() {
  const jq = window.jQuery || window.$;
  if (typeof jq !== 'function') return null;

  const gallery = jq('#dragGallery');
  if (!gallery.length || typeof gallery.nanogallery2 !== 'function') return null;

  try {
    const items = gallery.nanogallery2('data')?.items;
    if (!Array.isArray(items)) return null;
    return normalizeGalleryUrls(items.map(item => (
      // NanoGallery may expose a responsive thumbnail through responsiveURL().
      // The slideshow must use the original media URL when it is available.
      typeof item?.src === 'string' && item.src
        ? item.src
        : (typeof item?.responsiveURL === 'function' ? item.responsiveURL() : '')
    )));
  } catch {
    return null;
  }
}

function readVisibleGalleryList() {
  const out = [];
  const thumbs = document.querySelectorAll('#dragGallery img.nGY2GThumbnailImg, #dragGallery .nGY2GThumbnailImage.nGY2TnImg');
  thumbs.forEach(t => {
    if (t instanceof HTMLImageElement && t.src) out.push(t.src);
    else if (t instanceof HTMLElement) {
      const bg = t.style.backgroundImage || '';
      const m = bg.match(/url\(["']?(.+?)["']?\)/);
      if (m) out.push(m[1]);
    }
  });
  return normalizeGalleryUrls(out);
}

function normalizeGalleryUrls(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== 'string' || !item) continue;
    let url = item;
    try {
      url = new URL(item, location.href).href;
    } catch {
      // Keep the original value if URL normalization fails.
    }
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

function sameGalleryList(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function currentGalleryList(root) {
  if (!Array.isArray(root._stplusGalleryGalleryList)) {
    root._stplusGalleryGalleryList = readGalleryDataList() ?? readVisibleGalleryList();
  }
  return root._stplusGalleryGalleryList;
}
function indexInList(list, src) {
  const norm = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
  const target = norm(src);
  return list.findIndex(u => norm(u) === target);
}

function preload(src) {
  if (!src) return;
  if (isVideoSource(src)) {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.src = src;
    return;
  }
  const i = new Image();
  i.decoding = 'async';
  i.loading = 'eager';
  i.src = src;
}
