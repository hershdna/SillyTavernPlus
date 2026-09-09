const DEFAULT_SETTINGS = Object.freeze({
    greetingModsEnabled: true,
    lorebookModsEnabled: true,
    movingUiResizeEnabled: true,
    reasoningScanEnabled: false,
    reasoningScanDepth: 1,
});

let context = null;
let settings = null;

function normalizeDepth(value) {
    const depth = Number.parseInt(value, 10);
    return Number.isInteger(depth) ? Math.max(1, Math.min(100, depth)) : DEFAULT_SETTINGS.reasoningScanDepth;
}

export function initializeSettings(stContext) {
    context = stContext;
    const extensionSettings = context.extensionSettings ?? {};
    const saved = extensionSettings.SillyTavernPlus ?? {};
    settings = {
        ...DEFAULT_SETTINGS,
        ...saved,
        greetingModsEnabled: saved.greetingModsEnabled !== false,
        lorebookModsEnabled: saved.lorebookModsEnabled !== false,
        movingUiResizeEnabled: saved.movingUiResizeEnabled !== false,
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

export { normalizeDepth };

