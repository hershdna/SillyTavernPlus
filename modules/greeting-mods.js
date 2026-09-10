const EXTENSION_CLASS = 'stplus-alt-greeting-reorder';
const CONTROL_CLASS = 'stplus-alt-position-control';
const POPUP_SELECTOR = '.alternate_grettings';

let settings = null;
let controlsBound = false;

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

function swapGreetingValues(list, sourceIndex, targetIndex) {
    const blocks = getGreetingBlocks(list);
    const sourceTextarea = getGreetingTextarea(blocks[sourceIndex]);
    const targetTextarea = getGreetingTextarea(blocks[targetIndex]);
    if (!sourceTextarea || !targetTextarea) return false;

    const sourceValue = sourceTextarea.value;
    sourceTextarea.value = targetTextarea.value;
    targetTextarea.value = sourceValue;
    emitInput(sourceTextarea);
    emitInput(targetTextarea);
    return true;
}

function getPositionInput(event) {
    return event.target instanceof Element
        ? event.target.closest(`.${CONTROL_CLASS} input`)
        : null;
}

function handleNativeMoveClick(event) {
    const target = event.target instanceof Element
        ? event.target.closest('.move_up_alternate_greeting, .move_down_alternate_greeting')
        : null;
    const list = target?.closest('.alternate_greetings_list');
    const popup = target?.closest(POPUP_SELECTOR);
    if (!target || !list || !popup) return;

    const block = target.closest('.alternate_greeting');
    const sourceIndex = getGreetingBlocks(list).indexOf(block);
    const direction = target.classList.contains('move_up_alternate_greeting') ? -1 : 1;
    const targetIndex = sourceIndex + direction;
    const blocks = getGreetingBlocks(list);

    event.preventDefault();
    event.stopPropagation();
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= blocks.length) return;
    swapGreetingValues(list, sourceIndex, targetIndex);
    syncPositionFields(list, true);
}

function bindControls() {
    if (controlsBound) return;

    // These listeners run before SillyTavern's document-level summary and
    // hotkey listeners. The controls are dynamically rendered, so binding at
    // the window also survives greeting-list re-renders and cloned templates.
    window.addEventListener('click', handleNativeMoveClick, true);
    window.addEventListener('keydown', (event) => {
        const input = getPositionInput(event);
        if (!input) return;

        // Do not let SillyTavern's global hotkey handlers consume the edit.
        // Stopping propagation does not cancel the browser's normal text
        // insertion for ordinary keys.
        event.stopPropagation();
        if (event.key !== 'Enter') return;
        event.preventDefault();
        applyRequestedPosition(input);
    }, true);
    window.addEventListener('keyup', (event) => {
        if (getPositionInput(event)) event.stopPropagation();
    }, true);
    controlsBound = true;
}

function reorderGreetingValues(list, sourceIndex, targetIndex) {
    const direction = targetIndex < sourceIndex ? -1 : 1;
    let currentIndex = sourceIndex;
    while (currentIndex !== targetIndex) {
        if (!swapGreetingValues(list, currentIndex, currentIndex + direction)) return false;
        currentIndex += direction;
    }
    return true;
}

function syncPositionFields(list, force = false) {
    const blocks = getGreetingBlocks(list);
    blocks.forEach((block, index) => {
        const input = block.querySelector(`.${CONTROL_CLASS} input`);
        if (!input) return;
        input.max = String(blocks.length);
        if (force || document.activeElement !== input) input.value = String(index + 1);
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
        syncPositionFields(list, true);
        return { ok: true, moved: false, message: 'Already in that position.' };
    }

    reorderGreetingValues(list, sourceIndex, targetIndex);

    syncPositionFields(list, true);
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

function createPositionControl(block) {
    const control = document.createElement('div');
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
        const details = block.querySelector('details');
        const summary = details?.querySelector(':scope > summary');
        if (!details || !summary) return;
        // Keep interactive editing controls out of <summary>. Summary is a
        // disclosure control and SillyTavern attaches global click/keyboard
        // handlers to it, which can prevent focus and text entry.
        details.insertBefore(createPositionControl(block), summary.nextSibling);
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
    bindControls();
}

export function refresh() {
    if (!settings) return;

    document.querySelectorAll(POPUP_SELECTOR).forEach((popup) => {
        if (settings.greetingModsEnabled) decorateGreetingPopup(popup);
        else undecorateGreetingPopup(popup);
    });
}

