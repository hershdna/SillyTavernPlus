(() => {
    'use strict';

    const EXTENSION_CLASS = 'gp-alt-greeting-reorder';
    const CONTROL_CLASS = 'gp-alt-position-control';
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
        let status = popup.querySelector('.gp-alt-reorder-status');
        if (!status) {
            status = document.createElement('small');
            status.className = 'gp-alt-reorder-status';
            popup.querySelector('.alternate_greetings_list')?.before(status);
        }

        status.textContent = message;
        status.classList.toggle('error', isError);
        clearTimeout(status._gpTimer);
        status._gpTimer = setTimeout(() => {
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
            const input = block.querySelector('.gp-alt-position-input');
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

        // Keep the native editor's DOM order intact. Its input handlers capture
        // each original array index, so rewrite the textarea values in place and
        // emit input events to update SillyTavern's own in-memory array.
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
        label.className = 'gp-alt-position-label';

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'text_pole gp-alt-position-input';
        input.min = '1';
        input.step = '1';
        input.inputMode = 'numeric';
        input.autocomplete = 'off';

        const moveButton = document.createElement('button');
        moveButton.type = 'button';
        moveButton.className = 'menu_button menu_button_icon gp-alt-position-apply';
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

    function decoratePopup(popup) {
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

    function scan() {
        document.querySelectorAll(POPUP_SELECTOR).forEach(decoratePopup);
    }

    function initialize() {
        scan();
        const observer = new MutationObserver(() => scan());
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
