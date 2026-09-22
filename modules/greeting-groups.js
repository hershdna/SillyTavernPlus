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
        groups: Array.isArray(old.groups) ? old.groups.filter(group => group?.id && group?.name) : [],
        greetings,
    };
    store[charKey] = result;
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
    popup.querySelectorAll('[' + OWNED + ']').forEach(element => element.remove());

    const toolbar = document.createElement('div');
    toolbar.className = 'stplus-greeting-group-toolbar';
    toolbar.setAttribute(OWNED, '1');
    const label = document.createElement('span');
    label.className = 'stplus-greeting-group-toolbar-label';
    label.textContent = 'Greeting groups';
    const input = document.createElement('input');
    input.className = 'stplus-greeting-group-new-name';
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
        data.groups.push({ id: 'group-' + fingerprint(name) + '-' + Date.now().toString(36), name });
        input.value = '';
        persistSettings();
        queue();
    };
    add.addEventListener('click', addGroup);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') addGroup(); });
    const firstLabel = document.createElement('span');
    firstLabel.className = 'stplus-greeting-group-toolbar-label';
    firstLabel.textContent = 'First:';
    const firstSelect = document.createElement('select');
    firstSelect.className = 'stplus-greeting-group-select';
    firstSelect.setAttribute(OWNED, '1');
    firstSelect.setAttribute('aria-label', 'First greeting group');
    const firstNone = document.createElement('option');
    firstNone.value = '';
    firstNone.textContent = 'Ungrouped';
    firstSelect.append(firstNone);
    data.groups.forEach(group => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        firstSelect.append(option);
    });
    firstSelect.value = data.greetings[0]?.groupId ?? '';
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
        const none = document.createElement('option');
        none.value = '';
        none.textContent = 'Ungrouped';
        select.append(none);
        data.groups.forEach(group => {
            const option = document.createElement('option');
            option.value = group.id;
            option.textContent = group.name;
            select.append(option);
        });
        select.value = data.greetings[index]?.groupId ?? '';
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
