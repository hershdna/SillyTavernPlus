const WINDOW_ID = 'stplus-movingui-window-manager';
const WINDOW_LIST_ID = 'stplus-movingui-window-list';
const REFRESH_ATTRIBUTE_FILTER = ['class', 'style', 'hidden', 'aria-hidden', 'data-dragged'];
const MOVING_UI_WINDOW_SELECTOR = [
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
    '.stplus-settings-window',
    '.stplus-branching-window',
    '.stplus-chat-history-window',
    '#rawPromptPopup',
    '.popup .popper-modal',
    '.ui-dialog',
    '.ui-autocomplete',
    '[role="dialog"]',
    '.popup',
    '[data-dragged]',
].join(',');
const RESETTABLE_STYLES = ['top', 'left', 'right', 'bottom', 'height', 'width', 'margin', 'transform'];
const RESET_VIEWPORT_RATIO = 0.8;

let context = null;
let panel = null;
let observer = null;
let refreshFrame = 0;
let lastWindowSignature = '';

function isVisibleWindow(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected || !element.id) return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    const styles = getComputedStyle(element);
    if (styles.display === 'none' || styles.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function getOpenWindows() {
    const windows = new Set();
    document.querySelectorAll(MOVING_UI_WINDOW_SELECTOR).forEach((element) => {
        if (element !== panel && isVisibleWindow(element)) windows.add(element);
    });
    return [...windows].sort((left, right) => getWindowLabel(left).localeCompare(getWindowLabel(right)));
}

function humanizeId(id) {
    return String(id)
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getWindowLabel(element) {
    const explicitLabel = element.getAttribute('aria-label') || element.getAttribute('data-window-title') || element.title;
    if (explicitLabel?.trim()) return explicitLabel.trim();
    const heading = element.querySelector('h1, h2, h3, h4, .popup-title, .window-title, .drag-grabber[title]');
    const headingText = heading?.textContent?.trim() || heading?.getAttribute?.('title')?.trim();
    return headingText || humanizeId(element.id);
}

function getWindowSignature(windows) {
    return windows.map((element) => `${element.id}:${getWindowLabel(element)}`).join('|');
}

function saveMovingUiSettings() {
    context?.saveSettingsDebounced?.();
}

function emitPanelsReset(panelId) {
    const eventName = context?.eventTypes?.MOVABLE_PANELS_RESET;
    if (eventName && typeof context?.eventSource?.emit === 'function') {
        context.eventSource.emit(eventName, panelId);
    }
}

export function resetWindow(panelToReset) {
    if (!(panelToReset instanceof HTMLElement) || !panelToReset.id) return false;

    panelToReset.classList.add('resizing');
    resetWindowGeometry(panelToReset, context?.powerUserSettings?.movingUIState);
    saveMovingUiSettings();
    emitPanelsReset(panelToReset.id);
    window.setTimeout(() => panelToReset.classList.remove('resizing'), 60);
    return true;
}

export function resetWindowGeometry(panelToReset, movingUIState = null) {
    if (!panelToReset?.id || !panelToReset.style) return false;
    RESETTABLE_STYLES.forEach((property) => {
        panelToReset.style[property] = '';
    });
    panelToReset.removeAttribute('data-dragged');

    const geometry = getResetGeometry(panelToReset);
    panelToReset.style.width = `${geometry.width}px`;
    panelToReset.style.height = `${geometry.height}px`;
    setCenteredViewportPosition(panelToReset, geometry.left, geometry.top);

    if (movingUIState && typeof movingUIState === 'object') {
        delete movingUIState[panelToReset.id];
    }
    return true;
}

export function getResetGeometry(panelToReset, viewportWidth = window.innerWidth, viewportHeight = window.innerHeight) {
    const safeViewportWidth = Number.isFinite(Number(viewportWidth)) && Number(viewportWidth) > 0
        ? Number(viewportWidth)
        : 1;
    const safeViewportHeight = Number.isFinite(Number(viewportHeight)) && Number(viewportHeight) > 0
        ? Number(viewportHeight)
        : 1;
    const maxWidth = Math.max(1, Math.floor(safeViewportWidth * RESET_VIEWPORT_RATIO));
    const maxHeight = Math.max(1, Math.floor(safeViewportHeight * RESET_VIEWPORT_RATIO));
    const rect = typeof panelToReset?.getBoundingClientRect === 'function'
        ? panelToReset.getBoundingClientRect()
        : {};
    const currentWidth = Number(rect.width);
    const currentHeight = Number(rect.height);
    const width = Math.min(maxWidth, Math.max(1, Number.isFinite(currentWidth) && currentWidth > 0 ? Math.round(currentWidth) : maxWidth));
    const height = Math.min(maxHeight, Math.max(1, Number.isFinite(currentHeight) && currentHeight > 0 ? Math.round(currentHeight) : maxHeight));
    return {
        width,
        height,
        left: Math.max(0, Math.round((safeViewportWidth - width) / 2)),
        top: Math.max(0, Math.round((safeViewportHeight - height) / 2)),
    };
}

function setCenteredViewportPosition(panelToReset, left, top) {
    const position = typeof getComputedStyle === 'function'
        ? getComputedStyle(panelToReset).position
        : panelToReset.style.position;
    const offsetParent = panelToReset.offsetParent;
    if (position !== 'fixed' && offsetParent && typeof offsetParent.getBoundingClientRect === 'function') {
        const parentRect = offsetParent.getBoundingClientRect();
        left -= parentRect.left + (offsetParent.clientLeft ?? 0) - (offsetParent.scrollLeft ?? 0);
        top -= parentRect.top + (offsetParent.clientTop ?? 0) - (offsetParent.scrollTop ?? 0);
    }
    panelToReset.style.left = `${Math.max(0, Math.round(left))}px`;
    panelToReset.style.top = `${Math.max(0, Math.round(top))}px`;
    panelToReset.style.right = 'unset';
    panelToReset.style.bottom = 'unset';
}

function closeWindow() {
    panel?.classList.remove('stplus-movingui-window-manager-open');
}

function createButton(label, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button stplus-movingui-manager-button';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick(event);
    });
    return button;
}

function renderList(force = false) {
    const list = panel?.querySelector(`#${WINDOW_LIST_ID}`);
    if (!(list instanceof HTMLElement)) return;

    const windows = getOpenWindows();
    const signature = getWindowSignature(windows);
    if (!force && signature === lastWindowSignature) return;
    lastWindowSignature = signature;
    list.replaceChildren();

    if (windows.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'stplus-movingui-manager-empty';
        empty.textContent = 'No open MovingUI windows detected.';
        list.append(empty);
        return;
    }

    windows.forEach((windowElement) => {
        const row = document.createElement('div');
        row.className = 'stplus-movingui-manager-row';
        row.dataset.windowId = windowElement.id;

        const name = document.createElement('strong');
        name.className = 'stplus-movingui-manager-window-name';
        name.textContent = getWindowLabel(windowElement);
        name.title = `${getWindowLabel(windowElement)} (#${windowElement.id})`;

        const reset = createButton('Reset', `Reset location and size for ${getWindowLabel(windowElement)}`, () => {
            resetWindow(windowElement);
        });
        reset.classList.add('stplus-movingui-manager-reset');
        row.append(name, reset);
        list.append(row);
    });
}

function createWindow() {
    const existing = document.getElementById(WINDOW_ID);
    if (existing instanceof HTMLElement) {
        panel = existing;
        return panel;
    }

    panel = document.createElement('section');
    panel.id = WINDOW_ID;
    panel.className = 'stplus-settings-window stplus-movingui-manager-window';
    panel.setAttribute('aria-label', 'MovingUI window manager');

    const header = document.createElement('div');
    header.className = 'stplus-settings-window-header';
    const title = document.createElement('h3');
    title.textContent = 'MovingUI Windows';
    const close = createButton('', 'Close MovingUI window manager', closeWindow);
    close.className = 'menu_button stplus-settings-window-close';
    close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    header.append(title, close);

    const body = document.createElement('div');
    body.className = 'stplus-settings-window-body stplus-movingui-manager-body';
    const description = document.createElement('p');
    description.textContent = 'Reset an open floating window to its default location and size.';
    const list = document.createElement('div');
    list.id = WINDOW_LIST_ID;
    list.className = 'stplus-movingui-manager-list';
    body.append(description, list);
    panel.append(header, body);
    document.body.append(panel);
    return panel;
}

function openWindow() {
    createWindow().classList.add('stplus-movingui-window-manager-open');
    renderList(true);
}

function scheduleRefresh() {
    if (refreshFrame) return;
    const run = () => {
        refreshFrame = 0;
        renderList();
    };
    refreshFrame = typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(run)
        : window.setTimeout(run, 0);
}

function bindObserver() {
    if (observer || typeof MutationObserver !== 'function' || !document.body) return;
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.body, {
        attributes: true,
        attributeFilter: REFRESH_ATTRIBUTE_FILTER,
        childList: true,
        subtree: true,
    });
}

export function initialize(stContext) {
    context = stContext;
    createWindow();
    bindObserver();
    renderList(true);
}

export function refresh() {
    createWindow();
    renderList();
}

export function open() {
    openWindow();
}
