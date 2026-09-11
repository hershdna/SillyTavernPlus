import { save } from './settings-store.js';

const SETTINGS_BUTTON_ID = 'stplus-module-manager-button';
const LEGACY_SETTINGS_BUTTON_ID = 'stplus-settings-button';
const SETTINGS_WINDOW_ID = 'stplus-settings-window';
const RESIZE_HANDLE_CLASS = 'stplus-settings-resize-handle';

let settings = null;
let callbacks = null;

function closeSettingsWindow() {
    document.getElementById(SETTINGS_WINDOW_ID)?.classList.remove('stplus-settings-window-open');
}

function toggleSettingsWindow(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    document.getElementById(SETTINGS_WINDOW_ID)?.classList.toggle('stplus-settings-window-open');
}

function getToolbarHost() {
    const candidates = ['#top-settings-holder', '#top-bar', '#extensionTopBar'];
    return candidates
        .map((selector) => document.querySelector(selector))
        .find((element) => element instanceof HTMLElement) ?? null;
}

function createCheckbox(id, labelText, description, onChange) {
    const row = document.createElement('label');
    row.className = 'stplus-settings-option';
    row.htmlFor = id;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.addEventListener('change', () => {
        onChange(input.checked);
        save();
    });

    const copy = document.createElement('span');
    const label = document.createElement('strong');
    label.textContent = labelText;
    const help = document.createElement('small');
    help.textContent = description;
    copy.append(label, help);
    row.append(input, copy);
    return row;
}

function createSettingsSection(titleText) {
    const section = document.createElement('section');
    section.className = 'stplus-settings-section';
    const title = document.createElement('h4');
    title.className = 'stplus-settings-section-title';
    title.textContent = titleText;
    section.appendChild(title);
    return section;
}

function addResizeHandles(panel) {
    const corners = [
        ['nw', 'top left'],
        ['ne', 'top right'],
        ['sw', 'bottom left'],
        ['se', 'bottom right'],
    ];
    let resizeState = null;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const matchesPointer = (event) => {
        if (!resizeState) return false;
        if (resizeState.pointerId === null) return event.pointerId === undefined;
        return event.pointerId === resizeState.pointerId;
    };
    const stopResizing = (event) => {
        if (!matchesPointer(event)) return;
        const handle = resizeState.handle;
        resizeState = null;
        if (event.pointerId !== undefined && handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
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

        if (corner.includes('e')) width = Math.max(minWidth, Math.min(startWidth + deltaX, window.innerWidth - startLeft - 8));
        else if (corner.includes('w')) {
            left = clamp(startLeft + deltaX, 8, right - minWidth);
            width = right - left;
        }
        if (corner.includes('s')) height = Math.max(minHeight, Math.min(startHeight + deltaY, window.innerHeight - startTop - 8));
        else if (corner.includes('n')) {
            top = clamp(startTop + deltaY, 8, bottom - minHeight);
            height = bottom - top;
        }

        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
        panel.style.width = `${Math.round(width)}px`;
        panel.style.height = `${Math.round(height)}px`;
    };
    corners.forEach(([corner, label]) => {
        const handle = document.createElement('div');
        handle.className = `${RESIZE_HANDLE_CLASS} stplus-settings-resize-${corner}`;
        handle.dataset.stplusOwned = '1';
        handle.setAttribute('aria-hidden', 'true');
        handle.title = `Resize SillyTavernPlus settings from the ${label} corner`;
        const startResizing = (event) => {
            if (event.button !== undefined && event.button !== 0) return;
            if (resizeState) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                return;
            }
            const rect = panel.getBoundingClientRect();
            const styles = getComputedStyle(panel);
            panel.style.transform = 'none';
            panel.style.left = `${Math.round(rect.left)}px`;
            panel.style.top = `${Math.round(rect.top)}px`;
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
                minWidth: Number.parseFloat(styles.minWidth) || 280,
                minHeight: Number.parseFloat(styles.minHeight) || 160,
            };
            if (event.pointerId !== undefined) handle.setPointerCapture?.(event.pointerId);
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
        };
        handle.addEventListener('pointerdown', startResizing);
        handle.addEventListener('mousedown', startResizing);
        handle.addEventListener('pointermove', resize);
        handle.addEventListener('pointerup', stopResizing);
        handle.addEventListener('pointercancel', stopResizing);
        handle.addEventListener('lostpointercapture', stopResizing);
        panel.appendChild(handle);
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
}

function createSettingsWindow() {
    const panel = document.createElement('section');
    panel.id = SETTINGS_WINDOW_ID;
    panel.className = 'stplus-settings-window';
    panel.setAttribute('aria-label', 'SillyTavernPlus settings');

    const header = document.createElement('div');
    header.className = 'stplus-settings-window-header';
    const title = document.createElement('h3');
    title.textContent = 'SillyTavernPlus Settings';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'menu_button stplus-settings-window-close';
    close.title = 'Close SillyTavernPlus settings';
    close.setAttribute('aria-label', close.title);
    close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    close.addEventListener('click', closeSettingsWindow);
    header.append(title, close);

    const body = document.createElement('div');
    body.className = 'stplus-settings-window-body';
    const intro = document.createElement('p');
    intro.textContent = 'Choose which SillyTavernPlus features are active.';
    body.append(intro);
    const worldInfoSection = createSettingsSection('World Info / Lorebooks');
    worldInfoSection.append(createCheckbox(
        'stplus-lorebook-mods-enabled',
        'Lorebook mods',
        'Floating Worlds/Lorebooks window and reasoning-based World Info scanning.',
        (enabled) => {
            settings.lorebookModsEnabled = enabled;
            callbacks?.onLorebookModsChanged?.();
        },
    ));
    body.append(worldInfoSection);

    const charactersSection = createSettingsSection('Characters');
    charactersSection.append(createCheckbox(
        'stplus-greeting-mods-enabled',
        'Greeting mods',
        'Alternate greeting reorder controls.',
        (enabled) => {
            settings.greetingModsEnabled = enabled;
            callbacks?.onGreetingModsChanged?.();
        },
    ));
    body.append(charactersSection);

    const movingUiSection = createSettingsSection('MovingUI');
    movingUiSection.append(createCheckbox(
        'stplus-movingui-resize-enabled',
        'MovingUI corner resizing',
        'Add four-corner resize handles to SillyTavern and third-party MovingUI windows.',
        (enabled) => {
            settings.movingUiResizeEnabled = enabled;
            callbacks?.onMovingUiResizeChanged?.();
        },
    ));
    movingUiSection.append(createCheckbox(
        'stplus-movingui-bring-to-front-enabled',
        'Bring MovingUI windows to front',
        'Raise the clicked SillyTavern or third-party MovingUI window above the other floating windows.',
        (enabled) => {
            settings.movingUiBringToFrontEnabled = enabled;
            callbacks?.onMovingUiBringToFrontChanged?.();
        },
    ));
    movingUiSection.append(createCheckbox(
        'stplus-movingui-open-on-top-enabled',
        'Open new MovingUI windows on top',
        'Raise newly-created SillyTavern or third-party MovingUI windows above other floating windows.',
        (enabled) => {
            settings.movingUiOpenOnTopEnabled = enabled;
            callbacks?.onMovingUiOpenOnTopChanged?.();
        },
    ));
    movingUiSection.append(createCheckbox(
        'stplus-movingui-unbounded-resize-enabled',
        'Remove MovingUI resize limits',
        'Allow MovingUI windows to grow beyond the viewport; oversized windows may need to be dragged back into view.',
        (enabled) => {
            settings.movingUiUnboundedResizeEnabled = enabled;
            callbacks?.onMovingUiUnboundedResizeChanged?.();
        },
    ));
    body.append(movingUiSection);

    panel.append(header, body);
    document.body.appendChild(panel);
    addResizeHandles(panel);
    return panel;
}

function installSettingsButton() {
    const host = getToolbarHost();
    if (!(host instanceof HTMLElement)) return;
    document.querySelector(`#${LEGACY_SETTINGS_BUTTON_ID}[data-stplus-owned="1"]`)?.remove();
    let button = document.getElementById(SETTINGS_BUTTON_ID);
    if (!(button instanceof HTMLButtonElement)) {
        button = document.createElement('button');
        button.type = 'button';
        button.id = SETTINGS_BUTTON_ID;
        button.dataset.stplusOwned = '1';
        button.title = 'Open SillyTavernPlus settings';
        button.setAttribute('aria-label', button.title);
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-puzzle-piece fa-fw stplus-settings-icon';
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        button.addEventListener('click', toggleSettingsWindow);
        button.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            toggleSettingsWindow(event);
        });
    }
    button.className = 'stplus-module-manager-button';
    if (button.parentElement !== host) host.appendChild(button);
}

export function initialize(stSettings, stCallbacks) {
    settings = stSettings;
    callbacks = stCallbacks;
    if (!document.getElementById(SETTINGS_WINDOW_ID)) createSettingsWindow();
}

export function refresh() {
    installSettingsButton();
    const lorebookCheckbox = document.getElementById('stplus-lorebook-mods-enabled');
    const greetingCheckbox = document.getElementById('stplus-greeting-mods-enabled');
    const movingUiResizeCheckbox = document.getElementById('stplus-movingui-resize-enabled');
    const movingUiBringToFrontCheckbox = document.getElementById('stplus-movingui-bring-to-front-enabled');
    const movingUiOpenOnTopCheckbox = document.getElementById('stplus-movingui-open-on-top-enabled');
    const movingUiUnboundedResizeCheckbox = document.getElementById('stplus-movingui-unbounded-resize-enabled');
    if (lorebookCheckbox) lorebookCheckbox.checked = settings.lorebookModsEnabled;
    if (greetingCheckbox) greetingCheckbox.checked = settings.greetingModsEnabled;
    if (movingUiResizeCheckbox) movingUiResizeCheckbox.checked = settings.movingUiResizeEnabled;
    if (movingUiBringToFrontCheckbox) movingUiBringToFrontCheckbox.checked = settings.movingUiBringToFrontEnabled;
    if (movingUiOpenOnTopCheckbox) movingUiOpenOnTopCheckbox.checked = settings.movingUiOpenOnTopEnabled;
    if (movingUiUnboundedResizeCheckbox) movingUiUnboundedResizeCheckbox.checked = settings.movingUiUnboundedResizeEnabled;
}
