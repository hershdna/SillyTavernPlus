const EDITING_CLASS = 'stplus-visible-editing';
const ACTIONS_CLASS = 'stplus-visible-edit-actions';
const ACTION_HOST_CLASS = 'stplus-visible-edit-action-host';

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

function getEditableTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest('script, style')) continue;

        let hidden = false;
        for (let element = parent; element && element !== root; element = element.parentElement) {
            const styles = getComputedStyle(element);
            if (styles.display === 'none' || styles.visibility === 'hidden') {
                hidden = true;
                break;
            }
        }
        if (!hidden && node.nodeValue) nodes.push(node);
    }
    return nodes;
}

function collectRenderedText(root) {
    return getEditableTextNodes(root).map((node) => node.nodeValue).join('');
}

function maskSourceMarkup(source) {
    const masked = source.split('');
    const mask = (start, end) => {
        for (let index = start; index < end; index++) masked[index] = '\0';
    };

    for (let index = 0; index < source.length; index++) {
        if (source.startsWith('<!--', index)) {
            const end = source.indexOf('-->', index + 4);
            const boundary = end === -1 ? source.length : end + 3;
            mask(index, boundary);
            index = boundary - 1;
            continue;
        }

        // Mask HTML tags while leaving Markdown syntax intact. The latter is
        // important because the visible word in `*emphasis*` still exists in
        // the source and can be mapped without removing its delimiters.
        if (source[index] === '<' && /[A-Za-z/!?]/.test(source[index + 1] ?? '')) {
            const end = source.indexOf('>', index + 1);
            if (end !== -1) {
                mask(index, end + 1);
                index = end;
            }
        }
    }
    return masked.join('');
}

function buildRenderedSourceMap(source, root) {
    const sourceView = maskSourceMarkup(source);
    const segments = [];
    const nodes = getEditableTextNodes(root);
    let renderedOffset = 0;
    let sourceCursor = 0;

    for (const node of nodes) {
        const text = node.nodeValue;
        const sourceStart = sourceView.indexOf(text, sourceCursor);
        const mapped = sourceStart !== -1;
        const segment = {
            renderedStart: renderedOffset,
            renderedEnd: renderedOffset + text.length,
            sourceStart: mapped ? sourceStart : null,
            sourceEnd: mapped ? sourceStart + text.length : null,
        };
        segments.push(segment);
        renderedOffset += text.length;
        if (mapped) sourceCursor = segment.sourceEnd;
    }

    return {
        renderedText: nodes.map((node) => node.nodeValue).join(''),
        segments,
        complete: segments.every((segment) => segment.sourceStart !== null),
    };
}

function getSourceBoundary(sourceMap, renderedOffset, preferEnd = false) {
    for (const segment of sourceMap.segments) {
        if (renderedOffset < segment.renderedStart || renderedOffset > segment.renderedEnd) continue;
        const offset = renderedOffset - segment.renderedStart;
        return segment.sourceStart + offset;
    }

    const mappedSegments = sourceMap.segments.filter((segment) => segment.sourceStart !== null);
    if (!mappedSegments.length) return null;
    return preferEnd ? mappedSegments.at(-1).sourceEnd : mappedSegments[0].sourceStart;
}

function getVisibleTextHunk(before, after) {
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;

    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
        beforeEnd--;
        afterEnd--;
    }

    return {
        renderedStart: start,
        renderedEnd: beforeEnd,
        insertedText: after.slice(start, afterEnd),
    };
}

function escapeInsertedText(text) {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function applyVisibleTextEdit(edit, currentRenderedText) {
    if (currentRenderedText === edit.sourceMap.renderedText) return edit.originalSource;
    if (!edit.sourceMap.complete) {
        throw new Error('Could not map the rendered message back to its source text.');
    }

    const hunk = getVisibleTextHunk(edit.sourceMap.renderedText, currentRenderedText);
    const ranges = edit.sourceMap.segments
        .filter((segment) => segment.renderedStart < hunk.renderedEnd && segment.renderedEnd > hunk.renderedStart)
        .map((segment) => ({
            start: segment.sourceStart + Math.max(hunk.renderedStart, segment.renderedStart) - segment.renderedStart,
            end: segment.sourceStart + Math.min(hunk.renderedEnd, segment.renderedEnd) - segment.renderedStart,
        }));
    const insertedText = escapeInsertedText(hunk.insertedText);

    if (!ranges.length) {
        const sourceBoundary = getSourceBoundary(edit.sourceMap, hunk.renderedStart);
        if (sourceBoundary === null) throw new Error('Could not locate the edit in the source text.');
        return edit.originalSource.slice(0, sourceBoundary) + insertedText + edit.originalSource.slice(sourceBoundary);
    }

    let result = '';
    let sourceCursor = 0;
    let inserted = false;
    for (const range of ranges) {
        result += edit.originalSource.slice(sourceCursor, range.start);
        if (!inserted) {
            result += insertedText;
            inserted = true;
        }
        sourceCursor = range.end;
    }
    return result + edit.originalSource.slice(sourceCursor);
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
    edit.editorListeners?.forEach(([eventName, handler]) => messageText.removeEventListener(eventName, handler));
    if (messageText.isConnected) {
        if (restoreContent) messageText.innerHTML = originalHTML;
        restoreAttributes(edit);
        messageText.classList.remove('stplus-visible-edit-editor');
    }
    messageElement?.classList.remove(EDITING_CLASS);
    actions?.remove();
}

function insertPlainText(editor, text) {
    const selection = window.getSelection?.();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(text.replace(/\r\n?/g, '\n'));
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function bindEditorGuards(edit) {
    const editor = edit.messageText;
    const editorListeners = [];
    const onBeforeInput = (event) => {
        if (event.inputType?.startsWith('format') || event.inputType === 'insertHTML') event.preventDefault();
    };
    const onKeyDown = (event) => {
        if ((event.ctrlKey || event.metaKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) event.preventDefault();
    };
    const onPaste = (event) => {
        event.preventDefault();
        insertPlainText(editor, event.clipboardData?.getData('text/plain') ?? '');
    };
    const onDrop = (event) => event.preventDefault();
    [['beforeinput', onBeforeInput], ['keydown', onKeyDown], ['paste', onPaste], ['drop', onDrop]].forEach(([eventName, handler]) => {
        editor.addEventListener(eventName, handler);
        editorListeners.push([eventName, handler]);
    });
    edit.editorListeners = editorListeners;
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

function getActionHost(messageElement) {
    // Keep the edit controls in the message header. The footer of a message
    // is occupied by SillyTavern's swipe controls, so appending controls to
    // .mes_block can put the cancel button on top of the swipe arrow/counter.
    const headers = [
        ...messageElement.querySelectorAll('.mes_block > .ch_name, .ch_name'),
    ];
    return headers.find((header) => {
        const styles = getComputedStyle(header);
        return styles.display !== 'none' && styles.visibility !== 'hidden';
    }) ?? messageElement.querySelector('.mes_block') ?? messageElement;
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

    // Keep SillyTavern's original source intact and apply only the visible
    // text delta. Saving messageText.innerHTML would flatten Markdown,
    // discard comments, and cause the next messageFormatting pass to wrap
    // already-rendered quotes a second time.
    let text;
    try {
        text = applyVisibleTextEdit(edit, collectRenderedText(edit.messageText));
    } catch (error) {
        console.warn('[SillyTavernPlus] Could not preserve message formatting while saving.', error);
        removeEditUi(edit, true);
        return;
    }

    if (edit.sourceKey === 'display_text') {
        message.extra.display_text = text;
    } else {
        message.mes = text;
        syncMessageSwipe(message, text);
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
        originalSource: Object.prototype.hasOwnProperty.call(message.extra ?? {}, 'display_text')
            ? String(message.extra.display_text ?? '')
            : String(message.mes ?? ''),
        sourceKey: Object.prototype.hasOwnProperty.call(message.extra ?? {}, 'display_text') ? 'display_text' : 'mes',
        originalContentEditable: messageText.getAttribute('contenteditable'),
        originalSpellcheck: messageText.getAttribute('spellcheck'),
        originalRole: messageText.getAttribute('role'),
        originalAriaLabel: messageText.getAttribute('aria-label'),
        actions: null,
        editorListeners: [],
    };
    edit.sourceMap = buildRenderedSourceMap(edit.originalSource, messageText);
    const confirm = createAction('fa-solid fa-check', 'Confirm', confirmEdit);
    const cancel = createAction('fa-solid fa-xmark', 'Cancel', cancelEdit);
    const actions = document.createElement('div');
    actions.className = `${ACTIONS_CLASS} ${ACTION_HOST_CLASS}`;
    actions.append(confirm, cancel);
    edit.actions = actions;

    messageElement.classList.add(EDITING_CLASS);
    messageText.classList.add('stplus-visible-edit-editor');
    messageText.setAttribute('contenteditable', 'true');
    messageText.setAttribute('spellcheck', 'false');
    messageText.setAttribute('role', 'textbox');
    messageText.setAttribute('aria-label', `Edit message ${messageId + 1}`);
    getActionHost(messageElement)?.appendChild(actions);
    activeEdit = edit;
    bindEditorGuards(edit);

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
