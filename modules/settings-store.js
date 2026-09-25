const DEFAULT_SETTINGS = Object.freeze({
    greetingModsEnabled: true,
    galleryEnabled: true,
    greetingTagsEnabled: true,
    personaCombinationEnabled: true,
    personaCombinationSelected: [],
    personaCombinationPrimary: null,
    branchingChatsEnabled: true,
    formattedMessageEditEnabled: true,
    lorebookModsEnabled: true,
    movingUiResizeEnabled: true,
    movingUiDragEnabled: true,
    movingUiBringToFrontEnabled: true,
    movingUiOpenOnTopEnabled: true,
    movingUiUnboundedResizeEnabled: true,
    chatHistoryEnabled: true,
    chatHistoryAutoInjectEnabled: true,
    chatHistoryPrompt: 'Write a concise bullet list of only the important events, decisions, facts, relationships, and unresolved threads. Do not include filler or commentary about the summary itself.',
    chatHistoryInjectionHeader: 'Chat history summary:',
    chatHistoryInjectionDepth: 4,
    reasoningScanEnabled: false,
    reasoningScanDepth: 1,
});

let context = null;
let settings = null;

function normalizeDepth(value) {
    const depth = Number.parseInt(value, 10);
    return Number.isInteger(depth) ? Math.max(1, Math.min(100, depth)) : DEFAULT_SETTINGS.reasoningScanDepth;
}

function normalizeChatHistoryDepth(value) {
    const depth = Number.parseInt(value, 10);
    return Number.isInteger(depth) ? Math.max(0, Math.min(100, depth)) : DEFAULT_SETTINGS.chatHistoryInjectionDepth;
}

export function initializeSettings(stContext) {
    context = stContext;
    const extensionSettings = context.extensionSettings ?? {};
    const saved = extensionSettings.SillyTavernPlus ?? {};
    settings = {
        ...DEFAULT_SETTINGS,
        ...saved,
        greetingModsEnabled: saved.greetingModsEnabled !== false,
        galleryEnabled: saved.galleryEnabled !== false,
        greetingTagsEnabled: saved.greetingTagsEnabled !== false,
        personaCombinationEnabled: saved.personaCombinationEnabled !== false,
        personaCombinationSelected: Array.isArray(saved.personaCombinationSelected)
            ? [...new Set(saved.personaCombinationSelected.filter((value) => typeof value === 'string' && value))]
            : [],
        personaCombinationPrimary: typeof saved.personaCombinationPrimary === 'string' && saved.personaCombinationPrimary
            ? saved.personaCombinationPrimary
            : null,
        branchingChatsEnabled: saved.branchingChatsEnabled !== false,
        formattedMessageEditEnabled: saved.formattedMessageEditEnabled !== false,
        lorebookModsEnabled: saved.lorebookModsEnabled !== false,
        movingUiResizeEnabled: saved.movingUiResizeEnabled !== false,
        movingUiDragEnabled: saved.movingUiDragEnabled !== false,
        movingUiBringToFrontEnabled: saved.movingUiBringToFrontEnabled !== false,
        movingUiOpenOnTopEnabled: saved.movingUiOpenOnTopEnabled !== false,
        movingUiUnboundedResizeEnabled: saved.movingUiUnboundedResizeEnabled !== false,
        chatHistoryEnabled: saved.chatHistoryEnabled !== false,
        chatHistoryAutoInjectEnabled: saved.chatHistoryAutoInjectEnabled !== false,
        chatHistoryPrompt: typeof saved.chatHistoryPrompt === 'string' && saved.chatHistoryPrompt.trim()
            ? saved.chatHistoryPrompt
            : DEFAULT_SETTINGS.chatHistoryPrompt,
        chatHistoryInjectionHeader: typeof saved.chatHistoryInjectionHeader === 'string'
            ? saved.chatHistoryInjectionHeader
            : DEFAULT_SETTINGS.chatHistoryInjectionHeader,
        chatHistoryInjectionDepth: normalizeChatHistoryDepth(saved.chatHistoryInjectionDepth),
        reasoningScanEnabled: saved.reasoningScanEnabled === true,
        reasoningScanDepth: normalizeDepth(saved.reasoningScanDepth),
    };
    extensionSettings.SillyTavernPlus = settings;
    return settings;
}

export function save() {
    context?.saveSettingsDebounced?.();
}

export function getSettings() {
    return settings ?? DEFAULT_SETTINGS;
}

export { normalizeDepth, normalizeChatHistoryDepth };
