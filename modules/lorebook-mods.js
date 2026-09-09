import { normalizeDepth, save } from './settings-store.js';

const WORLD_WINDOW_CLASS = 'stplus-floating-worlds';
const WORLD_WINDOW_ID = 'stplus-worlds-button';
const WORLD_WINDOW_STATE_KEY = 'stplus.worldsWindow';
const REASONING_PROMPT_ID = 'SillyTavernPlusReasoning';
const REASONING_SETTING_ID = 'stplus-reasoning-scan-setting';
const RESIZE_HANDLE_CLASS = 'stplus-worlds-resize-handle';
const CLOSE_BUTTON_CLASS = 'stplus-worlds-close';

let context = null;
let settings = null;

function readWorldWindowState() {
    try {
        const value = JSON.parse(localStorage.getItem(WORLD_WINDOW_STATE_KEY) || '{}');
        return value && typeof value === 'object' ? value : {};
    } catch {
        return {};
    }
}

function writeWorldWindowState(panel) {
    try {
        const rect = panel.getBoundingClientRect();
        localStorage.setItem(WORLD_WINDOW_STATE_KEY, JSON.stringify({
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        }));
    } catch {
        // Storage may be unavailable in private or restricted contexts.
    }
}

function applyWorldWindowState(panel) {
    const state = readWorldWindowState();
    const width = Number.isFinite(state.width) ? Math.max(320, Math.min(state.width, window.innerWidth - 24)) : Math.min(860, window.innerWidth - 48);
    const height = Number.isFinite(state.height) ? Math.max(240, Math.min(state.height, window.innerHeight - 24)) : Math.min(720, window.innerHeight - 48);
    const left = Number.isFinite(state.left) ? Math.max(8, Math.min(state.left, window.innerWidth - width - 8)) : Math.max(8, (window.innerWidth - width) / 2);
    const top = Number.isFinite(state.top) ? Math.max(8, Math.min(state.top, window.innerHeight - height - 8)) : Math.max(8, (window.innerHeight - height) / 2);
    panel.style.setProperty('width', `${width}px`, 'important');
    panel.style.setProperty('height', `${height}px`, 'important');
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}

function closeFloatingWorlds() {
    const panel = document.getElementById('WorldInfo');
    if (!panel) return;
    writeWorldWindowState(panel);
    const icon = document.getElementById('WIDrawerIcon');
    if (panel.classList.contains('openDrawer') && icon instanceof HTMLElement) {
        icon.click();
    } else {
        panel.classList.add('closedDrawer');
        panel.classList.remove('openDrawer');
    }
}

function openFloatingWorlds() {
    const panel = document.getElementById('WorldInfo');
    if (!(panel instanceof HTMLElement)) {
        window.toastr?.warning?.('Worlds/Lorebooks is not available yet.');
        return;
    }

    panel.classList.add(WORLD_WINDOW_CLASS);
    panel.classList.remove('closedDrawer');
    panel.classList.add('openDrawer');
    panel.style.display = 'block';
    applyWorldWindowState(panel);
}

function toggleFloatingWorlds() {
    const panel = document.getElementById('WorldInfo');
    if (panel?.classList.contains('openDrawer') && panel.classList.contains(WORLD_WINDOW_CLASS)) closeFloatingWorlds();
    else openFloatingWorlds();
}

function addWorldWindowResizeHandles(panel) {
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
        writeWorldWindowState(panel);
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
        panel.style.setProperty('width', `${Math.round(width)}px`, 'important');
        panel.style.setProperty('height', `${Math.round(height)}px`, 'important');
    };

    corners.forEach(([corner, label]) => {
        const handle = document.createElement('div');
        handle.className = `${RESIZE_HANDLE_CLASS} stplus-worlds-resize-${corner}`;
        handle.dataset.corner = corner;
        handle.dataset.stplusOwned = '1';
        handle.setAttribute('aria-hidden', 'true');
        handle.title = `Resize floating Worlds/Lorebooks window from the ${label} corner`;
        const startResizing = (event) => {
            if (!panel.classList.contains(WORLD_WINDOW_CLASS)) return;
            if (event.button !== undefined && event.button !== 0) return;
            if (resizeState) return;
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
                minWidth: Number.parseFloat(styles.minWidth) || 0,
                minHeight: Number.parseFloat(styles.minHeight) || 0,
            };
            if (event.pointerId !== undefined) handle.setPointerCapture?.(event.pointerId);
            event.preventDefault();
            event.stopPropagation();
        };
        handle.addEventListener('pointerdown', startResizing);
        handle.addEventListener('mousedown', startResizing);
        handle.addEventListener('pointermove', resize);
        handle.addEventListener('pointerup', stopResizing);
        handle.addEventListener('pointercancel', stopResizing);
        panel.appendChild(handle);
    });

    const resizeWithMouse = (event) => {
        if (resizeState?.pointerId === null) resize(event);
    };
    const stopMouseResize = (event) => {
        if (resizeState?.pointerId === null) stopResizing(event);
    };
    document.addEventListener('mousemove', resizeWithMouse);
    document.addEventListener('mouseup', stopMouseResize);
    document.addEventListener('mouseleave', stopMouseResize);
    const resizeWithPointer = (event) => {
        if (resizeState?.pointerId !== null && resizeState?.pointerId !== undefined) resize(event);
    };
    const stopPointerResize = (event) => {
        if (resizeState?.pointerId !== null && resizeState?.pointerId !== undefined) stopResizing(event);
    };
    document.addEventListener('pointermove', resizeWithPointer);
    document.addEventListener('pointerup', stopPointerResize);
    document.addEventListener('pointercancel', stopPointerResize);
    return () => {
        document.removeEventListener('mousemove', resizeWithMouse);
        document.removeEventListener('mouseup', stopMouseResize);
        document.removeEventListener('mouseleave', stopMouseResize);
        document.removeEventListener('pointermove', resizeWithPointer);
        document.removeEventListener('pointerup', stopPointerResize);
        document.removeEventListener('pointercancel', stopPointerResize);
    };
}

function setupWorldWindow(panel) {
    if (!(panel instanceof HTMLElement) || panel.dataset.stplusWindowReady === '1') return;
    panel.dataset.stplusWindowReady = '1';
    panel.dataset.stplusOriginalStyle = panel.getAttribute('style') ?? '';
    panel._stplusResizeCleanup = addWorldWindowResizeHandles(panel);

    const titleRow = panel.querySelector('#WorldInfoheader')?.nextElementSibling;
    if (titleRow instanceof HTMLElement) {
        titleRow.classList.add('stplus-worlds-title-row');
        const close = document.createElement('button');
        close.type = 'button';
        close.className = `menu_button ${CLOSE_BUTTON_CLASS}`;
        close.title = 'Close floating Worlds/Lorebooks window';
        close.setAttribute('aria-label', close.title);
        close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        close.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeFloatingWorlds();
        });
        titleRow.appendChild(close);

        let dragState = null;
        titleRow.addEventListener('pointerdown', (event) => {
            if (!panel.classList.contains(WORLD_WINDOW_CLASS) || event.target.closest('button, input, select, textarea, a')) return;
            const rect = panel.getBoundingClientRect();
            dragState = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
            titleRow.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });
        titleRow.addEventListener('pointermove', (event) => {
            if (!dragState) return;
            const width = panel.offsetWidth;
            const height = panel.offsetHeight;
            panel.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - dragState.offsetX))}px`;
            panel.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY - dragState.offsetY))}px`;
        });
        const stopDragging = () => {
            if (!dragState) return;
            dragState = null;
            writeWorldWindowState(panel);
        };
        titleRow.addEventListener('pointerup', stopDragging);
        titleRow.addEventListener('pointercancel', stopDragging);
    }

    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => {
            if (panel.classList.contains(WORLD_WINDOW_CLASS)) writeWorldWindowState(panel);
        }).observe(panel);
    }
}

function teardownWorldWindow(panel) {
    if (!(panel instanceof HTMLElement)) return;
    closeFloatingWorlds();
    panel._stplusResizeCleanup?.();
    delete panel._stplusResizeCleanup;
    panel.querySelectorAll(`.${RESIZE_HANDLE_CLASS}, .${CLOSE_BUTTON_CLASS}`).forEach((element) => element.remove());
    panel.querySelector('.stplus-worlds-title-row')?.classList.remove('stplus-worlds-title-row');
    panel.classList.remove(WORLD_WINDOW_CLASS);
    if (panel.dataset.stplusOriginalStyle) panel.setAttribute('style', panel.dataset.stplusOriginalStyle);
    else panel.removeAttribute('style');
    delete panel.dataset.stplusOriginalStyle;
    delete panel.dataset.stplusWindowReady;
}

function installWorldsToolbarButton() {
    const host = document.querySelector('#top-settings-holder') || document.querySelector('#top-bar');
    if (!(host instanceof HTMLElement)) return;
    let button = document.getElementById(WORLD_WINDOW_ID);
    if (!(button instanceof HTMLElement)) {
        button = document.createElement('div');
        button.id = WORLD_WINDOW_ID;
        button.title = 'Open floating Worlds/Lorebooks';
        button.setAttribute('aria-label', button.title);
        button.setAttribute('role', 'button');
        button.setAttribute('tabindex', '0');
        button.addEventListener('click', toggleFloatingWorlds);
        button.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggleFloatingWorlds();
        });
    }
    button.className = 'drawer stplus-worlds-toolbar-button';
    if (!button.querySelector('.stplus-worlds-toolbar-icon')) {
        button.replaceChildren();
        const toggle = document.createElement('div');
        toggle.className = 'drawer-toggle drawer-header';
        const icon = document.createElement('div');
        icon.className = 'drawer-icon fa-solid fa-book-atlas fa-fw closedIcon stplus-worlds-toolbar-icon';
        icon.title = button.title;
        icon.setAttribute('aria-hidden', 'true');
        toggle.appendChild(icon);
        button.appendChild(toggle);
    }
    if (button.parentElement !== host) host.appendChild(button);
}

function removeWorldsToolbarButton() {
    document.getElementById(WORLD_WINDOW_ID)?.remove();
}

function installReasoningSettings() {
    const host = document.getElementById('wiCheckboxes') || document.getElementById('wiActivationSettings');
    if (!(host instanceof HTMLElement)) return;
    let setting = document.getElementById(REASONING_SETTING_ID);
    if (!(setting instanceof HTMLElement)) {
        setting = document.createElement('div');
        setting.id = REASONING_SETTING_ID;
        setting.className = 'stplus-wi-reasoning-setting';

        const label = document.createElement('label');
        label.className = 'checkbox_label';
        label.htmlFor = 'stplus-reasoning-scan-enabled';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = 'stplus-reasoning-scan-enabled';
        checkbox.addEventListener('change', () => {
            settings.reasoningScanEnabled = checkbox.checked;
            save();
            updateReasoningPrompt();
            syncReasoningSettings();
        });
        const text = document.createElement('span');
        text.textContent = 'Include thinking output in World Info scanning';
        label.append(checkbox, text);

        const depthRow = document.createElement('div');
        depthRow.className = 'stplus-wi-reasoning-depth';
        const depthLabel = document.createElement('small');
        depthLabel.textContent = 'Thinking turn scan depth';
        const depth = document.createElement('input');
        depth.type = 'number';
        depth.id = 'stplus-reasoning-scan-depth';
        depth.className = 'neo-range-input';
        depth.min = '1';
        depth.max = '100';
        depth.step = '1';
        depth.title = 'Number of previous assistant reasoning blocks to scan';
        const updateDepth = () => {
            if (depth.value === '') return;
            settings.reasoningScanDepth = normalizeDepth(depth.value);
            depth.value = String(settings.reasoningScanDepth);
            save();
            updateReasoningPrompt();
        };
        depth.addEventListener('input', updateDepth);
        depth.addEventListener('change', updateDepth);
        depthRow.append(depthLabel, depth);
        setting.append(label, depthRow);
        host.appendChild(setting);
    }
    syncReasoningSettings();
}

function syncReasoningSettings() {
    const checkbox = document.getElementById('stplus-reasoning-scan-enabled');
    const depth = document.getElementById('stplus-reasoning-scan-depth');
    if (checkbox) {
        checkbox.checked = settings.reasoningScanEnabled;
        checkbox.disabled = !settings.lorebookModsEnabled;
    }
    if (depth) {
        depth.value = String(settings.reasoningScanDepth);
        depth.disabled = !settings.lorebookModsEnabled || !settings.reasoningScanEnabled;
    }
}

function getReasoningPrompt() {
    const blocks = [];
    const chat = Array.isArray(context.chat) ? context.chat : [];
    for (let index = chat.length - 1; index >= 0 && blocks.length < settings.reasoningScanDepth; index--) {
        const message = chat[index];
        if (message?.is_user === true || message?.is_system === true || message?.role === 'user' || message?.role === 'system') continue;
        const reasoning = String(message?.extra?.reasoning ?? message?.reasoning ?? '').trim();
        if (reasoning) blocks.unshift(reasoning);
    }
    return blocks.join('\n\n');
}

function updateReasoningPrompt() {
    if (!settings.lorebookModsEnabled || !settings.reasoningScanEnabled) {
        context.setExtensionPrompt(REASONING_PROMPT_ID, '', -1, 10000, false);
        return;
    }
    const reasoning = getReasoningPrompt();
    context.setExtensionPrompt(REASONING_PROMPT_ID, reasoning, -1, 10000, Boolean(reasoning));
}

function refresh() {
    installReasoningSettings();
    if (!settings.lorebookModsEnabled) {
        const panel = document.getElementById('WorldInfo');
        if (panel?.classList.contains(WORLD_WINDOW_CLASS)) teardownWorldWindow(panel);
        removeWorldsToolbarButton();
        updateReasoningPrompt();
        syncReasoningSettings();
        return;
    }

    const panel = document.getElementById('WorldInfo');
    if (panel instanceof HTMLElement) setupWorldWindow(panel);
    installWorldsToolbarButton();
    updateReasoningPrompt();
    syncReasoningSettings();
}

export function initialize(stContext, stSettings) {
    context = stContext;
    settings = stSettings;
    context.eventSource?.on?.(context.eventTypes?.GENERATION_STARTED, (_type, _params, isDryRun) => {
        if (!isDryRun) updateReasoningPrompt();
    });
}

export { refresh };
