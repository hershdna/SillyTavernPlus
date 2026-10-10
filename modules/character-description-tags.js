import { writeExtensionField } from '/scripts/extensions.js';

const CARD_SETTINGS_KEY = 'stplus_character_description_tags';
const CONTROL_ID = 'stplus-character-description-tags-card';

let context = null;
let settings = null;
let listenerBound = false;
let cardWriteInFlight = null;
let pendingCardWrite = null;

export function normalizeTags(tags) {
    const values = Array.isArray(tags) ? tags : String(tags ?? '').split(/[\n,]/);
    const seen = new Set();
    return values
        .map((tag) => String(tag ?? '').trim())
        .filter((tag) => {
            if (!tag || seen.has(tag)) return false;
            seen.add(tag);
            return true;
        });
}

function isEnabled() {
    return settings?.characterDescriptionTagFilterEnabled !== false;
}

function getLiveContext() {
    return (typeof window !== 'undefined' ? window.SillyTavern?.getContext?.() : null) ?? context;
}

function getDefinedTags() {
    return getCardSettings().tags;
}

function getCurrentCharacter() {
    const liveContext = getLiveContext();
    const characterId = Number(liveContext?.characterId);
    return Number.isInteger(characterId) ? liveContext?.characters?.[characterId] ?? null : null;
}

function normalizeCardSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        tags: normalizeTags(source.tags),
        includePreceding: source.includePreceding === true,
        includeSucceeding: source.includeSucceeding === true,
    };
}

function getCardSettings(character = getCurrentCharacter()) {
    return normalizeCardSettings(character?.data?.extensions?.[CARD_SETTINGS_KEY]);
}

function updateCurrentCardSettings(update) {
    const liveContext = getLiveContext();
    const character = getCurrentCharacter();
    const characterId = Number(liveContext?.characterId);
    if (!character || !Number.isInteger(characterId)) return;
    const next = normalizeCardSettings({ ...getCardSettings(character), ...update });
    character.data ??= {};
    character.data.extensions ??= {};
    character.data.extensions[CARD_SETTINGS_KEY] = next;
    scheduleCardSave(characterId, next);
}

function scheduleCardSave(characterId, value) {
    // Write immediately so a card switch or refresh cannot discard the last
    // edit. Coalesce rapid typing into at most one follow-up server write.
    pendingCardWrite = { characterId, value: normalizeCardSettings(value) };
    if (cardWriteInFlight) return;
    cardWriteInFlight = (async () => {
        while (pendingCardWrite) {
            const next = pendingCardWrite;
            pendingCardWrite = null;
            await writeExtensionField(next.characterId, CARD_SETTINGS_KEY, next.value);
        }
    })().catch((error) => {
        console.error('[SillyTavernPlus] Failed to save character description tags', error);
    }).finally(() => {
        cardWriteInFlight = null;
        if (pendingCardWrite) scheduleCardSave(pendingCardWrite.characterId, pendingCardWrite.value);
    });
}

function getLatestBotMessageText(promptChat = []) {
    // The prompt-ready event contains the exact serialized conversation that
    // reaches the API. Context can lag behind it after a swipe or branch jump.
    const serializedChat = Array.isArray(promptChat) ? promptChat : [];
    const lastUserIndex = serializedChat.map((message) => message?.role).lastIndexOf('user');
    const priorConversation = lastUserIndex >= 0 ? serializedChat.slice(0, lastUserIndex) : serializedChat;
    const latestSerializedBot = [...priorConversation].reverse().find((message) => (
        message?.role === 'assistant'
        && typeof message?.content === 'string'
    ));
    if (latestSerializedBot) return latestSerializedBot.content;

    // Fallback for prompt formats that do not serialize conversation turns.
    const chat = Array.isArray(getLiveContext()?.chat) ? getLiveContext().chat : [];
    const latestBotMessage = [...chat].reverse().find((message) => (
        message?.is_system !== true
        && (message?.is_user === false || message?.role === 'assistant')
        && typeof message?.mes === 'string'
    ));
    return latestBotMessage?.mes ?? '';
}

export function findActiveTags(message, tags) {
    const source = String(message ?? '');
    const active = new Set();
    for (const tag of normalizeTags(tags)) {
        // Tags may appear in normal prose or in a generated comment block.
        // Bound the match so a shorter tag ("Stage 1") cannot match the start
        // of another defined state ("Stage 10").
        const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapedTag}(?=$|[^\\p{L}\\p{N}_])`, 'iu');
        if (pattern.test(source)) active.add(tag);
    }
    return active;
}

function normalizeHeaderLabel(value) {
    return String(value ?? '')
        .trim()
        .replace(/^(?:\*{1,3}|_{1,3}|`)+\s*/, '')
        .replace(/\s*(?:\*{1,3}|_{1,3}|`)+$/, '')
        .trim()
        .toLocaleLowerCase();
}

function getHeaderInfo(line, tags) {
    // A heading may be plain ("Stage 2:"), list-style ("- Stage 2:"),
    // or Markdown-emphasized ("-**Stage 2**:"). The colon is required.
    const match = String(line).match(/^\s*(?:[-+]\s*)?([^:\n]+?)\s*:\s*/);
    if (!match) return { isHeader: false, tag: null };
    const label = normalizeHeaderLabel(match[1]);
    const tag = normalizeTags(tags).find((candidate) => normalizeHeaderLabel(candidate) === label) ?? null;
    return { isHeader: true, tag };
}

export function expandAdjacentTags(activeTags, tags, options = {}) {
    const definedTags = normalizeTags(tags);
    const active = activeTags instanceof Set ? activeTags : new Set(activeTags ?? []);
    const expanded = new Set(active);
    for (const tag of active) {
        const index = definedTags.indexOf(tag);
        if (index < 0) continue;
        if (options.includePreceding === true && index > 0) expanded.add(definedTags[index - 1]);
        if (options.includeSucceeding === true && index < definedTags.length - 1) expanded.add(definedTags[index + 1]);
    }
    return expanded;
}

export function filterDescriptionByTags(description, activeTags, tags) {
    const source = String(description ?? '');
    const definedTags = normalizeTags(tags);
    if (!source || !definedTags.length) return source;

    const sections = [];
    let section = { tag: null, lines: [] };
    for (const line of source.split(/\r?\n/)) {
        const header = getHeaderInfo(line, definedTags);
        // Every colon-terminated heading begins a new category. Undefined headers
        // remain unfiltered, but must not be swallowed by a preceding pruned
        // recognized category.
        if (header.isHeader) {
            sections.push(section);
            section = { tag: header.tag, lines: [line] };
        } else {
            section.lines.push(line);
        }
    }
    sections.push(section);

    const selected = activeTags instanceof Set ? activeTags : new Set(activeTags ?? []);
    return sections
        .filter((entry) => entry.tag === null || selected.has(entry.tag))
        .map((entry) => entry.lines.join('\n'))
        .join('\n')
        .trim();
}

export function getFilteredDescription(description, latestMessage, tags, options = {}) {
    const definedTags = normalizeTags(tags);
    const activeTags = expandAdjacentTags(findActiveTags(latestMessage, definedTags), definedTags, options);
    return filterDescriptionByTags(description, activeTags, definedTags);
}

function handleChatCompletionPrompt(data) {
    if (!isEnabled() || !Array.isArray(data?.chat)) return;
    const cardSettings = getCardSettings();
    if (!cardSettings.tags.length) return;
    const descriptionPrompt = findDescriptionPrompt(data.chat, cardSettings.tags);
    if (!descriptionPrompt) return;
    descriptionPrompt.content = getFilteredDescription(descriptionPrompt.content, getLatestBotMessageText(data.chat), cardSettings.tags, cardSettings);
}

function findDescriptionPrompt(chat, tags) {
    // Prompt identifiers exist before ChatCompletion#getChat(), but SillyTavern
    // intentionally removes them from the public prompt-ready payload.
    const identified = chat.find((prompt) => prompt?.identifier === 'charDescription' && typeof prompt.content === 'string');
    if (identified) return identified;

    // The serialized payload retains content. The character description is the
    // system message containing the most configured Tag: headers. This also
    // works when SillyTavern has merged adjacent system messages.
    let bestPrompt = null;
    let bestScore = 0;
    for (const prompt of chat) {
        if (prompt?.role !== 'system' || typeof prompt.content !== 'string') continue;
        const matchedTags = new Set();
        for (const line of prompt.content.split(/\r?\n/)) {
            const header = getHeaderInfo(line, tags);
            if (header.tag) matchedTags.add(header.tag);
        }
        if (matchedTags.size > bestScore) {
            bestPrompt = prompt;
            bestScore = matchedTags.size;
        }
    }
    return bestPrompt;
}

function createControl() {
    const panel = document.createElement('section');
    panel.id = CONTROL_ID;
    panel.className = 'stplus-character-description-tag-panel flex-container flexFlowColumn';

    const heading = document.createElement('strong');
    heading.textContent = 'Description tags';
    const help = document.createElement('small');
    help.textContent = 'Per card. One tag per line. Tags found in the latest bot message activate matching Tag: sections.';
    const input = document.createElement('textarea');
    input.id = 'stplus-character-description-tag-list';
    input.rows = 3;
    input.placeholder = 'Stage 0\nStage 1\nUserRel 1';
    const options = document.createElement('div');
    options.className = 'stplus-character-description-tag-options flex-container';
    const preceding = createOption('stplus-character-description-tag-preceding', 'Include preceding tag', 'includePreceding');
    const succeeding = createOption('stplus-character-description-tag-succeeding', 'Include succeeding tag', 'includeSucceeding');
    options.append(preceding, succeeding);
    input.addEventListener('input', () => updateCurrentCardSettings({ tags: normalizeTags(input.value) }));
    panel.append(heading, help, input, options);
    return panel;
}

function createOption(id, labelText, key) {
    const label = document.createElement('label');
    label.className = 'checkbox_label stplus-character-description-tag-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.addEventListener('input', () => updateCurrentCardSettings({ [key]: input.checked }));
    label.append(input, document.createTextNode(labelText));
    return label;
}

function mountControl() {
    const descriptionWrapper = document.getElementById('descriptionWrapper');
    if (!(descriptionWrapper instanceof HTMLElement)) return null;
    let panel = document.getElementById(CONTROL_ID);
    if (!(panel instanceof HTMLElement)) {
        panel = createControl();
        descriptionWrapper.after(panel);
    }
    return panel;
}

function refreshControl() {
    const panel = mountControl();
    if (!(panel instanceof HTMLElement)) return;
    const character = getCurrentCharacter();
    panel.hidden = !character || !isEnabled();
    if (panel.hidden) return;
    const cardSettings = getCardSettings(character);
    const input = panel.querySelector('#stplus-character-description-tag-list');
    const preceding = panel.querySelector('#stplus-character-description-tag-preceding');
    const succeeding = panel.querySelector('#stplus-character-description-tag-succeeding');
    if (input instanceof HTMLTextAreaElement && document.activeElement !== input) input.value = cardSettings.tags.join('\n');
    if (preceding instanceof HTMLInputElement) preceding.checked = cardSettings.includePreceding;
    if (succeeding instanceof HTMLInputElement) succeeding.checked = cardSettings.includeSucceeding;
}

export function initialize(stContext, stSettings) {
    context = stContext;
    settings = stSettings;
    if (listenerBound) return;
    const event = context?.eventTypes?.CHAT_COMPLETION_PROMPT_READY;
    if (!event || !context?.eventSource?.on) return;
    context.eventSource.on(event, handleChatCompletionPrompt);
    listenerBound = true;
    if (typeof document !== 'undefined') refreshControl();
}

export function refresh() {
    refreshControl();
}
