(() => {
    'use strict';

    const EXTENSION_CLASS = 'stplus-alt-greeting-reorder';
    const CONTROL_CLASS = 'stplus-alt-position-control';
    const WORLD_WINDOW_CLASS = 'stplus-floating-worlds';
    const WORLD_WINDOW_ID = 'stplus-worlds-button';
    const WORLD_WINDOW_STATE_KEY = 'stplus.worldsWindow';
    const POPUP_SELECTOR = '.alternate_grettings';

    function getGreetingList(popup) {
        return popup?.querySelector('.alternate_greetings_list');
    }

    function getGreetingBlocks(list) {
        return Array.from(list?.querySelectorAll(':scope > .alternate_greeting') ?? []);
    }

    function getGreetingTextarea(block) {
        return block?.querySelector('.alternate_greeting_text');
    }

    function showStatus(popup, message, isError = false) {
        let status = popup.querySelector('.stplus-alt-reorder-status');
        if (!status) {
            status = document.createElement('small');
            status.className = 'stplus-alt-reorder-status';
            popup.querySelector('.alternate_greetings_list')?.before(status);
        }

        status.textContent = message;
        status.classList.toggle('error', isError);
        clearTimeout(status._stplusTimer);
        status._stplusTimer = setTimeout(() => {
            status.textContent = '';
            status.classList.remove('error');
        }, 2400);
    }

    function emitInput(textarea) {
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function syncPositionFields(list) {
        const blocks = getGreetingBlocks(list);
        blocks.forEach((block, index) => {
            const input = block.querySelector(`.${CONTROL_CLASS} input`);
            if (!input) return;
            input.max = String(blocks.length);
            input.value = String(index + 1);
            input.setAttribute('aria-label', `Move alternate greeting ${index + 1} to position`);
        });
    }

    function reorderGreeting(list, sourceIndex, requestedPosition) {
        const blocks = getGreetingBlocks(list);
        const targetIndex = requestedPosition - 1;
        if (sourceIndex < 0 || sourceIndex >= blocks.length || targetIndex < 0 || targetIndex >= blocks.length) {
            return { ok: false, message: `Choose a position from 1 to ${blocks.length}.` };
        }
        if (sourceIndex === targetIndex) {
            syncPositionFields(list);
            return { ok: true, moved: false, message: 'Already in that position.' };
        }

        const values = blocks.map(getGreetingTextarea).map((textarea) => textarea?.value ?? '');
        const [moved] = values.splice(sourceIndex, 1);
        values.splice(targetIndex, 0, moved);

        blocks.forEach((block, index) => {
            const textarea = getGreetingTextarea(block);
            if (!textarea) return;
            textarea.value = values[index];
            emitInput(textarea);
        });

        syncPositionFields(list);
        return { ok: true, moved: true, message: `Moved greeting ${sourceIndex + 1} to position ${requestedPosition}.` };
    }

    function applyRequestedPosition(input) {
        const block = input.closest('.alternate_greeting');
        const list = input.closest('.alternate_greetings_list');
        const popup = input.closest(POPUP_SELECTOR);
        const blocks = getGreetingBlocks(list);
        const sourceIndex = blocks.indexOf(block);
        const requestedPosition = Number.parseInt(input.value, 10);

        if (!Number.isInteger(requestedPosition)) {
            syncPositionFields(list);
            showStatus(popup, `Choose a position from 1 to ${blocks.length}.`, true);
            return;
        }

        const result = reorderGreeting(list, sourceIndex, requestedPosition);
        if (!result.ok) {
            syncPositionFields(list);
            showStatus(popup, result.message, true);
            return;
        }
        showStatus(popup, result.message);
    }

    function stopSummaryToggle(event) {
        event.stopPropagation();
    }

    function createPositionControl(block) {
        const control = document.createElement('span');
        control.className = CONTROL_CLASS;
        control.title = 'Type a position and press Enter to move this greeting';

        const label = document.createElement('span');
        label.textContent = 'Position';
        label.className = 'stplus-alt-position-label';

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'text_pole stplus-alt-position-input';
        input.min = '1';
        input.step = '1';
        input.inputMode = 'numeric';
        input.autocomplete = 'off';

        const moveButton = document.createElement('button');
        moveButton.type = 'button';
        moveButton.className = 'menu_button menu_button_icon stplus-alt-position-apply';
        moveButton.innerHTML = '<i class="fa-solid fa-arrow-right"></i><span>Move</span>';

        [input, moveButton].forEach((element) => {
            element.addEventListener('pointerdown', stopSummaryToggle);
            element.addEventListener('click', stopSummaryToggle);
        });
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            applyRequestedPosition(input);
        });
        input.addEventListener('change', () => applyRequestedPosition(input));
        moveButton.addEventListener('click', () => applyRequestedPosition(input));

        control.append(label, input, moveButton);
        return control;
    }

    function decorateGreetingPopup(popup) {
        const list = getGreetingList(popup);
        if (!list) return;

        popup.classList.add(EXTENSION_CLASS);
        getGreetingBlocks(list).forEach((block) => {
            if (block.querySelector(`.${CONTROL_CLASS}`)) return;
            const title = block.querySelector('summary .title_restorable');
            const expander = title?.querySelector('.expander');
            if (!title) return;
            title.insertBefore(createPositionControl(block), expander ?? null);
        });
        syncPositionFields(list);
    }

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
        panel.style.width = `${width}px`;
        panel.style.height = `${height}px`;
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
        if (panel?.classList.contains('openDrawer') && panel.classList.contains(WORLD_WINDOW_CLASS)) {
            closeFloatingWorlds();
        } else {
            openFloatingWorlds();
        }
    }

    function setupWorldWindow(panel) {
        if (!(panel instanceof HTMLElement) || panel.dataset.stplusWindowReady === '1') return;
        panel.dataset.stplusWindowReady = '1';

        const titleRow = panel.querySelector('#WorldInfoheader')?.nextElementSibling;
        if (titleRow instanceof HTMLElement) {
            titleRow.classList.add('stplus-worlds-title-row');
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'menu_button stplus-worlds-close';
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

        if (button.parentElement !== host || host.lastElementChild !== button) host.appendChild(button);
    }

    function scan() {
        document.querySelectorAll(POPUP_SELECTOR).forEach(decorateGreetingPopup);
        const worldPanel = document.getElementById('WorldInfo');
        if (worldPanel) setupWorldWindow(worldPanel);
        installWorldsToolbarButton();
    }

    function initialize() {
        scan();
        const observer = new MutationObserver(scan);
        observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', () => {
            const panel = document.getElementById('WorldInfo');
            if (panel?.classList.contains(WORLD_WINDOW_CLASS)) applyWorldWindowState(panel);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
