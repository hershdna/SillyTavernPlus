const OWNED = 'data-stplus-greeting-tags';
const FIELD = 'stplus_greeting_tags';
let context;
let settings;
let queued = false;
let initialized = false;
const saves = new Map();
const models = new WeakMap();
const greetingFilters = new WeakMap();

export function fingerprint(text) {
    let hash = 2166136261;
    for (const char of String(text ?? '').replace(/\r\n?/g, '\n')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export function normalizeTags(values) {
    const seen = new Set();
    return values.map(value => String(value).trim()).filter(value => {
        const key = value.toLowerCase();
        if (!value || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function matchesTagFilter(tags, selected) {
    const wanted = normalizeTags(selected).map(tag => tag.toLowerCase());
    if (!wanted.length) return true;
    const available = new Set(normalizeTags(tags).map(tag => tag.toLowerCase()));
    return wanted.some(tag => available.has(tag));
}

// Match unchanged greetings before assigning edits by position. This prevents a
// deletion/reorder from stealing an adjacent greeting's identity and tags.
export function reconcileGreetings(previous, currentTexts) {
    const old = Array.isArray(previous?.greetings) ? previous.greetings : [];
    const used = new Set();
    const matches = currentTexts.map(text => {
        const fp = fingerprint(text);
        const index = old.findIndex((item, i) => !used.has(i) && item.fingerprint === fp);
        if (index >= 0) used.add(index);
        return index;
    });
    return {
        version: 1,
        greetings: currentTexts.map((text, index) => {
            const fp = fingerprint(text);
            let match = matches[index];
            if (match < 0 && old.length === currentTexts.length && !used.has(index)) {
                match = index;
                used.add(index);
            }
            const prior = old[match];
            return {
                id: prior?.id ?? `greeting-${fp}-${index}`,
                fingerprint: fp,
                aliases: [...new Set([...(prior?.aliases ?? []), ...(prior && prior.fingerprint !== fp ? [prior.fingerprint] : [])])],
                tags: normalizeTags(prior?.tags ?? []),
            };
        }),
        // Keep deleted greeting records for existing chats, but not in the editor.
        archived: [...(previous?.archived ?? []), ...old.filter((_, i) => !used.has(i))],
    };
}

function live() { return globalThis.SillyTavern?.getContext?.() ?? context ?? {}; }
function character() {
    const ctx = live();
    return ctx.characters?.[ctx.characterId ?? ctx.this_chid] ?? null;
}
function texts(char) { return [char.first_mes ?? char.data?.first_mes ?? '', ...(char.data?.alternate_greetings ?? char.alternate_greetings ?? [])]; }
function persist(char, data) {
    char.data ??= {};
    char.data.extensions ??= {};
    char.data.extensions[FIELD] = data;
    const pending = saves.get(char.avatar) ?? { chain: Promise.resolve() };
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
        const snapshot = JSON.parse(JSON.stringify(char.data.extensions[FIELD]));
        pending.chain = pending.chain.catch(() => {}).then(async () => {
            const ctx = live();
            const id = ctx.characters?.findIndex(item => item.avatar === char.avatar);
            if (id >= 0 && ctx.writeExtensionField) await ctx.writeExtensionField(id, FIELD, snapshot);
        }).catch(error => {
            console.error('[SillyTavernPlus] Could not save greeting tags', error);
            globalThis.toastr?.error('Could not save greeting tags. Please try again.');
        });
    }, 200);
    saves.set(char.avatar, pending);
}
function model(char) {
    const current = texts(char);
    const signature = JSON.stringify(current);
    const cached = models.get(char);
    if (cached?.signature === signature) return cached.data;
    const previous = char.data?.extensions?.[FIELD];
    const data = reconcileGreetings(previous, current);
    models.set(char, { signature, data });
    if (JSON.stringify(previous) !== JSON.stringify(data)) persist(char, data);
    return data;
}
function recordFor(data, text, index) {
    const fp = fingerprint(text);
    const all = [...data.greetings, ...data.archived];
    const positional = data.greetings[index];
    const ctx = live();
    const bindings = ctx.chatMetadata?.[FIELD] ?? {};
    const bindingKey = `${index}:${fp}`;
    // A chat's edited greeting can differ from the character card. Remember
    // its identity so later character reordering cannot change its tags.
    const bound = all.find(item => item.id === bindings[bindingKey]);
    const exact = positional && (positional.fingerprint === fp || positional.aliases.includes(fp))
        ? positional : all.find(item => item.fingerprint === fp || item.aliases.includes(fp));
    const record = bound ?? exact ?? positional;
    if (record && text && ctx.chatMetadata && bindings[bindingKey] !== record.id) {
        ctx.chatMetadata[FIELD] = { ...bindings, [bindingKey]: record.id };
        ctx.saveMetadataDebounced?.();
    }
    return record;
}
function tagsFor(data, text, index) { return recordFor(data, text, index)?.tags ?? []; }
function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.setAttribute(OWNED, '1');
    if (text !== undefined) node.textContent = text;
    return node;
}
function badge(text) { return element('span', 'stplus-greeting-tag-badge', text); }
function setupTagDropdown(dropdown) {
    dropdown.addEventListener('mouseenter', () => { dropdown.open = true; });
    dropdown.addEventListener('mouseleave', () => {
        if (!dropdown._pinned && !dropdown.contains(document.activeElement)) dropdown.open = false;
    });
    dropdown.addEventListener('focusin', () => { dropdown.open = true; });
    dropdown.addEventListener('focusout', event => {
        if (!dropdown._pinned && !dropdown.contains(event.relatedTarget)) dropdown.open = false;
    });
    return dropdown;
}
function tagDropdown(tags, className, matchingTags = tags) {
    const dropdown = setupTagDropdown(element('details', `stplus-tag-dropdown ${className}`));
    const summary = element('summary', 'stplus-tag-dropdown-toggle', `Tags (${tags.length})`);
    const list = element('div', 'stplus-tag-dropdown-list');
    list.replaceChildren(...matchingTags.map(badge));
    dropdown.append(summary, list);
    return dropdown;
}
function updateTagDropdown(dropdown, tags, matchingTags = tags) {
    const signature = JSON.stringify([tags, matchingTags]);
    if (dropdown.dataset.tags === signature) return dropdown;
    dropdown.dataset.tags = signature;
    dropdown.querySelector(':scope > summary').textContent = `Tags (${tags.length})`;
    dropdown.querySelector(':scope > .stplus-tag-dropdown-list').replaceChildren(...matchingTags.map(badge));
    return dropdown;
}
function place(block, control) {
    const summary = block.querySelector(':scope > details > summary');
    if (summary && control.previousElementSibling !== summary) summary.after(control);
}

function renderChips(control, record) {
    const chips = control.querySelector('.stplus-tag-chips');
    const signature = JSON.stringify(record.tags);
    if (chips.dataset.tags === signature) return;
    chips.dataset.tags = signature;
    chips.replaceChildren(...record.tags.map(tag => {
        const chip = element('span', 'stplus-greeting-tag-item');
        chip.dataset.tag = tag;
        chip.append(element('span', 'stplus-tag-name', tag));
        const remove = element('button', 'menu_button stplus-tag-remove', '×');
        remove.type = 'button';
        remove.title = `Remove tag ${tag}`;
        remove.setAttribute('aria-label', remove.title);
        chip.append(remove);
        return chip;
    }));
}
function editorControl(record, label) {
    const control = element('div', 'stplus-tag-editor');
    control.dataset.greetingId = record.id;
    control.append(element('span', 'stplus-tag-label', label), element('span', 'stplus-tag-chips'));
    const input = element('input', 'text_pole stplus-tag-input');
    input.type = 'text';
    input.placeholder = 'Add tag…';
    input.setAttribute('aria-label', `${label}: add tag`);
    input.title = 'Enter to add; paste multiple tags on separate lines';
    control.append(input);
    renderChips(control, record);
    return control;
}

function greetingFilterTags(data) {
    return normalizeTags(data.greetings.flatMap(record => record.tags ?? []));
}

function updateFilterSummary(control, selected) {
    const summary = control.querySelector(':scope > summary');
    if (summary) summary.textContent = selected.size ? `Filter tags (${selected.size})` : 'Filter tags';
}

function applyGreetingFilter(popup, data) {
    const list = popup.querySelector('.alternate_greetings_list');
    if (!list) return;
    const selected = greetingFilters.get(popup) ?? new Set();
    [...list.querySelectorAll(':scope > .alternate_greeting')].forEach((block, index) => {
        const record = data.greetings[index + 1];
        block.classList.toggle('stplus-greeting-filter-hidden', !matchesTagFilter(record?.tags ?? [], [...selected]));
    });
}

function renderFilterOptions(control, tags, selected) {
    const options = control.querySelector(':scope .stplus-greeting-filter-options');
    if (!options) return;
    const signature = JSON.stringify(tags);
    if (options.dataset.tags === signature) {
        options.querySelectorAll('input[type="checkbox"]').forEach(input => {
            input.checked = selected.has(input.value);
        });
        return;
    }
    options.dataset.tags = signature;
    options.replaceChildren(...tags.map(tag => {
        const label = element('label', 'stplus-greeting-filter-option');
        const input = element('input');
        input.type = 'checkbox';
        input.value = tag;
        input.checked = selected.has(tag);
        input.addEventListener('click', event => {
            event.preventDefault();
            input.checked = !input.checked;
            if (input.checked) selected.add(input.value);
            else selected.delete(input.value);
            const filter = input.closest('.stplus-greeting-filter');
            const popup = filter?.closest('.alternate_grettings');
            const data = popup?._stplusGreetingTagData;
            if (filter && popup && data) {
                updateFilterSummary(filter, selected);
                applyGreetingFilter(popup, data);
            }
        });
        input.addEventListener('change', () => {
            if (input.checked) selected.add(tag);
            else selected.delete(tag);
            updateFilterSummary(control, selected);
            const popup = control.closest('.alternate_grettings');
            const data = popup?._stplusGreetingTagData;
            if (popup && data) applyGreetingFilter(popup, data);
        });
        label.append(input, element('span', 'stplus-greeting-filter-name', tag));
        return label;
    }));
}

function refreshGreetingFilter(popup, data, list) {
    const tags = greetingFilterTags(data);
    let selected = greetingFilters.get(popup);
    if (!selected) {
        selected = new Set();
        greetingFilters.set(popup, selected);
    }
    for (const tag of [...selected]) {
        if (!tags.includes(tag)) selected.delete(tag);
    }
    let control = popup.querySelector(':scope > .stplus-greeting-filter');
    if (!tags.length) {
        control?.remove();
        greetingFilters.delete(popup);
        list.querySelectorAll(':scope > .alternate_greeting').forEach(block => block.classList.remove('stplus-greeting-filter-hidden'));
        return;
    }
    if (!control) {
        control = element('details', 'stplus-greeting-filter');
        const summary = element('summary', 'stplus-tag-dropdown-toggle', 'Filter tags');
        summary.setAttribute('aria-label', 'Filter alternate greetings by tag');
        const panel = element('div', 'stplus-greeting-filter-list');
        const options = element('div', 'stplus-greeting-filter-options');
        const clear = element('button', 'menu_button stplus-greeting-filter-clear', 'Clear');
        clear.type = 'button';
        clear.addEventListener('click', event => {
            event.preventDefault();
            selected.clear();
            updateFilterSummary(control, selected);
            control.open = true;
            applyGreetingFilter(popup, data);
            renderFilterOptions(control, tags, selected);
        });
        panel.append(options, clear);
        control.append(summary, panel);
        list.before(control);
    }
    popup._stplusGreetingTagData = data;
    updateFilterSummary(control, selected);
    renderFilterOptions(control, tags, selected);
    applyGreetingFilter(popup, data);
}

function refreshEditor(data) {
    for (const popup of document.querySelectorAll('.alternate_grettings')) {
        const list = popup.querySelector('.alternate_greetings_list');
        if (!list) continue;
        refreshGreetingFilter(popup, data, list);
        let first = popup.querySelector('.stplus-first-greeting-tags');
        if (!first) {
            first = editorControl(data.greetings[0], 'First greeting tags');
            first.classList.add('stplus-first-greeting-tags');
            list.before(first);
        }
        first.dataset.greetingId = data.greetings[0].id;
        renderChips(first, data.greetings[0]);
        [...list.querySelectorAll(':scope > .alternate_greeting')].forEach((block, i) => {
            const record = data.greetings[i + 1];
            if (!record) return;
            let control = block.querySelector('.stplus-tag-editor');
            if (!control) control = editorControl(record, `Greeting ${i + 1} tags`);
            if (control.dataset.greetingId !== record.id) control.querySelector('input').value = '';
            control.dataset.greetingId = record.id;
            renderChips(control, record);
            place(block, control);
        });
    }
}
function setBadges(parent, tags, className) {
    if (!parent) return;
    let container = parent.querySelector(`:scope > .${className}`);
    if (!tags.length) { container?.remove(); return; }
    if (!container) { container = tagDropdown(tags, className); parent.append(container); }
    updateTagDropdown(container, tags);
}
function refreshChat(data) {
    const first = live().chat?.[0];
    const index = Number(first?.swipe_id) || 0;
    setBadges(document.querySelector('#chat .mes[mesid="0"] .ch_name'),
        first ? tagsFor(data, first.mes, index) : [], 'stplus-chat-greeting-tags');
    for (const popup of document.querySelectorAll('.swipe_picker_popup')) {
        // Native picker blocks carry the raw swipe text. Only decorate a picker
        // whose displayed swipes belong to the greeting message.
        const blocks = [...popup.querySelectorAll('.swipe_picker_block')];
        const swipes = first?.swipes ?? [];
        blocks.forEach((block, i) => {
            const greetingPicker = block.querySelector('[id^="swipe_picker_expand_0_"]');
            const index = Number(block.dataset.swipeId) || i;
            setBadges(block, greetingPicker ? tagsFor(data, swipes[index], index) : [], 'stplus-picker-greeting-tags');
        });
    }
}
function refreshTree(data) {
    const tree = document.querySelector('#stplus-branching-chats-window');
    if (!tree) return;
    const query = String(tree.querySelector('.stplus-branching-search')?.value ?? '').trim().toLowerCase();
    for (const button of tree.querySelectorAll('.stplus-branching-node[data-source-index="0"]')) {
        const index = Number(button.dataset.swipeIndex) || 0;
        const raw = button.dataset.greetingText ?? live().chat?.[0]?.swipes?.[index] ?? '';
        const tags = tagsFor(data, raw, index);
        const matches = query ? tags.filter(tag => tag.toLowerCase().includes(query)) : tags;
        button.classList.toggle('stplus-greeting-tag-match', Boolean(query && matches.length));
        let dropdown = button.parentElement.querySelector(`.stplus-tree-tags[data-for-node="${CSS.escape(button.dataset.nodeId)}"]`);
        if (!tags.length) { dropdown?.remove(); continue; }
        if (!dropdown) {
            dropdown = tagDropdown(tags, 'stplus-tree-tags', matches);
            dropdown.dataset.forNode = button.dataset.nodeId;
            button.after(dropdown);
        }
        dropdown.style.left = button.style.left;
        dropdown.style.top = button.style.top;
        dropdown.classList.toggle('stplus-tag-search-match', Boolean(query && matches.length));
        updateTagDropdown(dropdown, tags, matches);
        if (query && !matches.length) dropdown.querySelector(':scope > .stplus-tag-dropdown-list').append(element('span', '', 'No matching tags'));
    }
}
function refresh() {
    queued = false;
    if (settings?.greetingTagsEnabled === false) {
        document.querySelectorAll(`[${OWNED}]`).forEach(node => node.remove());
        document.querySelectorAll('.stplus-greeting-tag-match').forEach(node => node.classList.remove('stplus-greeting-tag-match'));
        return;
    }
    const char = character();
    if (!char) return;
    try {
        const data = model(char);
        refreshEditor(data);
        refreshChat(data);
        refreshTree(data);
    } catch (error) { console.error('[SillyTavernPlus] Greeting tags refresh failed', error); }
}
function queue() { if (!queued) { queued = true; setTimeout(refresh, 0); } }
function edit(control, change) {
    const char = character();
    if (!char) return;
    const data = model(char);
    const record = data.greetings.find(item => item.id === control.dataset.greetingId);
    if (!record) return;
    record.tags = normalizeTags(change(record.tags));
    persist(char, data);
    queue();
}
function bind() {
    // Capture at window so native dialog hotkeys/MovingUI cannot eat spaces,
    // Enter, focus, or text-selection gestures on dynamically inserted controls.
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'keydown', 'keyup', 'paste', 'copy']) {
        window.addEventListener(type, event => {
            const target = event.target instanceof Element ? event.target : null;
            const control = target?.closest('.stplus-tag-editor');
            const filter = target?.closest('.stplus-greeting-filter');
            const dropdown = target?.closest('.stplus-tag-dropdown');
            if (filter) return;
            if (!control && !dropdown) return;
            event.stopPropagation();
            if (dropdown) {
                if (type === 'click' && target.closest('summary')) {
                    event.preventDefault();
                    dropdown._pinned = !dropdown._pinned;
                    dropdown.open = dropdown._pinned || dropdown.matches(':hover');
                }
                if (type === 'keydown' && event.key === 'Escape') {
                    event.preventDefault();
                    dropdown._pinned = false;
                    dropdown.open = false;
                }
                return;
            }
            const input = target.closest('.stplus-tag-input');
            if (input && (type === 'pointerdown' || type === 'mousedown')) input.focus();
            if (type === 'click' && target.closest('.stplus-tag-remove')) {
                event.preventDefault();
                const tag = target.closest('[data-tag]').dataset.tag;
                edit(control, tags => tags.filter(value => value !== tag));
            }
            if (input && type === 'keydown' && event.key === 'Enter' && !event.isComposing) {
                event.preventDefault();
                edit(control, tags => [...tags, input.value]);
                input.value = '';
            }
            if (input && type === 'paste') {
                const value = event.clipboardData?.getData('text/plain') ?? '';
                if (/[\r\n]/.test(value)) {
                    event.preventDefault();
                    edit(control, tags => [...tags, ...value.split(/\r?\n/)]);
                }
            }
            if (!input && type === 'copy') {
                const selection = window.getSelection();
                const selected = [...control.querySelectorAll('.stplus-tag-name')].filter(node => selection?.containsNode(node, true));
                if (selected.length) {
                    event.preventDefault();
                    event.clipboardData.setData('text/plain', selected.map(node => node.textContent).join('\n'));
                }
            }
        }, true);
    }
    document.addEventListener('input', event => {
        if (event.target.matches('.alternate_greeting_text, #firstmessage_textarea, .stplus-branching-search')) queue();
    });
    const observer = new MutationObserver(mutations => {
        if (mutations.some(mutation => !mutation.target.closest?.(`[${OWNED}]`) &&
            [...mutation.addedNodes, ...mutation.removedNodes].some(node => node.nodeType === 1 && !node.hasAttribute(OWNED)))) queue();
    });
    observer.observe(document.body, { childList: true, subtree: true });
}
export default {
    initialize(nextContext, nextSettings) {
        context = nextContext;
        settings = nextSettings;
        if (!initialized) {
            initialized = true;
            bind();
            const ctx = live();
            for (const name of ['CHAT_CHANGED', 'CHAT_CREATED', 'CHAT_LOADED', 'MESSAGE_SWIPED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'GENERATION_ENDED', 'CHARACTER_EDITED']) {
                if (ctx.event_types?.[name]) ctx.eventSource?.on(ctx.event_types[name], queue);
            }
        }
        queue();
    },
    refresh: queue,
    onSettingsChanged(nextSettings) { settings = nextSettings; queue(); },
    fingerprint,
};
