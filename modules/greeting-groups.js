import { save } from './settings-store.js';

const OWNED = 'data-stplus-greeting-groups';
const TOOLBAR = 'stplus-greeting-group-toolbar';
const SELECT = 'stplus-greeting-group-select';
const BADGE = 'stplus-greeting-group-badge';
const TREE_BADGE = 'stplus-greeting-group-tree-badge';

let context = null;
let settings = null;
let refreshQueued = false;
let refreshing = false;
let observer = null;

function enabled() {
    return settings?.greetingGroupsEnabled !== false;
}

function currentCharacter() {
    const ctx = context ?? globalThis.SillyTavern?.getContext?.() ?? {};
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    const id = Number.isInteger(ctx.this_chid) ? ctx.this_chid : Number.isInteger(ctx.characterId) ? ctx.characterId : null;
    if (id !== null && characters[id]) return characters[id];
    if (ctx.character && typeof ctx.character === 'object') return ctx.character;
    return null;
}

function characterKey(character) {
    return String(character?.avatar ?? character?.avatar_url ?? character?.name ?? 'unknown-character');
}

function greetingTexts(character) {
    return [character?.first_mes ?? '', ...(Array.isArray(character?.alternate_greetings) ? character.alternate_greetings : [])]
        .map(text => String(text ?? ''));
}

function fingerprint(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function makeId(text, index) {
    return 'greeting-' + fingerprint(text) + '-' + index;
}

function getStore() {
    if (!settings) return {};
    if (!settings.greetingGroupsByCharacter || typeof settings.greetingGroupsByCharacter !== 'object') {
        settings.greetingGroupsByCharacter = {};
    }
    return settings.greetingGroupsByCharacter;
}

function ensureModel(character, persist = true) {
    const key = characterKey(character);
    const texts = greetingTexts(character);
    const store = getStore();
    const old = store[key] && typeof store[key] === 'object' ? store[key] : { groups: [], greetings: [] };
    const oldGreetings = Array.isArray(old.greetings) ? old.greetings : [];
    const used = new Set();
    const nextGreetings = texts.map((text, index) => {
        const matches = oldGreetings
            .map((item, oldIndex) => ({ item, oldIndex }))
            .filter(({ item, oldIndex }) => !used.has(oldIndex) && item?.fingerprint === fingerprint(text));
        const match = matches[0] ?? (oldGreetings[index] && !used.has(index) ? { item: oldGreetings[index], oldIndex: index } : null);
        if (match) used.add(match.oldIndex);
        return {
            id: match?.item?.id ?? makeId(text, index),
            fingerprint: fingerprint(text),
            groupId: match?.item?.groupId ?? null,
        };
    });
    const model = {
        groups: Array.isArray(old.groups) ? old.groups.filter(group => group && group.id && group.name) : [],
        greetings: nextGreetings,
    };
    store[key] = model;
    if (persist) save();
    return model;
}

function groupFor(model, greetingIndex) {
    const groupId = model?.greetings?.[greetingIndex]?.groupId;
    return model?.groups?.find(group => group.id === groupId) ?? null;
}

function removeOwned(root = document) {
    root.querySelectorAll?.('[' + OWNED + ']').forEach(element => element.remove());
}

function makeBadge(text, tree = false) {
    const badge = document.createElement('span');
    badge.className = tree ? BADGE + ' ' + TREE_BADGE : BADGE;
    badge.setAttribute(OWNED, '1');
    badge.textContent = text;
    badge.title = text;
    return badge;
}

function addGroup(model, name, character) {
    const clean = String(name ?? '').trim();
    if (!clean || model.groups.some(group => group.name.toLowerCase() === clean.toLowerCase())) return;
    model.groups.push({
        id: 'group-' + fingerprint(clean) + '-' + Date.now().toString(36),
        name: clean,
    });
    ensureModel(character);
}

function buildGroupSelect(model, greetingIndex, character) {
    const select = document.createElement('select');
    select.className = SELECT;
    select.setAttribute(OWNED, '1');
    select.setAttribute('aria-label', 'Greeting ' + greetingIndex + ' group');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Ungrouped';
    select.append(none);
    for (const group of model.groups) {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        select.append(option);
    }
    select.value = model.greetings[greetingIndex]?.groupId ?? '';
    select.addEventListener('change', () => {
        model.greetings[greetingIndex].groupId = select.value || null;
        ensureModel(character);
        queueRefresh();
    });
    return select;
}

function refreshGreetingEditor(character, model) {
    const popup = document.querySelector('.alternate_grettings');
    const list = popup?.querySelector('.alternate_greetings_list');
    if (!popup || !list) return;
    popup.querySelectorAll('[' + OWNED + ']').forEach(element => element.remove());

    const toolbar = document.createElement('div');
    toolbar.className = TOOLBAR;
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
    add.addEventListener('click', () => {
        addGroup(model, input.value, character);
        input.value = '';
        queueRefresh();
    });
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') add.click();
    });
    toolbar.append(label, input, add);
    list.before(toolbar);

    popup.querySelectorAll('.alternate_greeting').forEach(block => {
        const alternateIndex = Number(block.dataset.index);
        if (!Number.isInteger(alternateIndex)) return;
        const greetingIndex = alternateIndex + 1;
        const control = document.createElement('div');
        control.className = 'stplus-greeting-group-control';
        control.setAttribute(OWNED, '1');
        control.append(buildGroupSelect(model, greetingIndex, character));
        block.prepend(control);
    });
}

function refreshChatBadge(model) {
    document.querySelectorAll('#chat .mes [' + OWNED + ']').forEach(element => element.remove());
    const group = groupFor(model, 0);
    const first = document.querySelector('#chat .mes[mesid="0"], #chat .mes[data-mesid="0"]');
    const name = first?.querySelector('.ch_name');
    if (group && name) name.append(makeBadge('Greeting · ' + group.name));
}

function refreshSwipePicker(model) {
    document.querySelectorAll('.swipe_picker_popup [' + OWNED + ']').forEach(element => element.remove());
    const popup = document.querySelector('.swipe_picker_popup');
    if (!popup) return;
    const messageId = popup.closest('.mes')?.getAttribute('mesid') ?? popup.dataset.mesid;
    if (messageId !== null && messageId !== undefined && messageId !== '0') return;
    popup.querySelectorAll('.swipe_picker_block').forEach((block, index) => {
        const group = groupFor(model, index);
        if (group) block.append(makeBadge(group.name));
    });
}

function refreshTree(model) {
    const tree = document.querySelector('#stplus-branching-chats-window');
    if (!tree) return;
    tree.querySelectorAll('[' + OWNED + ']').forEach(element => element.remove());
    tree.querySelectorAll('button.stplus-branching-node[data-source-index="0"]').forEach(button => {
        const swipeIndex = Number(button.dataset.swipeIndex);
        const group = groupFor(model, Number.isInteger(swipeIndex) ? swipeIndex : 0);
        if (!group) return;
        button.append(makeBadge(group.name, true));
        button.setAttribute('aria-label', (button.getAttribute('aria-label') ?? 'Greeting') + ' · ' + group.name);
    });
}

function doRefresh() {
    refreshQueued = false;
    if (refreshing) return;
    refreshing = true;
    try {
        if (!enabled()) {
            removeOwned();
            return;
        }
        const character = currentCharacter();
        if (!character) return;
        const model = ensureModel(character);
        refreshGreetingEditor(character, model);
        refreshChatBadge(model);
        refreshSwipePicker(model);
        refreshTree(model);
    } finally {
        refreshing = false;
    }
}

function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(doRefresh, 0);
}

function relevantMutation(mutation) {
    const target = mutation.target?.nodeType === 1 ? mutation.target : mutation.target?.parentElement;
    if (!target) return true;
    return !target.closest?.('[' + OWNED + ']');
}

const api = {
    initialize(nextContext, nextSettings) {
        context = nextContext;
        settings = nextSettings;
        if (!observer && document.body && globalThis.MutationObserver) {
            observer = new MutationObserver(mutations => {
                if (mutations.some(relevantMutation)) queueRefresh();
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
        const events = context?.eventSource;
        const eventTypes = context?.event_types ?? {};
        for (const name of ['CHAT_CHANGED', 'CHAT_CREATED', 'CHAT_LOADED', 'MESSAGE_SWIPED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'GENERATION_ENDED']) {
            const type = eventTypes[name];
            if (type && events?.on) events.on(type, queueRefresh);
        }
        queueRefresh();
    },
    refresh: queueRefresh,
    onSettingsChanged(nextSettings) {
        settings = nextSettings;
        queueRefresh();
    },
    fingerprint,
    getGreetingInfo(character) {
        const model = ensureModel(character, false);
        return greetingTexts(character).map((text, index) => ({ index, text, group: groupFor(model, index) }));
    },
};

export default api;
