// MovingUI windows from SillyTavern and third-party extensions are generally
// siblings under #movingDivs, but native drawers and common dialog roots can
// be mounted elsewhere in the document. Keep this list intentionally focused
// on floating UI so regular page content is never reordered.
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
    '#movingDivs > *',
    '#top-settings-holder .drawer-content',
    '#top-bar .drawer-content',
    '#options',
    '#extensionsMenu',
    '#character_popup',
    '#select_chat_popup',
    '#rawPromptPopup',
    '.popup .popper-modal',
    '.ui-dialog',
    '[role="dialog"]',
    '.popup',
    '[data-dragged]',
].join(',');

const MAIN_TEXT_PANEL_SELECTOR = '#sheld';
const EXCLUDED_PANEL_SELECTOR = '.stplus-settings-window';

let context = null;
let settings = null;
let listenersBound = false;
let panelSnapshotInitialized = false;
const knownPanelVisibility = new Map();
const originalZIndexes = new Map();

function isMovingUiEnvironmentActive() {
    return context?.powerUserSettings?.movingUI === true
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

function isMainTextPanel(panel) {
    return panel instanceof HTMLElement && panel.matches(MAIN_TEXT_PANEL_SELECTOR);
}

function isPanelVisible(panel) {
    const styles = getComputedStyle(panel);
    if (styles.display === 'none' || styles.visibility === 'hidden' || panel.hidden) return false;
    const rect = panel.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function getPanelFromEvent(event) {
    const target = event.target instanceof Element ? event.target : null;
    const panel = target?.closest(MOVINGUI_PANEL_SELECTOR);
    return isEligiblePanel(panel) && !isMainTextPanel(panel) ? panel : null;
}

function getMovingUiPanels() {
    return Array.from(document.querySelectorAll(MOVINGUI_PANEL_SELECTOR))
        .filter(isEligiblePanel);
}

function createsStackingContext(element) {
    const styles = getComputedStyle(element);
    return styles.position === 'fixed'
        || styles.position === 'sticky'
        || (styles.zIndex !== 'auto' && styles.position !== 'static')
        || styles.transform !== 'none'
        || styles.opacity !== '1'
        || styles.filter !== 'none';
}

// A child z-index cannot escape a positioned ancestor's stacking context.
// Raise the relevant context roots as well as the clicked panel so drawers
// inside #top-bar and windows inside extension containers can cross #sheld.
function getStackingTargets(panel) {
    const targets = [panel];
    let ancestor = panel.parentElement;
    while (ancestor && ancestor !== document.body) {
        if (createsStackingContext(ancestor)) targets.push(ancestor);
        ancestor = ancestor.parentElement;
    }
    return targets;
}

function getHighestZIndex() {
    return getMovingUiPanels()
        .flatMap((panel) => getStackingTargets(panel))
        .reduce((highest, candidate) => {
            const zIndex = Number.parseInt(getComputedStyle(candidate).zIndex, 10);
            return Number.isFinite(zIndex) ? Math.max(highest, zIndex) : highest;
        }, 0);
}

function bringToFront(panel) {
    if (!isMovingUiEnvironmentActive() || !isEligiblePanel(panel) || isMainTextPanel(panel)) return;

    const nextZIndex = getHighestZIndex() + 1;
    for (const target of getStackingTargets(panel)) {
        if (!originalZIndexes.has(target)) originalZIndexes.set(target, target.style.zIndex);
        target.style.zIndex = String(nextZIndex);
    }
}

function handlePointerDown(event) {
    if (settings?.movingUiBringToFrontEnabled !== false) {
        const panel = getPanelFromEvent(event);
        if (panel) bringToFront(panel);
    }
    if (settings?.movingUiOpenOnTopEnabled !== false) {
        // MovingUI and extensions often toggle an existing drawer from the
        // subsequent click handler, so check visibility after this event.
        window.setTimeout(refresh, 0);
    }
}

function handleClick() {
    if (settings?.movingUiOpenOnTopEnabled === false) return;
    // A drawer can be an existing hidden node whose class/display changes in
    // a click handler. Scan after that handler has completed.
    window.setTimeout(refresh, 0);
}

function bindListeners() {
    if (listenersBound) return;

    // Capture phase lets a window move above its siblings before MovingUI or
    // an extension starts a drag. No default action or propagation is blocked.
    if ('PointerEvent' in window) window.addEventListener('pointerdown', handlePointerDown, true);
    else window.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('click', handleClick, true);
    listenersBound = true;
}

function unbindListeners() {
    if (!listenersBound) return;
    if ('PointerEvent' in window) window.removeEventListener('pointerdown', handlePointerDown, true);
    else window.removeEventListener('mousedown', handlePointerDown, true);
    window.removeEventListener('click', handleClick, true);
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
    const environmentActive = isMovingUiEnvironmentActive();
    const clickToFrontEnabled = settings?.movingUiBringToFrontEnabled !== false;
    const openOnTopEnabled = settings?.movingUiOpenOnTopEnabled !== false;
    if (!environmentActive || (!clickToFrontEnabled && !openOnTopEnabled)) {
        unbindListeners();
        restoreZIndexes();
        knownPanelVisibility.clear();
        panelSnapshotInitialized = false;
        return;
    }

    if (clickToFrontEnabled || openOnTopEnabled) bindListeners();
    else unbindListeners();

    const currentPanels = getMovingUiPanels();
    if (!panelSnapshotInitialized) {
        for (const panel of currentPanels) knownPanelVisibility.set(panel, isPanelVisible(panel));
        panelSnapshotInitialized = true;
        return;
    }
    for (const panel of currentPanels) {
        const visible = isPanelVisible(panel);
        const wasVisible = knownPanelVisibility.get(panel) === true;
        if (openOnTopEnabled && visible && (!knownPanelVisibility.has(panel) || !wasVisible)) {
            bringToFront(panel);
        }
        knownPanelVisibility.set(panel, visible);
    }
    for (const panel of knownPanelVisibility.keys()) {
        if (!currentPanels.includes(panel)) knownPanelVisibility.delete(panel);
    }
    panelSnapshotInitialized = true;
}

