import { normalizeDepth, save } from './settings-store.js';

const WORLD_WINDOW_CLASS = 'stplus-floating-worlds';
const WORLD_WINDOW_STATE_KEY = 'stplus.worldsWindow';
const WORLD_WINDOW_MIGRATED_KEY = 'stplus.worldsWindow.nativeStateMigrated';
const REASONING_PROMPT_ID = 'SillyTavernPlusReasoning';
const REASONING_SETTING_ID = 'stplus-reasoning-scan-setting';
const RESIZE_HANDLE_CLASS = 'stplus-worlds-resize-handle';
const CLOSE_BUTTON_CLASS = 'stplus-worlds-close';

let context = null;
let settings = null;

function migrateWorldWindowState() {
    const power = context?.powerUserSettings;
    if (!power) return;
    try {
        if (localStorage.getItem(WORLD_WINDOW_MIGRATED_KEY)) return;
        const legacy = JSON.parse(localStorage.getItem(WORLD_WINDOW_STATE_KEY) || '{}');
        power.movingUIState ??= {};
        // Never replace native/preset geometry with the older standalone record.
        if (!power.movingUIState.WorldInfo && ['left', 'top', 'width', 'height'].every(key => Number.isFinite(legacy[key]))) {
            power.movingUIState.WorldInfo = { ...legacy, right: 'unset', bottom: 'unset', margin: 'unset', transform: 'none' };
            context.saveSettingsDebounced?.();
        }
        localStorage.setItem(WORLD_WINDOW_MIGRATED_KEY, '1');
    } catch { /* Native state remains authoritative when local storage is unavailable. */ }
}

function readWorldWindowState() {
    return context?.powerUserSettings?.movingUIState?.WorldInfo ?? {};
}

function writeWorldWindowState(panel) {
    const power = context?.powerUserSettings;
    if (!power?.movingUI || !panel.classList.contains(WORLD_WINDOW_CLASS)) return;
    const rect = panel.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    power.movingUIState ??= {};
    power.movingUIState.WorldInfo = { ...readWorldWindowState(),
        left: Math.round(rect.left), top: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
        right: 'unset', bottom: 'unset', margin: 'unset', transform: 'none' };
    context.saveSettingsDebounced?.();
}

function applyWorldWindowState(panel) {
    const state = context?.powerUserSettings?.movingUI ? readWorldWindowState() : {};
    const valid = (key, fallback) => state[key] !== null && state[key] !== undefined
        && Number.isFinite(Number(state[key])) && (!['width', 'height'].includes(key) || Number(state[key]) > 0)
        ? Number(state[key]) : fallback;
    const width = valid('width', Math.min(860, window.innerWidth - 48));
    const height = valid('height', Math.min(720, window.innerHeight - 48));
    const left = valid('left', Math.max(8, (window.innerWidth - width) / 2));
    const top = valid('top', Math.max(8, (window.innerHeight - height) / 2));
    for (const [key, value] of Object.entries({ width, height, left, top })) panel.style.setProperty(key, `${value}px`);
    panel.style.right = 'unset';
    panel.style.bottom = 'unset';
    panel._stplusSyncWorldResizeHandles?.();
}

function closeFloatingWorlds() {
    const panel = document.getElementById('WorldInfo');
    if (!panel) return;
    writeWorldWindowState(panel);
    panel.classList.add('closedDrawer');
    panel.classList.remove('openDrawer', WORLD_WINDOW_CLASS);
    panel.style.display = 'none';
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

function addWorldWindowResizeHandles(panel) {
    const corners = [
        ['nw', 'top left'],
        ['ne', 'top right'],
        ['sw', 'bottom left'],
        ['se', 'bottom right'],
    ];
    let resizeState = null;
    const handleElements = [];
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    // World Info is itself the scroll container. Absolute children otherwise
    // move with the scrolled content, putting the resize handles away from the
    // visible panel corners. Keep their positions in the panel's viewport,
    // while still leaving them inside the panel so they move with the window.
    const syncHandlePositions = () => {
        const scrollTop = panel.scrollTop;
        const handleSize = handleElements[0]?.offsetHeight || 14;
        const bottomTop = scrollTop + Math.max(0, panel.clientHeight - handleSize);
        handleElements.forEach((handle) => {
            const isBottom = handle.dataset.corner?.includes('s');
            handle.style.top = `${Math.round(isBottom ? bottomTop : scrollTop)}px`;
            handle.style.bottom = 'auto';
        });
    };

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

        panel.style.setProperty('left', `${Math.round(left)}px`);
        panel.style.setProperty('top', `${Math.round(top)}px`);
        panel.style.setProperty('width', `${Math.round(width)}px`);
        panel.style.setProperty('height', `${Math.round(height)}px`);
        syncHandlePositions();
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
            if (resizeState) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
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
                minWidth: Number.parseFloat(styles.minWidth) || 0,
                minHeight: Number.parseFloat(styles.minHeight) || 0,
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
        handleElements.push(handle);
    });

    panel.addEventListener('scroll', syncHandlePositions, { passive: true });
    panel._stplusSyncWorldResizeHandles = syncHandlePositions;
    syncHandlePositions();

    const resizeWithMouse = (event) => {
        if (resizeState?.pointerId === null) resize(event);
    };
    const stopMouseResize = (event) => {
        if (resizeState?.pointerId === null) stopResizing(event);
    };
    document.addEventListener('mousemove', resizeWithMouse);
    document.addEventListener('mouseup', stopMouseResize);
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
        document.removeEventListener('pointermove', resizeWithPointer);
        document.removeEventListener('pointerup', stopPointerResize);
        document.removeEventListener('pointercancel', stopPointerResize);
        panel.removeEventListener('scroll', syncHandlePositions);
        if (panel._stplusSyncWorldResizeHandles === syncHandlePositions) delete panel._stplusSyncWorldResizeHandles;
    };
}

function setupWorldWindow(panel) {
    if (!(panel instanceof HTMLElement) || panel.dataset.stplusWindowReady === '1') return;
    panel.dataset.stplusWindowReady = '1';
    panel.dataset.stplusOriginalStyle = panel.getAttribute('style') ?? '';
    panel._stplusResizeCleanup = addWorldWindowResizeHandles(panel);

    const nativeWorldInfoIcon = document.getElementById('WIDrawerIcon');
    if (nativeWorldInfoIcon instanceof HTMLElement && nativeWorldInfoIcon.dataset.stplusToggleReady !== '1') {
        nativeWorldInfoIcon.dataset.stplusToggleReady = '1';
        nativeWorldInfoIcon.addEventListener('click', () => {
            window.setTimeout(() => {
                if (!settings.lorebookModsEnabled) return;
                if (panel.classList.contains('openDrawer')) openFloatingWorlds();
                else closeFloatingWorlds();
            }, 0);
        });
    }

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

    }

    if (typeof ResizeObserver === 'function') {
        panel._stplusWorldResizeObserver = new ResizeObserver(() => panel._stplusSyncWorldResizeHandles?.());
        panel._stplusWorldResizeObserver.observe(panel);
    }
}

function teardownWorldWindow(panel) {
    if (!(panel instanceof HTMLElement)) return;
    closeFloatingWorlds();
    panel._stplusResizeCleanup?.();
    panel._stplusWorldResizeObserver?.disconnect();
    delete panel._stplusWorldResizeObserver;
    delete panel._stplusResizeCleanup;
    panel.querySelectorAll(`.${RESIZE_HANDLE_CLASS}, .${CLOSE_BUTTON_CLASS}`).forEach((element) => element.remove());
    panel.querySelector('.stplus-worlds-title-row')?.classList.remove('stplus-worlds-title-row');
    panel.classList.remove(WORLD_WINDOW_CLASS);
    if (panel.dataset.stplusOriginalStyle) panel.setAttribute('style', panel.dataset.stplusOriginalStyle);
    else panel.removeAttribute('style');
    delete panel.dataset.stplusOriginalStyle;
    delete panel.dataset.stplusWindowReady;
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
        label.className = 'checkbox_label flex1';
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
        const text = document.createElement('small');
        text.className = 'whitespacenowrap flex1';
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
    } else if (setting.parentElement !== host) {
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
        if (panel?.dataset.stplusWindowReady === '1') teardownWorldWindow(panel);
        updateReasoningPrompt();
        syncReasoningSettings();
        return;
    }

    const panel = document.getElementById('WorldInfo');
    if (panel instanceof HTMLElement) setupWorldWindow(panel);
    updateReasoningPrompt();
    syncReasoningSettings();
}

export function initialize(stContext, stSettings) {
    context = stContext;
    settings = stSettings;
    migrateWorldWindowState();
    context.eventSource?.on?.(context.eventTypes?.GENERATION_STARTED, (_type, _params, isDryRun) => {
        if (!isDryRun) updateReasoningPrompt();
    });
}

export { refresh };
