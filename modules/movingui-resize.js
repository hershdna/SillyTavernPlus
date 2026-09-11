const RESIZE_HANDLE_CLASS = 'stplus-movingui-resize-handle';
const READY_ATTRIBUTE = 'data-stplus-movingui-resize-ready';

// These are the panels managed by SillyTavern's MovingUI implementation.
// #movingDivs also covers windows created by third-party extensions.
const MOVINGUI_PANEL_SELECTOR = [
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
    '[data-dragged]',
].join(',');

const EXCLUDED_PANEL_SELECTOR = '#WorldInfo, .stplus-settings-window';
const CORNERS = [
    ['nw', 'top left'],
    ['ne', 'top right'],
    ['sw', 'bottom left'],
    ['se', 'bottom right'],
];

let context = null;
let settings = null;
const managedPanels = new Map();
const originalResizeConstraints = new Map();

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function isMovingUiActive() {
    return settings?.movingUiResizeEnabled !== false
        && context?.powerUserSettings?.movingUI === true
        && context?.isMobile?.() !== true
        && document.body?.classList.contains('movingUI');
}

function getCandidatePanels() {
    const panels = new Set();
    document.querySelectorAll(MOVINGUI_PANEL_SELECTOR).forEach((panel) => {
        if (!(panel instanceof HTMLElement) || !panel.id || panel.matches(EXCLUDED_PANEL_SELECTOR)) return;
        if (panel.closest('.stplus-settings-window')) return;
        if (getComputedStyle(panel).position === 'static') return;
        panels.add(panel);
    });
    return panels;
}

function applyResizeConstraints(panel) {
    if (!originalResizeConstraints.has(panel)) {
        originalResizeConstraints.set(panel, {
            maxWidth: panel.style.maxWidth,
            maxHeight: panel.style.maxHeight,
        });
    }
    if (settings?.movingUiUnboundedResizeEnabled !== true) return;
    panel.style.maxWidth = 'none';
    panel.style.maxHeight = 'none';
}

function restoreResizeConstraints(panel) {
    const original = originalResizeConstraints.get(panel);
    if (!original) return;
    if (panel.isConnected) {
        panel.style.maxWidth = original.maxWidth;
        panel.style.maxHeight = original.maxHeight;
    }
    originalResizeConstraints.delete(panel);
}

function restoreAllResizeConstraints() {
    for (const panel of originalResizeConstraints.keys()) restoreResizeConstraints(panel);
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
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        margin: 'unset',
    };
    panel.dataset.dragged = 'true';
    context.saveSettingsDebounced?.();
    context.eventSource?.emit?.('resizeUI', panel.id);
}

function addResizeHandles(panel) {
    if (panel.hasAttribute(READY_ATTRIBUTE)) return;
    panel.setAttribute(READY_ATTRIBUTE, '1');

    let resizeState = null;
    const handleElements = [];
    const matchesPointer = (event) => {
        if (!resizeState) return false;
        if (resizeState.pointerId === null) return event.pointerId === undefined;
        return resizeState.pointerId === event.pointerId;
    };
    const stopEvent = (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
    };
    const stopResizing = (event) => {
        if (!matchesPointer(event)) return;
        const handle = resizeState.handle;
        resizeState = null;
        if (event.pointerId !== undefined && handle.hasPointerCapture?.(event.pointerId)) {
            handle.releasePointerCapture(event.pointerId);
        }
        saveMovingUiState(panel);
        stopEvent(event);
    };
    const resize = (event) => {
        if (!matchesPointer(event)) return;
        const { corner, startLeft, startTop, startWidth, startHeight, minWidth, minHeight } = resizeState;
        const deltaX = event.clientX - resizeState.startX;
        const deltaY = event.clientY - resizeState.startY;
        const right = startLeft + startWidth;
        const bottom = startTop + startHeight;
        let left = startLeft;
        let top = startTop;
        let width = startWidth;
        let height = startHeight;
        const unbounded = settings?.movingUiUnboundedResizeEnabled === true;

        if (corner.includes('e')) {
            width = unbounded
                ? Math.max(minWidth, startWidth + deltaX)
                : Math.max(minWidth, Math.min(startWidth + deltaX, window.innerWidth - startLeft - 8));
        } else if (corner.includes('w')) {
            left = unbounded
                ? Math.min(startLeft + deltaX, right - minWidth)
                : clamp(startLeft + deltaX, 8, right - minWidth);
            width = right - left;
        }
        if (corner.includes('s')) {
            height = unbounded
                ? Math.max(minHeight, startHeight + deltaY)
                : Math.max(minHeight, Math.min(startHeight + deltaY, window.innerHeight - startTop - 8));
        } else if (corner.includes('n')) {
            top = unbounded
                ? Math.min(startTop + deltaY, bottom - minHeight)
                : clamp(startTop + deltaY, 8, bottom - minHeight);
            height = bottom - top;
        }

        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
        panel.style.right = 'unset';
        panel.style.bottom = 'unset';
        panel.style.width = `${Math.round(width)}px`;
        panel.style.height = `${Math.round(height)}px`;
        stopEvent(event);
    };

    CORNERS.forEach(([corner, label]) => {
        const handle = document.createElement('div');
        handle.className = `${RESIZE_HANDLE_CLASS} stplus-movingui-resize-${corner}`;
        handle.dataset.corner = corner;
        handle.dataset.stplusOwned = '1';
        handle.setAttribute('aria-hidden', 'true');
        handle.title = `Resize MovingUI window from the ${label} corner`;
        const startResizing = (event) => {
            if (!isMovingUiActive() || (event.button !== undefined && event.button !== 0)) return;
            if (resizeState) {
                stopEvent(event);
                return;
            }
            const rect = panel.getBoundingClientRect();
            const styles = getComputedStyle(panel);
            resizeState = {
                corner,
                handle,
                pointerId: event.pointerId ?? null,
                startX: event.clientX,
                startY: event.clientY,
                startLeft: rect.left,
                startTop: rect.top,
                startWidth: rect.width,
                startHeight: rect.height,
                minWidth: Number.parseFloat(styles.minWidth) || 100,
                minHeight: Number.parseFloat(styles.minHeight) || 100,
            };
            if (event.pointerId !== undefined) handle.setPointerCapture?.(event.pointerId);
            stopEvent(event);
        };

        handle.addEventListener('pointerdown', startResizing);
        handle.addEventListener('mousedown', startResizing);
        handle.addEventListener('pointermove', resize);
        handle.addEventListener('mousemove', resize);
        handle.addEventListener('pointerup', stopResizing);
        handle.addEventListener('mouseup', stopResizing);
        handle.addEventListener('pointercancel', stopResizing);
        handle.addEventListener('lostpointercapture', stopResizing);
        panel.appendChild(handle);
        handleElements.push(handle);
    });

    const resizeWithMouse = (event) => {
        if (resizeState?.pointerId === null) resize(event);
    };
    const stopMouseResize = (event) => {
        if (resizeState?.pointerId === null) stopResizing(event);
    };
    const resizeWithPointer = (event) => {
        if (resizeState?.pointerId !== null && resizeState?.pointerId !== undefined) resize(event);
    };
    const stopPointerResize = (event) => {
        if (resizeState?.pointerId !== null && resizeState?.pointerId !== undefined) stopResizing(event);
    };
    document.addEventListener('mousemove', resizeWithMouse);
    document.addEventListener('mouseup', stopMouseResize);
    document.addEventListener('pointermove', resizeWithPointer);
    document.addEventListener('pointerup', stopPointerResize);
    document.addEventListener('pointercancel', stopPointerResize);

    return () => {
        resizeState = null;
        document.removeEventListener('mousemove', resizeWithMouse);
        document.removeEventListener('mouseup', stopMouseResize);
        document.removeEventListener('pointermove', resizeWithPointer);
        document.removeEventListener('pointerup', stopPointerResize);
        document.removeEventListener('pointercancel', stopPointerResize);
        handleElements.forEach((handle) => handle.remove());
        panel.removeAttribute(READY_ATTRIBUTE);
    };
}

function removeAllHandles() {
    for (const [panel, cleanup] of managedPanels) {
        cleanup();
        managedPanels.delete(panel);
    }
    restoreAllResizeConstraints();
}

export function initialize(stContext, stSettings) {
    context = stContext;
    settings = stSettings;
}

export function refresh() {
    if (!isMovingUiActive()) {
        removeAllHandles();
        return;
    }

    const candidates = getCandidatePanels();
    for (const panel of candidates) {
        applyResizeConstraints(panel);
        if (!managedPanels.has(panel)) managedPanels.set(panel, addResizeHandles(panel));
    }
    for (const [panel, cleanup] of managedPanels) {
        if (!candidates.has(panel) || !panel.isConnected) {
            cleanup();
            restoreResizeConstraints(panel);
            managedPanels.delete(panel);
        }
    }
    if (settings?.movingUiUnboundedResizeEnabled !== true) restoreAllResizeConstraints();
}

