const EDITING_CLASS = 'stplus-visible-editing';
const ACTIONS_CLASS = 'stplus-visible-edit-actions';
const ACTION_HOST_CLASS = 'stplus-visible-edit-action-host';
const NATIVE_ACTIONS_CLASS = 'stplus-native-edit-actions';
const EDIT_MODE_TOGGLE_CLASS = 'stplus-edit-mode-toggle';
const RELOCATED_MESSAGE_MENU_CLASS = 'stplus-relocated-message-menu';
const EDIT_MODE_STORAGE_KEY = 'stplus-formatted-edit-mode';
const RELOCATED_NATIVE_ACTIONS_CLASS = 'stplus-relocated-native-edit-buttons';

let context = null;
let settings = null;
let activeEdit = null;
let listenersBound = false;
let editMode = 'vanilla';
let forcingVanillaEdit = false;
let nativeEditObserver = null;
let nativeEditRelocationScheduled = false;
const nativeEditActionParents = new WeakMap();
const nativeEditActionContainerParents = new WeakMap();
const relocatedMessageMenuParents = new WeakMap();

function isEnabled() {
    return settings?.formattedMessageEditEnabled !== false;
}

function loadEditMode() {
    try {
        editMode = window.localStorage.getItem(EDIT_MODE_STORAGE_KEY) === 'formatted' ? 'formatted' : 'vanilla';
    } catch {
        editMode = 'vanilla';
    }
}

function setEditMode(mode) {
    editMode = mode === 'formatted' ? 'formatted' : 'vanilla';
    try {
        window.localStorage.setItem(EDIT_MODE_STORAGE_KEY, editMode);
    } catch {
        // A restricted storage context should not disable editing.
    }
    updateEditModeToggles();
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

/**
 * SillyTavern's formatter can change the visible spelling of a source
 * character. For example, a source `...` is rendered as the single-character
 * ellipsis `…`. Keep a reversible, offset-aware normalized view so edits can
 * still be applied to the original Markdown/HTML source.
 */
function normalizeMappingText(text) {
    const normalizedUnits = [];
    const normalizedToOriginal = [0];
    const originalToNormalized = new Array(text.length + 1);
    let originalOffset = 0;
    let normalizedOffset = 0;

    for (const character of text) {
        const originalStart = originalOffset;
        const originalEnd = originalOffset + character.length;
        const replacement = character === '…' ? '...' : character === '\u00a0' ? ' ' : character;
        const replacementUnits = replacement.split('');

        for (let offset = originalStart; offset < originalEnd; offset++) {
            originalToNormalized[offset] = normalizedOffset;
        }
        originalToNormalized[originalEnd] = normalizedOffset + replacementUnits.length;

        replacementUnits.forEach((unit, index) => {
            normalizedUnits.push(unit);
            normalizedToOriginal.push(index === replacementUnits.length - 1 ? originalEnd : originalStart);
        });
        originalOffset = originalEnd;
        normalizedOffset += replacementUnits.length;
    }

    return {
        text: normalizedUnits.join(''),
        normalizedToOriginal,
        originalToNormalized,
    };
}

function buildRenderedSourceMap(source, root) {
    const sourceView = normalizeMappingText(maskSourceMarkup(source));
    const segments = [];
    const nodes = getEditableTextNodes(root);
    let renderedOffset = 0;
    let sourceCursor = 0;

    for (const node of nodes) {
        const text = node.nodeValue;
        const renderedText = normalizeMappingText(text);
        const normalizedStart = sourceView.text.indexOf(renderedText.text, sourceCursor);
        const mapped = normalizedStart !== -1;
        const sourceStart = mapped ? sourceView.normalizedToOriginal[normalizedStart] : null;
        const sourceEnd = mapped
            ? sourceView.normalizedToOriginal[normalizedStart + renderedText.text.length]
            : null;
        const sourceOffsets = mapped
            ? Array.from({ length: text.length + 1 }, (_, offset) =>
                sourceView.normalizedToOriginal[normalizedStart + renderedText.originalToNormalized[offset]])
            : null;
        const segment = {
            renderedStart: renderedOffset,
            renderedEnd: renderedOffset + text.length,
            sourceStart,
            sourceEnd,
            sourceOffsets,
        };
        segments.push(segment);
        renderedOffset += text.length;
        if (mapped) sourceCursor = normalizedStart + renderedText.text.length;
    }

    return {
        renderedText: nodes.map((node) => node.nodeValue).join(''),
        segments,
        complete: segments.every((segment) => segment.sourceStart !== null),
    };
}

function getSourceBoundary(sourceMap, renderedOffset, preferEnd = false) {
    for (let index = 0; index < sourceMap.segments.length; index++) {
        const segment = sourceMap.segments[index];
        if (renderedOffset < segment.renderedStart || renderedOffset > segment.renderedEnd) continue;
        // At a boundary between rendered text nodes, a start belongs after
        // the source whitespace separating those nodes. An end belongs before
        // it. Choosing the first segment for both cases moves newly added
        // markup across paragraph/newline boundaries after reload.
        if (!preferEnd && renderedOffset === segment.renderedEnd) {
            const next = sourceMap.segments[index + 1];
            if (next?.renderedStart === renderedOffset && next.sourceStart !== null) continue;
        }
        const offset = renderedOffset - segment.renderedStart;
        if (segment.sourceOffsets) return segment.sourceOffsets[offset];
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
            start: segment.sourceOffsets
                ? segment.sourceOffsets[Math.max(hunk.renderedStart, segment.renderedStart) - segment.renderedStart]
                : segment.sourceStart + Math.max(hunk.renderedStart, segment.renderedStart) - segment.renderedStart,
            end: segment.sourceOffsets
                ? segment.sourceOffsets[Math.min(hunk.renderedEnd, segment.renderedEnd) - segment.renderedStart]
                : segment.sourceStart + Math.min(hunk.renderedEnd, segment.renderedEnd) - segment.renderedStart,
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

function getFormattingMarks(element) {
    const marks = new Set();
    for (let current = element.parentElement; current; current = current.parentElement) {
        switch (current.tagName?.toLowerCase()) {
            case 'b':
            case 'strong':
                marks.add('strong');
                break;
            case 'i':
            case 'em':
                marks.add('em');
                break;
            case 'u':
                marks.add('underline');
                break;
            case 's':
            case 'del':
            case 'strike':
                marks.add('strike');
                break;
            case 'mark':
                marks.add('mark');
                break;
            case 'code':
                marks.add('code');
                break;
            case 'span': {
                const style = current.getAttribute('style') ?? '';
                const supportedStyles = style.split(';')
                    .map((declaration) => declaration.trim())
                    .filter((declaration) => /^(color|background-color|font-weight|font-style|text-decoration(?:-line)?)\s*:/i.test(declaration))
                    .map((declaration) => declaration.replace(/\s+/g, ' ').toLowerCase())
                    .sort();
                if (supportedStyles.length) marks.add(`style:${supportedStyles.join(';')}`);
                break;
            }
            default:
                break;
        }
    }
    return marks;
}

function collectFormattedText(root) {
    const nodes = getEditableTextNodes(root);
    const text = [];
    const marks = [];
    for (const node of nodes) {
        const nodeText = node.nodeValue ?? '';
        const nodeMarks = getFormattingMarks(node);
        // Keep one mark entry per UTF-16 code unit. The source mapper and
        // string slicing APIs use UTF-16 offsets, while `for...of` would
        // collapse emoji and other astral characters into one entry.
        for (let offset = 0; offset < nodeText.length; offset++) {
            text.push(nodeText[offset]);
            marks.push(new Set(nodeMarks));
        }
    }
    return { text: text.join(''), marks };
}

function formatMarkMarkup(mark, opening) {
    const tags = {
        strong: ['<strong>', '</strong>'],
        em: ['<em>', '</em>'],
        underline: ['<u>', '</u>'],
        strike: ['<s>', '</s>'],
        mark: ['<mark>', '</mark>'],
        code: ['<code>', '</code>'],
    };
    if (tags[mark]) return tags[mark][opening ? 0 : 1];
    if (!mark.startsWith('style:')) return '';

    const style = mark.slice('style:'.length)
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    return opening ? `<span style="${style}">` : '</span>';
}

function getAddedFormattingRanges(originalView, currentView) {
    const hunk = getVisibleTextHunk(originalView.text, currentView.text);
    const active = new Map();
    const ranges = [];

    const originalIndexForCurrent = (index) => {
        if (index < hunk.renderedStart) return index;
        if (index >= hunk.renderedStart + hunk.insertedText.length) {
            return hunk.renderedEnd + index - (hunk.renderedStart + hunk.insertedText.length);
        }
        return null;
    };

    const closeMark = (mark, end) => {
        const start = active.get(mark);
        if (start !== undefined) ranges.push({ mark, start, end });
        active.delete(mark);
    };

    for (let index = 0; index <= currentView.text.length; index++) {
        const originalIndex = originalIndexForCurrent(index);
        const currentMarks = index < currentView.text.length ? currentView.marks[index] : new Set();
        const originalMarks = originalIndex === null || originalIndex === undefined
            ? new Set()
            : (originalView.marks[originalIndex] ?? new Set());
        const addedMarks = new Set([...currentMarks].filter((mark) => !originalMarks.has(mark)));

        for (const mark of [...active.keys()]) {
            if (!addedMarks.has(mark)) closeMark(mark, index);
        }
        for (const mark of addedMarks) {
            if (!active.has(mark)) active.set(mark, index);
        }
    }

    return ranges.filter((range) => range.end > range.start && formatMarkMarkup(range.mark, true));
}

function getSourceReplacementInfo(edit, currentRenderedText) {
    const hunk = getVisibleTextHunk(edit.sourceMap.renderedText, currentRenderedText);
    const ranges = edit.sourceMap.segments
        .filter((segment) => segment.renderedStart < hunk.renderedEnd && segment.renderedEnd > hunk.renderedStart)
        .map((segment) => ({
            start: segment.sourceOffsets
                ? segment.sourceOffsets[Math.max(hunk.renderedStart, segment.renderedStart) - segment.renderedStart]
                : segment.sourceStart + Math.max(hunk.renderedStart, segment.renderedStart) - segment.renderedStart,
            end: segment.sourceOffsets
                ? segment.sourceOffsets[Math.min(hunk.renderedEnd, segment.renderedEnd) - segment.renderedStart]
                : segment.sourceStart + Math.min(hunk.renderedEnd, segment.renderedEnd) - segment.renderedStart,
        }));
    const insertedText = escapeInsertedText(hunk.insertedText);
    const insertionSource = ranges.length
        ? ranges[0].start
        : getSourceBoundary(edit.sourceMap, hunk.renderedStart);
    return { hunk, ranges, insertedText, insertionSource };
}

function mapOriginalSourceBoundaryToEdited(boundary, replacement, preferEnd = false) {
    if (boundary === null || boundary === undefined) return null;
    const { ranges, insertedText, insertionSource } = replacement;
    if (!ranges.length) {
        if (boundary < insertionSource) return boundary;
        if (boundary > insertionSource || preferEnd) return boundary + insertedText.length;
        return boundary;
    }

    let delta = 0;
    let inserted = false;
    for (const range of ranges) {
        if (boundary < range.start) return boundary + delta;
        if (boundary <= range.end) {
            if (!inserted) return insertionSource + (preferEnd ? insertedText.length : 0);
            return range.start + delta;
        }
        if (!inserted) {
            delta += insertedText.length;
            inserted = true;
        }
        delta -= range.end - range.start;
    }
    return boundary + delta;
}

function mapCurrentRenderedBoundaryToEditedSource(edit, currentRenderedText, boundary, replacement, preferEnd = false) {
    const { hunk, insertedText, insertionSource } = replacement;
    const insertedEnd = hunk.renderedStart + hunk.insertedText.length;
    if (boundary > hunk.renderedStart && boundary < insertedEnd) {
        return insertionSource + escapeInsertedText(hunk.insertedText.slice(0, boundary - hunk.renderedStart)).length;
    }

    const originalBoundary = boundary >= insertedEnd
        ? hunk.renderedEnd + boundary - insertedEnd
        : boundary;
    const sourceBoundary = getSourceBoundary(edit.sourceMap, originalBoundary, preferEnd);
    return mapOriginalSourceBoundaryToEdited(sourceBoundary, replacement, preferEnd);
}

function applyFormattingMarkup(source, overlays) {
    const events = new Map();
    for (const overlay of overlays) {
        const opening = formatMarkMarkup(overlay.mark, true);
        const closing = formatMarkMarkup(overlay.mark, false);
        if (!opening || !closing || overlay.end <= overlay.start) continue;
        if (!events.has(overlay.start)) events.set(overlay.start, []);
        if (!events.has(overlay.end)) events.set(overlay.end, []);
        events.get(overlay.start).push({ type: 'open', markup: opening, range: overlay });
        events.get(overlay.end).push({ type: 'close', markup: closing, range: overlay });
    }

    let result = '';
    let cursor = 0;
    for (const position of [...events.keys()].sort((a, b) => a - b)) {
        result += source.slice(cursor, position);
        const positionEvents = events.get(position).sort((a, b) => {
            if (a.type !== b.type) return a.type === 'close' ? -1 : 1;
            return a.type === 'close' ? b.range.start - a.range.start : a.range.end - b.range.end;
        });
        result += positionEvents.map((event) => event.markup).join('');
        cursor = position;
    }
    return result + source.slice(cursor);
}

function applyAddedFormatting(edit, currentRenderedText, source) {
    if (!edit.originalFormattedView || !edit.currentFormattedView) return source;
    const ranges = getAddedFormattingRanges(edit.originalFormattedView, edit.currentFormattedView);
    if (!ranges.length) return source;

    const replacement = getSourceReplacementInfo(edit, currentRenderedText);
    if (replacement.insertionSource === null) return source;
    const overlays = ranges.map((range) => ({
        mark: range.mark,
        start: mapCurrentRenderedBoundaryToEditedSource(edit, currentRenderedText, range.start, replacement),
        end: mapCurrentRenderedBoundaryToEditedSource(edit, currentRenderedText, range.end, replacement, true),
    })).filter((range) => range.start !== null && range.end !== null && range.end > range.start);

    return applyFormattingMarkup(source, overlays);
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
    restoreRelocatedMessageMenu(messageElement);
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
    const onPaste = (event) => {
        event.preventDefault();
        insertPlainText(editor, event.clipboardData?.getData('text/plain') ?? '');
    };
    const onDrop = (event) => event.preventDefault();
    // Leave native beforeinput/keyboard formatting enabled. The formatted
    // editor records newly-created marks and maps them back to the original
    // message source when the edit is confirmed.
    [['paste', onPaste], ['drop', onDrop]].forEach(([eventName, handler]) => {
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

function updateEditModeToggle(toggle) {
    if (!(toggle instanceof HTMLElement)) return;
    const formatted = editMode === 'formatted';
    toggle.classList.remove('fa-toggle-on', 'fa-toggle-off');
    toggle.textContent = formatted ? 'FMT' : 'VAN';
    toggle.dataset.mode = formatted ? 'formatted' : 'vanilla';
    toggle.title = formatted ? 'Edit mode: Formatted (click for vanilla)' : 'Edit mode: Vanilla (click for formatted)';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-pressed', String(formatted));
}

function updateEditModeToggles() {
    document.querySelectorAll(`.${EDIT_MODE_TOGGLE_CLASS}`).forEach(updateEditModeToggle);
}

function handleEditModeToggleClick(event) {
    if (!isEnabled()) return;
    const toggle = event.target instanceof Element
        ? event.target.closest(`.${EDIT_MODE_TOGGLE_CLASS}`)
        : null;
    if (!(toggle instanceof HTMLElement)) return;

    // Message controls can survive an extension refresh or a chat rerender.
    // Handle the toggle at the document level as well as on the button itself,
    // so a reused control never loses its mode-switch behavior.
    event.preventDefault();
    event.stopImmediatePropagation();
    setEditMode(editMode === 'formatted' ? 'vanilla' : 'formatted');
}

function handleEditModeToggleKeydown(event) {
    if (!isEnabled() || (event.key !== 'Enter' && event.key !== ' ')) return;
    const toggle = event.target instanceof Element
        ? event.target.closest(`.${EDIT_MODE_TOGGLE_CLASS}`)
        : null;
    if (!(toggle instanceof HTMLElement)) return;
    handleEditModeToggleClick(event);
}

function installEditModeToggles() {
    if (!isEnabled()) {
        document.querySelectorAll(`.${EDIT_MODE_TOGGLE_CLASS}`).forEach((toggle) => toggle.remove());
        return;
    }
    document.querySelectorAll('.mes .mes_edit').forEach((nativeEdit) => {
        if (!(nativeEdit instanceof HTMLElement) || nativeEdit.classList.contains(EDIT_MODE_TOGGLE_CLASS)) return;
        if (nativeEdit.nextElementSibling?.classList.contains(EDIT_MODE_TOGGLE_CLASS)) return;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = `mes_button interactable ${EDIT_MODE_TOGGLE_CLASS}`;
        toggle.dataset.stplusOwned = '1';
        const toggleMode = (event) => {
            event.preventDefault();
            event.stopPropagation();
            setEditMode(editMode === 'formatted' ? 'vanilla' : 'formatted');
        };
        toggle.addEventListener('click', toggleMode);
        toggle.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') toggleMode(event);
        });
        nativeEdit.after(toggle);
        updateEditModeToggle(toggle);
    });
}

function getNativeEditButton(messageElement) {
    return Array.from(messageElement?.querySelectorAll('.mes_edit') ?? [])
        .find((button) => !button.classList.contains(EDIT_MODE_TOGGLE_CLASS));
}

function isVanillaEditOpen(messageElement, messageText) {
    return messageElement.classList.contains('editing')
        || messageElement.classList.contains('mes_editing')
        || messageText.querySelector('textarea, input, [contenteditable="true"]') instanceof HTMLElement;
}

function openVanillaEdit(messageElement) {
    const nativeEdit = getNativeEditButton(messageElement);
    if (!(nativeEdit instanceof HTMLElement)) return;
    forcingVanillaEdit = true;
    try {
        nativeEdit.click();
    } finally {
        forcingVanillaEdit = false;
    }
    scheduleNativeEditActionRelocation();
}

function getActionInsertionPoint(messageElement) {
    const block = messageElement.querySelector('.mes_block') ?? messageElement;
    // SillyTavern renders reasoning as a top-level child of .mes_block,
    // before .mes_text. Insert the edit row immediately after it so the
    // controls remain below an expanded thinking stream without covering the
    // header or the footer swipe controls.
    const reasoning = Array.from(block.children).find((child) => child.classList.contains('mes_reasoning_details'));
    const header = Array.from(block.children).find((child) => child.classList.contains('ch_name'));
    return { block, after: reasoning ?? header ?? null };
}

function getMessageMenu(messageElement) {
    return Array.from(messageElement.querySelectorAll('.mes_buttons'))
        .find((menu) => !menu.closest(`.${ACTIONS_CLASS}`));
}

function relocateMessageMenu(messageElement, actionRow) {
    if (!(messageElement instanceof HTMLElement) || !(actionRow instanceof HTMLElement)) return;
    const menu = getMessageMenu(messageElement);
    if (!(menu instanceof HTMLElement) || actionRow.contains(menu)) return;

    if (!relocatedMessageMenuParents.has(menu)) {
        relocatedMessageMenuParents.set(menu, {
            parent: menu.parentNode,
            nextSibling: menu.nextSibling,
        });
    }
    menu.classList.add(RELOCATED_MESSAGE_MENU_CLASS);
    actionRow.append(menu);
}

function restoreRelocatedMessageMenu(messageElement) {
    if (!(messageElement instanceof HTMLElement)) return;
    for (const menu of messageElement.querySelectorAll(`.${RELOCATED_MESSAGE_MENU_CLASS}`)) {
        const original = relocatedMessageMenuParents.get(menu);
        if (original?.parent instanceof HTMLElement && original.parent.isConnected) {
            const nextSibling = original.nextSibling?.parentNode === original.parent
                ? original.nextSibling
                : null;
            original.parent.insertBefore(menu, nextSibling);
        }
        menu.classList.remove(RELOCATED_MESSAGE_MENU_CLASS);
        relocatedMessageMenuParents.delete(menu);
    }
}

function removeNativeEditActionRow(messageElement) {
    if (!(messageElement instanceof HTMLElement)) return;

    const actionRow = messageElement.querySelector(`.${NATIVE_ACTIONS_CLASS}`);
    if (!(actionRow instanceof HTMLElement)) return;

    // The native editor reuses the same action container on the next edit.
    // Return the whole relocated group to SillyTavern's original header before
    // removing our row; otherwise its controls can disappear permanently after
    // the first edit in a session.
    for (const nativeActions of actionRow.querySelectorAll(`.mes_edit_buttons.${RELOCATED_NATIVE_ACTIONS_CLASS}`)) {
        const original = nativeEditActionContainerParents.get(nativeActions);
        if (original?.parent instanceof HTMLElement && original.parent.isConnected) {
            const nextSibling = original.nextSibling?.parentNode === original.parent
                ? original.nextSibling
                : null;
            original.parent.insertBefore(nativeActions, nextSibling);
        }
        nativeActions.classList.remove(RELOCATED_NATIVE_ACTIONS_CLASS);
        nativeEditActionContainerParents.delete(nativeActions);
    }

    for (const action of actionRow.querySelectorAll('.mes_edit_done, .mes_edit_cancel')) {
        action.classList.remove('stplus-visible-edit-action');
        nativeEditActionParents.delete(action);
    }

    restoreRelocatedMessageMenu(messageElement);
    actionRow.remove();
}

function relocateNativeEditActions(messageElement) {
    if (!(messageElement instanceof HTMLElement)) return;

    const row = messageElement.querySelector(`.${NATIVE_ACTIONS_CLASS}`);
    const isEditing = messageElement.querySelector('.edit_textarea') instanceof HTMLElement;
    const actionBlock = messageElement.querySelector('.mes_block') ?? messageElement;
    const nativeActions = actionBlock.querySelector('.mes_edit_buttons');
    const nativeEditorVisible = nativeActions instanceof HTMLElement
        && getComputedStyle(nativeActions).display !== 'none';

    // Native SillyTavern removes the textarea when confirm/cancel finishes.
    // Remove our detached row at the same time so it cannot linger after the
    // native editor closes or another message becomes active.
    if (!isEditing && !nativeEditorVisible) {
        removeNativeEditActionRow(messageElement);
        return;
    }

    const confirm = nativeActions?.querySelector('.mes_edit_done');
    const cancel = nativeActions?.querySelector('.mes_edit_cancel');
    if (!(confirm instanceof HTMLElement) && !(cancel instanceof HTMLElement)) return;

    const actionRow = row ?? document.createElement('div');
    if (!row) {
        actionRow.className = `${ACTIONS_CLASS} ${ACTION_HOST_CLASS} ${NATIVE_ACTIONS_CLASS}`;
        actionRow.dataset.stplusOwned = '1';
        actionRow.addEventListener('click', (event) => {
            if (!(event.target instanceof Element) || !event.target.closest('.mes_edit_done, .mes_edit_cancel')) return;
            // Restore the controls before SillyTavern's delegated handler runs.
            // This keeps the native editor's reusable controls attached even if
            // its handler synchronously rebuilds the message.
            removeNativeEditActionRow(messageElement);
            window.setTimeout(() => removeNativeEditActionRow(messageElement), 0);
        }, true);
        const insertionPoint = getActionInsertionPoint(messageElement);
        if (insertionPoint.after) insertionPoint.after.after(actionRow);
        else insertionPoint.block.prepend(actionRow);
    }

    for (const action of [confirm, cancel]) {
        if (!(action instanceof HTMLElement)) continue;
        nativeEditActionParents.set(action, nativeActions);
        action.classList.add('stplus-visible-edit-action');
    }

    if (nativeActions.parentElement !== actionRow) {
        if (!nativeEditActionContainerParents.has(nativeActions)) {
            nativeEditActionContainerParents.set(nativeActions, {
                parent: nativeActions.parentNode,
                nextSibling: nativeActions.nextSibling,
            });
        }
        nativeActions.classList.add(RELOCATED_NATIVE_ACTIONS_CLASS);
        actionRow.append(nativeActions);
    }
    relocateMessageMenu(messageElement, actionRow);
}

function scheduleNativeEditActionRelocation() {
    if (nativeEditRelocationScheduled) return;
    nativeEditRelocationScheduled = true;
    const run = () => {
        nativeEditRelocationScheduled = false;
        document.querySelectorAll('.mes').forEach(relocateNativeEditActions);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else window.setTimeout(run, 0);
}

function installNativeEditActionObserver() {
    if (nativeEditObserver || typeof MutationObserver !== 'function') return;
    nativeEditObserver = new MutationObserver(() => scheduleNativeEditActionRelocation());
    nativeEditObserver.observe(document.body, { childList: true, subtree: true });
}

function syncMessageSwipe(message, text = message?.mes) {
    if (!Array.isArray(message?.swipes) || message.swipes.length === 0) return;
    const swipeId = Number.parseInt(message.swipe_id, 10);
    const index = Number.isInteger(swipeId) && swipeId >= 0 && swipeId < message.swipes.length ? swipeId : 0;
    if (typeof text === 'string') message.swipes[index] = text;

    // SillyTavern stores display overrides (translations and other rendered
    // text) in the active swipe's swipe_info metadata. Updating only
    // message.extra.display_text keeps the current DOM correct, but the old
    // override is restored when the chat is reopened or the swipe is loaded.
    const swipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info[index] : null;
    if (swipeInfo && typeof swipeInfo === 'object') {
        swipeInfo.extra = typeof structuredClone === 'function'
            ? structuredClone(message.extra ?? {})
            : JSON.parse(JSON.stringify(message.extra ?? {}));
    }
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

        // The native editor may still have a save in flight when this edit is
        // confirmed. The immediate conditional save normally waits for it,
        // but a later native event can update the active swipe metadata after
        // that wait. Queue one final debounced save so the serialized chat
        // reflects the post-event state as well.
        context?.saveMetadataDebounced?.();
    } catch (error) {
        console.warn('[SillyTavernPlus] Could not save visible message edit.', error);
    }
}

function rerenderEditedMessage(edit, message) {
    if (!edit?.messageText?.isConnected) return;

    // Use SillyTavern's own renderer so Markdown entered during a formatted
    // edit (for example *emphasis*) is visible immediately, not only after a
    // chat reload. This also keeps the extension aligned with native message
    // rendering and display_text handling.
    if (typeof context?.updateMessageBlock === 'function') {
        context.updateMessageBlock(edit.messageId, message);
        return;
    }

    // Older SillyTavern builds may expose the formatter without the block
    // helper. Keep those builds functional without flattening the source.
    if (typeof context?.messageFormatting === 'function') {
        const text = message?.extra?.display_text ?? message?.mes ?? '';
        edit.messageText.innerHTML = context.messageFormatting(
            text,
            message?.name,
            message?.is_system,
            message?.is_user,
            edit.messageId,
            {},
            false,
        );
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
        edit.currentFormattedView = collectFormattedText(edit.messageText);
        text = applyAddedFormatting(edit, edit.currentFormattedView.text, text);
    } catch (error) {
        console.warn('[SillyTavernPlus] Could not preserve message formatting while saving.', error);
        removeEditUi(edit, true);
        return;
    }

    if (edit.sourceKey === 'display_text') {
        message.extra.display_text = text;
        syncMessageSwipe(message);
    } else {
        message.mes = text;
        syncMessageSwipe(message, text);
    }
    // Match SillyTavern's native editor. This tells swipe synchronization and
    // the chat saver that even a greeting-only chat has been modified.
    if (context?.chatMetadata && typeof context.chatMetadata === 'object') {
        context.chatMetadata.tainted = true;
    }
    removeEditUi(edit, false);
    rerenderEditedMessage(edit, message);
    await emitMessageEvent('MESSAGE_EDITED', edit.messageId);
    await emitMessageEvent('MESSAGE_UPDATED', edit.messageId);
    await saveChat();
}

function beginEdit(messageElement, messageText, event) {
    if (!isEnabled()) return;
    const messageId = getMessageId(messageElement);
    if (messageId === null || !getChat()[messageId]) return;
    const message = getChat()[messageId];
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
    const originalContainer = document.createElement('div');
    originalContainer.innerHTML = edit.originalHTML;
    edit.originalFormattedView = collectFormattedText(originalContainer);
    edit.currentFormattedView = null;
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
    const insertionPoint = getActionInsertionPoint(messageElement);
    if (insertionPoint.after) insertionPoint.after.after(actions);
    else insertionPoint.block.prepend(actions);
    relocateMessageMenu(messageElement, actions);
    activeEdit = edit;
    bindEditorGuards(edit);

    event.preventDefault();
    event.stopPropagation();
    messageText.focus({ preventScroll: true });
    placeCaret(messageText, event);
}

function handleNativeEditClick(event) {
    if (!isEnabled() || forcingVanillaEdit) return;
    const nativeEdit = event.target instanceof Element ? event.target.closest('.mes_edit') : null;
    if (!(nativeEdit instanceof HTMLElement) || nativeEdit.classList.contains(EDIT_MODE_TOGGLE_CLASS)) return;
    const messageElement = nativeEdit.closest('.mes');
    const messageText = messageElement?.querySelector('.mes_text');
    if (!(messageElement instanceof HTMLElement) || !(messageText instanceof HTMLElement)) return;
    if (editMode !== 'formatted') {
        // Native editing creates its textarea and action buttons during the
        // click handler. Relocate them on the next frame after creation.
        scheduleNativeEditActionRelocation();
        return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    beginEdit(messageElement, messageText, event);
}

function handleDoubleClick(event) {
    if (!isEnabled()) return;
    if (event.target instanceof Element && event.target.closest(`.${ACTIONS_CLASS}`)) return;
    const messageText = event.target instanceof Element ? event.target.closest('.mes .mes_text') : null;
    if (!(messageText instanceof HTMLElement)) return;
    const messageElement = messageText.closest('.mes');
    if (!(messageElement instanceof HTMLElement)) return;
    if (isVanillaEditOpen(messageElement, messageText)) return;
    event.preventDefault();
    event.stopPropagation();
    if (editMode === 'formatted') {
        beginEdit(messageElement, messageText, event);
    } else {
        // Vanilla mode delegates to SillyTavern so its editor, formatting,
        // and save/cancel behavior remain unchanged.
        openVanillaEdit(messageElement);
    }
}

function bindLifecycleEvents() {
    if (listenersBound) return;
    // Branch jumps replace the rendered chat DOM before SillyTavern's
    // lifecycle notifications are guaranteed to reach third-party modules.
    // Leave edit mode before that replacement so activeEdit never points at
    // a detached message element.
    window.addEventListener('stplus-chat-navigation', cancelEdit);
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes;
    if (eventSource && eventTypes && typeof eventSource.on === 'function') {
        ['CHAT_CHANGED', 'CHAT_LOADED', 'CHAT_CREATED', 'CHAT_DELETED'].forEach((name) => {
            const eventName = eventTypes[name];
            if (eventName) eventSource.on(eventName, cancelEdit);
        });
    }
    listenersBound = true;
}

export function initialize(stContext, stSettings) {
    context = stContext;
    settings = stSettings;
    loadEditMode();
    document.addEventListener('click', handleEditModeToggleClick, true);
    document.addEventListener('keydown', handleEditModeToggleKeydown, true);
    document.addEventListener('click', handleNativeEditClick, true);
    document.addEventListener('dblclick', handleDoubleClick, true);
    installEditModeToggles();
    installNativeEditActionObserver();
    scheduleNativeEditActionRelocation();
    bindLifecycleEvents();
}

export function refresh() {
    if (!isEnabled()) cancelEdit();
    installEditModeToggles();
    scheduleNativeEditActionRelocation();
}
