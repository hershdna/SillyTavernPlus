(() => {
    'use strict';

    const scriptUrl = document.currentScript?.src;
    const extensionRoot = scriptUrl ? new URL('.', scriptUrl) : new URL('./', window.location.href);
    const loadModule = (name) => import(new URL(`modules/${name}.js`, extensionRoot));

    async function initialize() {
        const context = window.SillyTavern?.getContext?.();
        if (!context) {
            window.setTimeout(initialize, 250);
            return;
        }

        try {
            const [settingsStore, greetingMods, lorebookMods, settingsPanel] = await Promise.all([
                loadModule('settings-store'),
                loadModule('greeting-mods'),
                loadModule('lorebook-mods'),
                loadModule('settings-panel'),
            ]);
            const settings = settingsStore.initializeSettings(context);

            greetingMods.initialize(settings);
            lorebookMods.initialize(context, settings);
            settingsPanel.initialize(settings, {
                onGreetingModsChanged: () => greetingMods.refresh(),
                onLorebookModsChanged: () => lorebookMods.refresh(),
            });

            let scanScheduled = false;
            const scan = () => {
                scanScheduled = false;
                greetingMods.refresh();
                lorebookMods.refresh();
                settingsPanel.refresh();
            };
            const scheduleScan = () => {
                if (scanScheduled) return;
                scanScheduled = true;
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scan);
                else window.setTimeout(scan, 0);
            };
            const isRelevantMutation = (mutation) => {
                const target = mutation.target instanceof Element ? mutation.target : null;
                if (target?.closest('.alternate_grettings, #wiActivationSettings, #top-settings-holder, #top-bar')) return true;
                return Array.from(mutation.addedNodes).some((node) => {
                    if (!(node instanceof Element)) return false;
                    return node.matches('.alternate_grettings, #WorldInfo, #wiActivationSettings, #top-settings-holder, #top-bar')
                        || Boolean(node.querySelector('.alternate_grettings, #WorldInfo, #wiActivationSettings, #top-settings-holder, #top-bar'));
                });
            };

            scan();
            const observer = new MutationObserver((mutations) => {
                if (mutations.some(isRelevantMutation)) scheduleScan();
            });
            observer.observe(document.body, { childList: true, subtree: true });
        } catch (error) {
            console.error('[SillyTavernPlus] Failed to initialize:', error);
        }
    }

    initialize();
})();
