const DRAG_HANDLE_CLASS = 'stplus-movingui-drag-handle';
const READY_ATTRIBUTE = 'data-stplus-movingui-drag-ready';
const MOVINGUI_PANEL_SELECTOR = [
    '.stplus-settings-window',
    '.stplus-branching-window',
    '.stplus-chat-history-window',
    '#WorldInfo.stplus-floating-worlds',
].join(',');

const LATE_LOADED_PANEL_SELECTOR = [
    MOVINGUI_PANEL_SELECTOR,
    '.stplus-chat-history-window',
    '[data-dragged]',
].join(',');

// SillyTavern can apply the saved preset before its native panels finish
// their own layout pass. The resize manager already discovers those panels;
// include the same set here so the saved geometry can be reapplied once the
// DOM has settled, without giving native panels an ST+ drag handle.
const SAVED_STATE_PANEL_SELECTOR = [
    '#sheld',
    '#left-nav-panel',
    '#right-nav-panel',
    '#WorldInfo',
    '#floatingPrompt',
    '#logprobsViewer',
    '#cfgConfig',
    '#expression-holder',
    '#groupMemberListPopout',
    '#summaryExtensionPopout',
    '#gallery',
    '#movingDivs > div',
    MOVINGUI_PANEL_SELECTOR,
    '[data-dragged]',
].join(',');

const SAVED_MOVINGUI_STYLE_PROPERTIES = [
    'top',
    'left',
    'right',
    'bottom',
    'width',
    'height',
    'margin',
    'transform',
];
const DIMENSIONAL_MOVINGUI_STYLE_PROPERTIES = new Set([
    'top',
    'left',
    'right',
    'bottom',
    'width',
    'height',
]);

let context = null;
let settings = null;
let lifecycleListenersBound = false;
const managedPanels = new Map();

function isMovingUiActive() {
    return settings?.movingUiDragEnabled !== false
        && context?.powerUserSettings?.movingUI === true
        && context?.isMobile?.() !== true
        && document.body?.classList.contains('movingUI');
}

// SillyTavern loads power-user settings before late-loading extensions create
// their windows. Apply only the saved state for a newly discovered ST+ panel;
// native panels have already gone through SillyTavern's own loader and should
// not be rewritten by this compatibility layer.
export function applySavedMovingUiState(panel) {
    if (!isMovingUiActive()
        || !(panel instanceof HTMLElement)
        || !panel.id
        || !panel.matches(SAVED_STATE_PANEL_SELECTOR)) return false;

    const savedState = context?.powerUserSettings?.movingUIState?.[panel.id];
    if (!savedState || typeof savedState !== 'object') return false;

    let applied = false;
    for (const property of SAVED_MOVINGUI_STYLE_PROPERTIES) {
        if (!Object.hasOwn(savedState, property) || savedState[property] === undefined || savedState[property] === null) continue;
        const rawValue = savedState[property];
        if (DIMENSIONAL_MOVINGUI_STYLE_PROPERTIES.has(property)) {
            const numericValue = Number(rawValue);
            // Presets saved by SillyTavern contain both numbers and numeric
            // strings. CSSStyleDeclaration rejects a bare "35", so make the
            // unit explicit. Ignore legacy NaN coordinates rather than
            // allowing them to poison an otherwise valid preset.
            if (!Number.isFinite(numericValue)) continue;
            // A failed resize can leave a legacy ST+ record with a collapsed
            // width/height. Ignore those values so the panel's CSS defaults
            // can restore a usable size; zero is still valid for coordinates.
            if ((property === 'width' || property === 'height') && numericValue <= 0) continue;
            panel.style[property] = `${numericValue}px`;
        } else {
            panel.style[property] = String(rawValue);
        }
        applied = true;
    }
    // Older saves recorded pixel left/top after a drag or resize but did not
    // record that the panel's centered transform had been cleared. Treat that
    // geometry as an explicitly positioned panel so it cannot reopen shifted
    // off-screen by translateX(-50%).
    if (!Object.hasOwn(savedState, 'transform')
        && (Object.hasOwn(savedState, 'left') || Object.hasOwn(savedState, 'top'))) {
        panel.style.transform = 'none';
        applied = true;
    }
    if (applied && panel.matches('.stplus-chat-history-window')) clampChatHistoryPanel(panel);
    return applied;
}

function clampChatHistoryPanel(panel) {
    const rect = panel.getBoundingClientRect();
    // The panel is created hidden. Do not turn its CSS-sized geometry into
    // inline 0px dimensions while applying saved state before it opens.
    if (rect.width <= 0 || rect.height <= 0) return;
    const margin = 8;
    const maxWidth = Math.max(1, window.innerWidth - margin * 2);
    const maxHeight = Math.max(1, window.innerHeight - margin * 2);
    const width = Math.min(rect.width, maxWidth);
    const height = Math.min(rect.height, maxHeight);
    const left = Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin);
    const top = Math.min(Math.max(rect.top, margin), window.innerHeight - height - margin);
    setPanelViewportPosition(panel, left, top);
    panel.style.width = `${Math.round(width)}px`;
    panel.style.height = `${Math.round(height)}px`;
}

export function refreshSavedMovingUiState() {
    if (!isMovingUiActive()) return;
    document.querySelectorAll(SAVED_STATE_PANEL_SELECTOR).forEach((panel) => {
        if (panel instanceof HTMLElement && panel.id && panel.isConnected) applySavedMovingUiState(panel);
    });
}

function scheduleSavedStateRefresh() {
    // Native chat/preset handlers can finish in a later task. Retry briefly
    // so both startup and CHAT_CHANGED/CHAT_LOADED settle before we apply the
    // selected preset's geometry. This does not run during normal dragging.
    [0, 100, 500].forEach((delay) => {
        window.setTimeout(refreshSavedMovingUiState, delay);
    });
}

function bindLifecycleListeners() {
    if (lifecycleListenersBound) return;
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes;
    if (!eventSource?.on || !eventTypes) return;
    ['APP_READY', 'SETTINGS_LOADED', 'SETTINGS_UPDATED', 'CHAT_CHANGED', 'CHAT_LOADED', 'CHAT_CREATED']
        .map((name) => eventTypes[name])
        .filter(Boolean)
        .forEach((eventName) => eventSource.on(eventName, scheduleSavedStateRefresh));
    lifecycleListenersBound = true;
}

function getContainingBlockPosition(panel, left, top) {
    const position = getComputedStyle(panel).position;
    const offsetParent = panel.offsetParent;
    if (position === 'fixed' || !(offsetParent instanceof HTMLElement)) return { left, top };

    const parentRect = offsetParent.getBoundingClientRect();
    return {
        left: left - parentRect.left - offsetParent.clientLeft + offsetParent.scrollLeft,
        top: top - parentRect.top - offsetParent.clientTop + offsetParent.scrollTop,
    };
}

export function setPanelViewportPosition(panel, left, top) {
    const position = getContainingBlockPosition(panel, left, top);
    panel.style.left = `${Math.round(position.left)}px`;
    panel.style.top = `${Math.round(position.top)}px`;
    panel.style.right = 'unset';
    panel.style.bottom = 'unset';
}

// Convert centered/right/bottom-positioned panels to the pixel coordinates
// represented by their current viewport rectangle before a drag or resize.
// This prevents translateX(-50%) and right/bottom rules from shifting a panel
// on the first pointer movement.
export function normalizePanelPosition(panel) {
    const rect = panel.getBoundingClientRect();
    panel.style.transform = 'none';
    setPanelViewportPosition(panel, rect.left, rect.top);
    return panel.getBoundingClientRect();
}

function saveMovingUiState(panel) {
    const movingUIState = context?.powerUserSettings?.movingUIState;
    if (!panel.id || !movingUIState || typeof movingUIState !== 'object') return;

    const rect = panel.getBoundingClientRect();
    movingUIState[panel.id] = {
        ...(movingUIState[panel.id] ?? {}),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        right: 'unset',
        bottom: 'unset',
        margin: 'unset',
        transform: panel.style.transform || 'none',
    };
    panel.dataset.dragged = 'true';
    context.saveSettingsDebounced?.();
}

function getHeader(panel) {
    return panel.querySelector('.stplus-settings-window-header, .stplus-branching-header, .stplus-worlds-title-row') ?? panel;
}

function addDragHandle(panel) {
    if (panel.hasAttribute(READY_ATTRIBUTE)) return;
    panel.setAttribute(READY_ATTRIBUTE, '1');

    const header = getHeader(panel);
    if (!(header instanceof HTMLElement)) return;
    // World Info already has a native #WorldInfoheader. Do not create a
    // duplicate ID on its ST+ title row; the custom handle only needs the
    // native drag-grabber class there.
    if (!header.id && !panel.matches('#WorldInfo.stplus-floating-worlds')) header.id = `${panel.id}header`;
    header.classList.add('stplus-movingui-header');

    // Use the same element and Font Awesome grip icon as native MovingUI.
    // The drag behavior remains extension-owned so third-party panels do not
    // need to expose a particular header structure.
    const handle = document.createElement('div');
    handle.className = `fa-solid fa-grip drag-grabber ${DRAG_HANDLE_CLASS}`;
    handle.dataset.stplusOwned = '1';
    handle.title = 'Move this window';
    handle.setAttribute('aria-label', `Move ${panel.getAttribute('aria-label') || 'window'}`);
    header.appendChild(handle);

    let dragState = null;
    const stopEvent = (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
    };
    const startDragging = (event) => {
        if (!isMovingUiActive() || (event.button !== undefined && event.button !== 0)) return;
        if (dragState) {
            stopEvent(event);
            return;
        }
        const rect = normalizePanelPosition(panel);
        dragState = {
            pointerId: event.pointerId ?? null,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: rect.left,
            startTop: rect.top,
        };
        if (event.pointerId !== undefined) handle.setPointerCapture?.(event.pointerId);
        stopEvent(event);
    };
    const matchesPointer = (event) => dragState
        && (dragState.pointerId === null ? event.pointerId === undefined : dragState.pointerId === event.pointerId);
    const move = (event) => {
        if (!matchesPointer(event)) return;
        setPanelViewportPosition(panel,
            dragState.startLeft + event.clientX - dragState.startX,
            dragState.startTop + event.clientY - dragState.startY);
        stopEvent(event);
    };
    const stopDragging = (event) => {
        if (!matchesPointer(event)) return;
        dragState = null;
        if (event.pointerId !== undefined && handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        saveMovingUiState(panel);
        stopEvent(event);
    };

    handle.addEventListener('pointerdown', startDragging);
    handle.addEventListener('mousedown', startDragging);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('mousemove', move);
    handle.addEventListener('pointerup', stopDragging);
    handle.addEventListener('mouseup', stopDragging);
    handle.addEventListener('pointercancel', stopDragging);
    handle.addEventListener('lostpointercapture', stopDragging);

    const moveWithMouse = (event) => {
        if (dragState?.pointerId === null) move(event);
    };
    const stopMouse = (event) => {
        if (dragState?.pointerId === null) stopDragging(event);
    };
    const moveWithPointer = (event) => {
        if (dragState?.pointerId !== null && dragState?.pointerId !== undefined) move(event);
    };
    const stopPointer = (event) => {
        if (dragState?.pointerId !== null && dragState?.pointerId !== undefined) stopDragging(event);
    };
    document.addEventListener('mousemove', moveWithMouse);
    document.addEventListener('mouseup', stopMouse);
    document.addEventListener('pointermove', moveWithPointer);
    document.addEventListener('pointerup', stopPointer);
    document.addEventListener('pointercancel', stopPointer);

    return () => {
        dragState = null;
        document.removeEventListener('mousemove', moveWithMouse);
        document.removeEventListener('mouseup', stopMouse);
        document.removeEventListener('pointermove', moveWithPointer);
        document.removeEventListener('pointerup', stopPointer);
        document.removeEventListener('pointercancel', stopPointer);
        handle.remove();
        header.classList.remove('stplus-movingui-header');
        panel.removeAttribute(READY_ATTRIBUTE);
    };
}

function removeAllHandles() {
    for (const [panel, cleanup] of managedPanels) {
        cleanup();
        managedPanels.delete(panel);
    }
}

export function initialize(stContext, stSettings) {
    context = stContext;
    settings = stSettings;
    bindLifecycleListeners();
    scheduleSavedStateRefresh();
}

export function refresh() {
    if (!isMovingUiActive()) {
        removeAllHandles();
        return;
    }

    const candidates = new Set(document.querySelectorAll(MOVINGUI_PANEL_SELECTOR));
    for (const panel of candidates) {
        if (!(panel instanceof HTMLElement) || !panel.id || !panel.isConnected) continue;
        if (!managedPanels.has(panel)) {
            applySavedMovingUiState(panel);
            managedPanels.set(panel, addDragHandle(panel));
        }
    }
    for (const [panel, cleanup] of managedPanels) {
        if (!candidates.has(panel) || !panel.isConnected) {
            cleanup?.();
            managedPanels.delete(panel);
        }
    }
}
