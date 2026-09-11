// MovingUI windows from SillyTavern and third-party extensions are generally
// siblings under #movingDivs, but the named panels below cover native panels
// that are mounted elsewhere in the document.
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

const EXCLUDED_PANEL_SELECTOR = '.stplus-settings-window';

let context = null;
let settings = null;
let listenersBound = false;
const originalZIndexes = new Map();

function isMovingUiActive() {
    return settings?.movingUiBringToFrontEnabled !== false
        && context?.powerUserSettings?.movingUI === true
        && context?.isMobile?.() !== true
        && document.body?.classList.contains('movingUI');
}

function isEligiblePanel(panel) {
    return panel instanceof HTMLElement
        && panel.isConnected
        && !panel.matches(EXCLUDED_PANEL_SELECTOR)
        && !panel.closest(EXCLUDED_PANEL_SELECTOR)
        && getComputedStyle(panel).position !== 'static';
}

function getPanelFromEvent(event) {
    const target = event.target instanceof Element ? event.target : null;
    const panel = target?.closest(MOVINGUI_PANEL_SELECTOR);
    return isEligiblePanel(panel) ? panel : null;
}

function getMovingUiPanels() {
    return Array.from(document.querySelectorAll(MOVINGUI_PANEL_SELECTOR))
        .filter(isEligiblePanel);
}

function bringToFront(panel) {
    if (!isMovingUiActive()) return;

    if (!originalZIndexes.has(panel)) originalZIndexes.set(panel, panel.style.zIndex);

    const highestZIndex = getMovingUiPanels().reduce((highest, candidate) => {
        const zIndex = Number.parseInt(getComputedStyle(candidate).zIndex, 10);
        return Number.isFinite(zIndex) ? Math.max(highest, zIndex) : highest;
    }, 0);
    const currentZIndex = Number.parseInt(getComputedStyle(panel).zIndex, 10);
    const nextZIndex = Math.max(highestZIndex + 1, Number.isFinite(currentZIndex) ? currentZIndex : 0);
    panel.style.zIndex = String(nextZIndex);
}

function handlePointerDown(event) {
    const panel = getPanelFromEvent(event);
    if (panel) bringToFront(panel);
}

function bindListeners() {
    if (listenersBound) return;

    // Capture phase lets a window move above its siblings before MovingUI or
    // an extension starts a drag. No default action or propagation is blocked.
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('mousedown', handlePointerDown, true);
    listenersBound = true;
}

function unbindListeners() {
    if (!listenersBound) return;
    window.removeEventListener('pointerdown', handlePointerDown, true);
    window.removeEventListener('mousedown', handlePointerDown, true);
    listenersBound = false;
}

function restoreZIndexes() {
    for (const [panel, zIndex] of originalZIndexes) {
        if (panel.isConnected) panel.style.zIndex = zIndex;
    }
    originalZIndexes.clear();
}

export function initialize(stContext, stSettings) {
    context = stContext;
    settings = stSettings;
}

export function refresh() {
    if (!isMovingUiActive()) {
        unbindListeners();
        restoreZIndexes();
        return;
    }
    bindListeners();
}

