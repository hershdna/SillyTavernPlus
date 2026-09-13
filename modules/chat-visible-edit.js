const EDITING_CLASS = 'stplus-visible-editing';
const ACTIONS_CLASS = 'stplus-visible-edit-actions';

let context = null;
let settings = null;
let activeEdit = null;
let listenersBound = false;

function isEnabled() {
    return settings?.formattedMessageEditEnabled !== false;
}

function getChat() {
    return Array.isArray(context?.chat) ? context.chat : [];
}

function getMessageId(messageElement) {
    const value = Number.parseInt(messageElement?.getAttribute('mesid') ?? '', 10);
    return Number.isInteger(value) && value >= 0 ? value : null;
}

function restoreAttributes(edit) {
    const { messageText, originalContentEditable, originalSpellcheck, originalRole, originalAriaLabel } = edit;
    if (!messageText.isConnected) return;
    if (originalContentEditable === null) messageText.removeAttribute('contenteditable');
    else messageText.setAttribute('contenteditable', originalContentEditable);
    if (originalSpellcheck === null) messageText.removeAttribute('spellcheck');
    else messageText.setAttribute('spellcheck', originalSpellcheck);
    if (originalRole === null) messageText.removeAttribute('role');
    else messageText.setAttribute('role', originalRole);
    if (originalAriaLabel === null) messageText.removeAttribute('aria-label');
    else messageText.setAttribute('aria-label', originalAriaLabel);
}

function removeEditUi(edit, restoreContent) {
    if (!edit) return;
    const { messageElement, messageText, actions, originalHTML } = edit;
    if (messageText.isConnected) {
        if (restoreContent) messageText.innerHTML = originalHTML;
        restoreAttributes(edit);
        messageText.classList.remove('stplus-visible-edit-editor');
    }
    messageElement?.classList.remove(EDITING_CLASS);
    actions?.remove();
}

function cancelEdit() {
    if (!activeEdit) return;
    const edit = activeEdit;
    activeEdit = null;
    removeEditUi(edit, true);
}

function getCaretRangeAtPoint(editor, clientX, clientY) {
    const range = document.caretRangeFromPoint?.(clientX, clientY);
    if (range && editor.contains(range.startContainer)) return range;
    const position = document.caretPositionFromPoint?.(clientX, clientY);
    if (position && editor.contains(position.offsetNode)) {
        const fallbackRange = document.createRange();
        fallbackRange.setStart(position.offsetNode, position.offset);
        fallbackRange.collapse(true);
        return fallbackRange;
    }
    return null;
}

function placeCaret(editor, event) {
    const selection = window.getSelection?.();
    if (!selection) return;
    const range = getCaretRangeAtPoint(editor, event.clientX, event.clientY);
    selection.removeAllRanges();
    if (range) {
        selection.addRange(range);
        return;
    }
    const endRange = document.createRange();
    endRange.selectNodeContents(editor);
    endRange.collapse(false);
    selection.addRange(endRange);
}

function createAction(iconClass, title, onClick) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = `menu_button ${iconClass} interactable stplus-visible-edit-action`;
    action.title = title;
    action.setAttribute('aria-label', title);
    action.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
    });
    return action;
}

function syncMessageSwipe(message, text) {
    if (!Array.isArray(message?.swipes) || message.swipes.length === 0) return;
    const swipeId = Number.parseInt(message.swipe_id, 10);
    const index = Number.isInteger(swipeId) && swipeId >= 0 && swipeId < message.swipes.length ? swipeId : 0;
    message.swipes[index] = text;
}

async function emitMessageEvent(name, messageId) {
    const eventName = context?.eventTypes?.[name];
    if (!eventName || typeof context?.eventSource?.emit !== 'function') return;
    try {
        await context.eventSource.emit(eventName, messageId);
    } catch (error) {
        console.warn(`[SillyTavernPlus] Could not emit ${name} after visible message edit.`, error);
    }
}

async function saveChat() {
    try {
        if (typeof context?.saveChatConditional === 'function') await context.saveChatConditional();
        else if (typeof context?.saveMetadata === 'function') await context.saveMetadata();
        else context?.saveChatDebounced?.();
    } catch (error) {
        console.warn('[SillyTavernPlus] Could not save visible message edit.', error);
    }
}

async function confirmEdit() {
    const edit = activeEdit;
    if (!edit) return;
    activeEdit = null;
    const message = getChat()[edit.messageId];
    if (!message) {
        removeEditUi(edit, true);
        return;
    }

    // plaintext-only keeps the existing rendered elements (em, strong, color
    // tags, comments, and so on) in place while preventing the user from
    // changing formatting through the browser editing surface.
    const text = edit.messageText.innerHTML;
    message.mes = text;
    syncMessageSwipe(message, text);
    if (message.extra && Object.prototype.hasOwnProperty.call(message.extra, 'display_text')) {
        message.extra.display_text = text;
    }
    removeEditUi(edit, false);
    await emitMessageEvent('MESSAGE_EDITED', edit.messageId);
    await emitMessageEvent('MESSAGE_UPDATED', edit.messageId);
    await saveChat();
}

function beginEdit(messageElement, messageText, event) {
    if (!isEnabled()) return;
    const messageId = getMessageId(messageElement);
    if (messageId === null || !getChat()[messageId]) return;
    if (activeEdit) {
        if (activeEdit.messageElement === messageElement) return;
        cancelEdit();
    }

    const edit = {
        messageId,
        messageElement,
        messageText,
        originalHTML: messageText.innerHTML,
        originalContentEditable: messageText.getAttribute('contenteditable'),
        originalSpellcheck: messageText.getAttribute('spellcheck'),
        originalRole: messageText.getAttribute('role'),
        originalAriaLabel: messageText.getAttribute('aria-label'),
        actions: null,
    };
    const confirm = createAction('fa-solid fa-check', 'Confirm', confirmEdit);
    const cancel = createAction('fa-solid fa-xmark', 'Cancel', cancelEdit);
    const actions = document.createElement('div');
    actions.className = ACTIONS_CLASS;
    actions.append(confirm, cancel);
    edit.actions = actions;

    messageElement.classList.add(EDITING_CLASS);
    messageText.classList.add('stplus-visible-edit-editor');
    messageText.setAttribute('contenteditable', 'plaintext-only');
    messageText.setAttribute('spellcheck', 'false');
    messageText.setAttribute('role', 'textbox');
    messageText.setAttribute('aria-label', `Edit message ${messageId + 1}`);
    messageText.closest('.mes_block')?.appendChild(actions);
    activeEdit = edit;

    event.preventDefault();
    event.stopPropagation();
    messageText.focus({ preventScroll: true });
    placeCaret(messageText, event);
}

function handleDoubleClick(event) {
    if (!isEnabled()) return;
    if (event.target instanceof Element && event.target.closest(`.${ACTIONS_CLASS}`)) return;
    const messageText = event.target instanceof Element ? event.target.closest('.mes .mes_text') : null;
    if (!(messageText instanceof HTMLElement)) return;
    const messageElement = messageText.closest('.mes');
    if (!(messageElement instanceof HTMLElement)) return;
    beginEdit(messageElement, messageText, event);
}

function bindLifecycleEvents() {
    if (listenersBound) return;
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes;
    if (!eventSource || !eventTypes || typeof eventSource.on !== 'function') return;
    ['CHAT_CHANGED', 'CHAT_LOADED', 'CHAT_CREATED', 'CHAT_DELETED'].forEach((name) => {
        const eventName = eventTypes[name];
        if (eventName) eventSource.on(eventName, cancelEdit);
    });
    listenersBound = true;
}

export function initialize(stContext, stSettings) {
    context = stContext;
    settings = stSettings;
    document.addEventListener('dblclick', handleDoubleClick, true);
    bindLifecycleEvents();
}

export function refresh() {
    if (!isEnabled()) cancelEdit();
}
