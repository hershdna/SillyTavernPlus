const OWNED = 'data-stplus-greeting-groups';
const BADGE = 'stplus-greeting-group-badge';
let context = null;
let settings = null;
let queued = false;
let observer = null;
let editorObserver = null;
let editorTarget = null;
let poller = null;
let activeCharacter = null;
let groupInputListenersBound = false;
const runtimeGroupsByCharacter = new Map();

function bindGroupInputListeners() {
    if (groupInputListenersBound) return;

    const getInput = (event) => event.target instanceof Element
        ? event.target.closest('.stplus-greeting-group-new-name')
        : null;
    const focusInput = (event) => {
        const input = getInput(event);
        if (!input) return;
        // Run before SillyTavern's popup/MovingUI capture handlers. Explicit
        // focus is needed because those handlers may leave focus on <body> for
        // controls inserted into a live dialog.
        input.focus();
        event.stopPropagation();
    };
    window.addEventListener('pointerdown', focusInput, true);
    window.addEventListener('mousedown', focusInput, true);
    window.addEventListener('click', event => {
        if (getInput(event)) event.stopPropagation();
    }, true);
    groupInputListenersBound = true;
}

function persistSettings() {
    if (typeof globalThis.saveSettingsDebounced === 'function') globalThis.saveSettingsDebounced();
}

function fingerprint(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function character() {
    const ctx = context ?? globalThis.SillyTavern?.getContext?.() ?? {};
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const rawId = ctx.this_chid ?? ctx.characterId;
    const id = rawId === undefined || rawId === null || rawId === '' ? null : Number(rawId);
    if (id !== null && Number.isInteger(id) && characters[id]) return activeCharacter = characters[id];
    const activeName = ctx.name2 ?? ctx.name1 ?? document.querySelector('#character_name_pole')?.value;
    if (activeName) {
        const match = characters.find(item => item?.name === activeName);
        if (match) return activeCharacter = match;
        const first = document.querySelector('textarea.alternate_greeting_text:not([id])')?.value ?? '';
        const alternates = Array.from(document.querySelectorAll('textarea.alternate_greeting_text[id^="alternate_greeting_"]')).map(item => item.value);
        if (first || alternates.length) {
            return activeCharacter = { name: activeName, avatar: 'dom-' + activeName, first_mes: first, alternate_greetings: alternates };
        }
    }
    return ctx.character && typeof ctx.character === 'object' ? activeCharacter = ctx.character : activeCharacter;
}

function texts(char) {
    return [char?.first_mes ?? '', ...(Array.isArray(char?.alternate_greetings) ? char.alternate_greetings : [])]
        .map(value => String(value ?? ''));
}

function key(char) {
    return String(char?.avatar ?? char?.avatar_url ?? char?.name ?? 'unknown-character');
}

function model(char, persist = true) {
    settings.greetingGroupsByCharacter ??= {};
    const store = settings.greetingGroupsByCharacter;
    const charKey = key(char);
    const old = store[charKey] && typeof store[charKey] === 'object' ? store[charKey] : {};
    const runtimeGroups = runtimeGroupsByCharacter.get(charKey) ?? [];
    const persistedGroups = Array.isArray(old.groups) ? old.groups.filter(group => group?.id && group?.name) : [];
    const groups = [];
    [...persistedGroups, ...runtimeGroups].forEach(group => {
        if (!group?.id || !group?.name || groups.some(existing => existing.id === group.id || existing.name.toLowerCase() === group.name.toLowerCase())) return;
        groups.push(group);
    });
    const oldGreetings = Array.isArray(old.greetings) ? old.greetings : [];
    const used = new Set();
    const greetings = texts(char).map((text, index) => {
        const fp = fingerprint(text);
        const matchIndex = oldGreetings.findIndex((item, oldIndex) => !used.has(oldIndex) && item?.fingerprint === fp);
        const match = matchIndex >= 0 ? oldGreetings[matchIndex] : oldGreetings[index];
        if (matchIndex >= 0) used.add(matchIndex);
        return {
            id: match?.id ?? ('greeting-' + fp + '-' + index),
            fingerprint: fp,
            groupId: match?.groupId ?? null,
        };
    });
    const result = {
        groups,
        greetings,
    };
    store[charKey] = result;
    runtimeGroupsByCharacter.set(charKey, result.groups);
    if (persist) persistSettings();
    return result;
}

function groupFor(data, index) {
    const id = data.greetings[index]?.groupId;
    return data.groups.find(group => group.id === id) ?? null;
}

function activeGreetingIndex() {
    const liveContext = context ?? globalThis.SillyTavern?.getContext?.() ?? {};
    const chat = Array.isArray(liveContext?.chat) ? liveContext.chat : [];
    const firstMessage = chat[0];
    if (!firstMessage) return 0;
    const swipes = Array.isArray(firstMessage.swipes) ? firstMessage.swipes : [];
    const swipeId = Number.parseInt(firstMessage.swipe_id, 10);
    if (Number.isInteger(swipeId) && swipeId >= 0 && swipeId < swipes.length) return swipeId;
    if (swipes.length > 0 && typeof firstMessage.mes === 'string') {
        const matchingIndex = swipes.findIndex(value => String(value ?? '') === firstMessage.mes);
        if (matchingIndex >= 0) return matchingIndex;
    }
    return 0;
}

function badge(text, tree = false) {
    const element = document.createElement('span');
    element.className = tree ? BADGE + ' stplus-greeting-group-tree-badge' : BADGE;
    element.setAttribute(OWNED, '1');
    element.textContent = text;
    element.title = text;
    return element;
}

function greetingPopup() {
    return Array.from(document.querySelectorAll('.alternate_grettings'))
        .sort((left, right) => right.querySelectorAll('.alternate_greeting').length - left.querySelectorAll('.alternate_greeting').length)[0] ?? null;
}

function getGreetingBlocks(list) {
    return Array.from(list?.querySelectorAll(':scope > .alternate_greeting') ?? []);
}

function updateGroupSelect(select, groups, selected) {
    if (!(select instanceof HTMLSelectElement)) return;
    const value = selected ?? select.value;
    select.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Ungrouped';
    select.append(none);
    groups.forEach(group => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        select.append(option);
    });
    select.value = groups.some(group => group.id === value) ? value : '';
}

function refreshEditor(char, data) {
    const popup = greetingPopup();
    const list = popup?.querySelector('.alternate_greetings_list');
    if (!popup || !list) return;
    if (editorTarget !== list) {
        editorObserver?.disconnect();
        editorTarget = list;
        editorObserver = new MutationObserver(mutations => {
            const external = mutations.some(mutation => Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes)).some(node => node.nodeType === 1 && !node.closest?.('[' + OWNED + ']')));
            if (external) queue();
        });
        editorObserver.observe(list, { childList: true, subtree: true });
    }

    const blocks = getGreetingBlocks(list);
    const existingToolbar = popup.querySelector('.stplus-greeting-group-toolbar');
    const existingControls = popup.querySelectorAll('.stplus-greeting-group-control');
    const existingSelects = popup.querySelectorAll('.stplus-greeting-group-select');
    // Global MovingUI/frontmost scans can call refresh while the user is
    // typing. Reuse a complete editor instead of replacing its focused input.
    if (existingToolbar && existingControls.length === blocks.length && existingSelects.length === blocks.length + 1) {
        const firstSelect = existingToolbar.querySelector('.stplus-greeting-group-select');
        updateGroupSelect(firstSelect, data.groups, data.greetings[0]?.groupId ?? '');
        blocks.forEach((block, index) => {
            const select = block.querySelector('.stplus-greeting-group-select');
            updateGroupSelect(select, data.groups, data.greetings[index + 1]?.groupId ?? '');
        });
        return;
    }
    popup.querySelectorAll('[' + OWNED + ']').forEach(element => element.remove());

    const toolbar = document.createElement('div');
    toolbar.className = 'stplus-greeting-group-toolbar';
    toolbar.setAttribute(OWNED, '1');
    const label = document.createElement('span');
    label.className = 'stplus-greeting-group-toolbar-label';
    label.textContent = 'Greeting groups';
    const input = document.createElement('input');
    input.className = 'text_pole stplus-greeting-group-new-name';
    input.type = 'text';
    input.placeholder = 'New group name';
    input.setAttribute('aria-label', 'New greeting group name');
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'menu_button stplus-greeting-group-add';
    add.textContent = '+';
    add.title = 'Add greeting group';
    const addGroup = () => {
        const name = input.value.trim();
        if (!name || data.groups.some(group => group.name.toLowerCase() === name.toLowerCase())) return;
        const group = { id: 'group-' + fingerprint(name) + '-' + Date.now().toString(36), name };
        data.groups.push(group);
        const charKey = key(char);
        runtimeGroupsByCharacter.set(charKey, data.groups);
        // Keep the active settings object synchronized even if a queued
        // SillyTavern settings save replaces the model object during refresh.
        const stored = settings?.greetingGroupsByCharacter?.[charKey];
        if (stored && stored !== data) stored.groups = data.groups;
        input.value = '';
        persistSettings();
        queue();
    };
    add.addEventListener('click', addGroup);
    // SillyTavern's popup and global hotkey handlers can observe pointer and
    // key events before this dynamically-added control is focused. Explicitly
    // focus on pointer down, then stop bubbling so those handlers cannot steal
    // the interaction. Do not prevent the default pointer action: that keeps
    // the browser's normal caret placement and selection behavior intact.
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            addGroup();
        }
    });
    const firstLabel = document.createElement('span');
    firstLabel.className = 'stplus-greeting-group-toolbar-label';
    firstLabel.textContent = 'First:';
    const firstSelect = document.createElement('select');
    firstSelect.className = 'stplus-greeting-group-select';
    firstSelect.setAttribute(OWNED, '1');
    firstSelect.setAttribute('aria-label', 'First greeting group');
    updateGroupSelect(firstSelect, data.groups, data.greetings[0]?.groupId ?? '');
    firstSelect.addEventListener('change', () => {
        data.greetings[0].groupId = firstSelect.value || null;
        persistSettings();
        queue();
    });
    toolbar.append(label, input, add, firstLabel, firstSelect);
    list.before(toolbar);

    popup.querySelectorAll('.alternate_greeting').forEach(block => {
        const index = Number(block.dataset.index) + 1;
        if (!Number.isInteger(index)) return;
        const control = document.createElement('div');
        control.className = 'stplus-greeting-group-control';
        control.setAttribute(OWNED, '1');
        const select = document.createElement('select');
        select.className = 'stplus-greeting-group-select';
        select.setAttribute(OWNED, '1');
        select.setAttribute('aria-label', 'Greeting ' + index + ' group');
        updateGroupSelect(select, data.groups, data.greetings[index]?.groupId ?? '');
        select.addEventListener('change', () => {
            data.greetings[index].groupId = select.value || null;
            persistSettings();
            queue();
        });
        control.append(select);
        block.prepend(control);
    });
}

function refreshChat(data) {
    document.querySelectorAll('#chat .mes [' + OWNED + ']').forEach(element => element.remove());
    const group = groupFor(data, activeGreetingIndex());
    const first = document.querySelector('#chat .mes[mesid="0"], #chat .mes[data-mesid="0"]');
    const name = first?.querySelector('.ch_name');
    if (group && name) name.append(badge('Greeting · ' + group.name));
}

function refreshPicker(data) {
    document.querySelectorAll('.swipe_picker_popup [' + OWNED + ']').forEach(element => element.remove());
    const popup = Array.from(document.querySelectorAll('.swipe_picker_popup'))
        .sort((left, right) => right.querySelectorAll('.swipe_picker_block').length - left.querySelectorAll('.swipe_picker_block').length)[0];
    if (!popup) return;
    const messageId = popup.closest('.mes')?.getAttribute('mesid') ?? popup.dataset.mesid;
    if (messageId !== null && messageId !== undefined && messageId !== '0') return;
    popup.querySelectorAll('.swipe_picker_block').forEach((block, index) => {
        const group = groupFor(data, index);
        if (group) block.append(badge(group.name));
    });
}

function refreshTree(data) {
    const tree = document.querySelector('#stplus-branching-chats-window');
    if (!tree) return;
    tree.querySelectorAll('[' + OWNED + ']').forEach(element => element.remove());
    tree.querySelectorAll('button.stplus-branching-node[data-source-index="0"]').forEach(button => {
        const index = Number(button.dataset.swipeIndex);
        const group = groupFor(data, Number.isInteger(index) ? index : 0);
        if (group) button.append(badge(group.name, true));
    });
}

function refresh() {
    queued = false;
    try {
    if (settings?.greetingGroupsEnabled === false) {
        document.querySelectorAll('[' + OWNED + ']').forEach(element => element.remove());
        return;
    }
    const char = character();
    if (!char) return;
    const data = model(char);
    refreshEditor(char, data);
    refreshChat(data);
    refreshPicker(data);
    refreshTree(data);
    } catch (error) {
        console.error('[SillyTavernPlus] Greeting groups refresh failed:', error);
    }
}

function queue() {
    if (queued) return;
    queued = true;
    setTimeout(refresh, 0);
}

const api = {
    initialize(nextContext, nextSettings) {
        context = nextContext;
        settings = nextSettings;
        bindGroupInputListeners();
        if (!observer && document.body && globalThis.MutationObserver) {
            observer = new MutationObserver(mutations => {
                const external = mutations.some(mutation => Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes)).some(node => node.nodeType === 1 && !node.closest?.('[' + OWNED + ']')));
                if (external) queue();
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
        if (!poller) {
            poller = setInterval(() => {
                const popup = greetingPopup();
                if (popup?.querySelector('.alternate_greeting') && !popup.querySelector('.stplus-greeting-group-control')) queue();
                const picker = Array.from(document.querySelectorAll('.swipe_picker_popup'))
                    .sort((left, right) => right.querySelectorAll('.swipe_picker_block').length - left.querySelectorAll('.swipe_picker_block').length)[0];
                if (picker?.querySelector('.swipe_picker_block') && !picker.querySelector('[' + OWNED + ']')) {
                    const char = character();
                    if (char) {
                        const data = model(char, false);
                        const group = groupFor(data, 0);
                        const firstBlock = picker.querySelector('.swipe_picker_block');
                        if (group && firstBlock) firstBlock.append(badge(group.name));
                    }
                }
            }, 300);
        }
        const events = context?.eventSource;
        const types = context?.event_types ?? {};
        ['CHAT_CHANGED', 'CHAT_CREATED', 'CHAT_LOADED', 'MESSAGE_SWIPED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'GENERATION_ENDED']
            .forEach(name => { if (types[name] && events?.on) events.on(types[name], queue); });
        queue();
    },
    refresh: queue,
    onSettingsChanged(nextSettings) {
        settings = nextSettings;
        queue();
    },
    fingerprint,
};

export default api;
