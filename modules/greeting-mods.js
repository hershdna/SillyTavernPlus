const EXTENSION_CLASS = 'stplus-alt-greeting-reorder';
const CONTROL_CLASS = 'stplus-alt-position-control';
const POPUP_SELECTOR = '.alternate_grettings';

let settings = null;

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

function getNativeMoveButton(block, direction) {
    const selector = direction < 0 ? '.move_up_alternate_greeting' : '.move_down_alternate_greeting';
    return block?.querySelector(selector);
}

function moveWithNativeControls(list, sourceIndex, targetIndex) {
    const direction = targetIndex < sourceIndex ? -1 : 1;
    let currentIndex = sourceIndex;
    const blocks = getGreetingBlocks(list);

    // Do not partially use the native path: the fallback path starts from the
    // original order, so every required native control must be present first.
    for (let index = sourceIndex; index !== targetIndex; index += direction) {
        if (!getNativeMoveButton(blocks[index], direction)) return false;
    }

    while (currentIndex !== targetIndex) {
        const currentBlock = blocks[currentIndex];
        const nativeButton = getNativeMoveButton(currentBlock, direction);
        if (!nativeButton) return false;

        // SillyTavern's native handler updates both its backing array and the
        // two textareas involved. Moving the block that now contains the
        // original greeting is important because native data-index values do
        // not change when the values are swapped.
        nativeButton.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
        }));
        currentIndex += direction;
    }

    return true;
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

    if (!moveWithNativeControls(list, sourceIndex, targetIndex)) {
        const values = blocks.map(getGreetingTextarea).map((textarea) => textarea?.value ?? '');
        const [moved] = values.splice(sourceIndex, 1);
        values.splice(targetIndex, 0, moved);

        blocks.forEach((block, index) => {
            const textarea = getGreetingTextarea(block);
            if (!textarea) return;
            textarea.value = values[index];
            emitInput(textarea);
        });
    }

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
    event.preventDefault();
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

function undecorateGreetingPopup(popup) {
    popup.querySelectorAll(`.${CONTROL_CLASS}`).forEach((control) => control.remove());
    popup.querySelectorAll('.stplus-alt-reorder-status').forEach((status) => status.remove());
    popup.classList.remove(EXTENSION_CLASS);
}

export function initialize(stSettings) {
    settings = stSettings;
}

export function refresh() {
    if (!settings) return;

    document.querySelectorAll(POPUP_SELECTOR).forEach((popup) => {
        if (settings.greetingModsEnabled) decorateGreetingPopup(popup);
        else undecorateGreetingPopup(popup);
    });
}

