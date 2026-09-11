(() => {
    'use strict';

    // SillyTavern loads extension entrypoints as ES modules, where
    // document.currentScript is null. Resolve sibling modules from this file.
    const extensionRoot = new URL('./', import.meta.url);
    const loadModule = (name) => import(new URL(`modules/${name}.js`, extensionRoot));

    async function initialize() {
        const context = window.SillyTavern?.getContext?.();
        if (!context || !document.body) {
            window.setTimeout(initialize, 250);
            return;
        }

        try {
            const [settingsStore, greetingMods, lorebookMods, settingsPanel, movingUiResize, movingUiFront] = await Promise.all([
                loadModule('settings-store'),
                loadModule('greeting-mods'),
                loadModule('lorebook-mods'),
                loadModule('settings-panel'),
                loadModule('movingui-resize'),
                loadModule('movingui-front'),
            ]);
            const settings = settingsStore.initializeSettings(context);

            greetingMods.initialize(settings);
            lorebookMods.initialize(context, settings);
            movingUiResize.initialize(context, settings);
            movingUiFront.initialize(context, settings);
            settingsPanel.initialize(settings, {
                onGreetingModsChanged: () => greetingMods.refresh(),
                onLorebookModsChanged: () => lorebookMods.refresh(),
                onMovingUiResizeChanged: () => movingUiResize.refresh(),
                onMovingUiBringToFrontChanged: () => movingUiFront.refresh(),
                onMovingUiOpenOnTopChanged: () => movingUiFront.refresh(),
                onMovingUiUnboundedResizeChanged: () => movingUiResize.refresh(),
            });

            let scanScheduled = false;
            const scan = () => {
                scanScheduled = false;
                greetingMods.refresh();
                lorebookMods.refresh();
                settingsPanel.refresh();
                movingUiResize.refresh();
                movingUiFront.refresh();
            };
            const scheduleScan = () => {
                if (scanScheduled) return;
                scanScheduled = true;
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scan);
                else window.setTimeout(scan, 0);
            };
            const frontingMutationSelector = '#movingDivs, #top-settings-holder, #top-bar, [data-dragged], [role="dialog"], .ui-dialog, .popup';
            const isRelevantMutation = (mutation) => {
                const target = mutation.target instanceof Element ? mutation.target : null;
                if (target === document.body || target?.matches(frontingMutationSelector) || target?.closest(`.alternate_grettings, #WorldInfo, #wiCheckboxes, #wiActivationSettings, #top-settings-holder, #top-bar, #extensionTopBar, ${frontingMutationSelector}`)) return true;
                return Array.from(mutation.addedNodes).some((node) => {
                    if (!(node instanceof Element)) return false;
                    return node.matches(`.alternate_grettings, #WorldInfo, #wiCheckboxes, #wiActivationSettings, #top-settings-holder, #top-bar, #extensionTopBar, ${frontingMutationSelector}`)
                        || node.parentElement?.matches('#movingDivs, #top-settings-holder, #top-bar')
                        || Boolean(node.querySelector(`.alternate_grettings, #WorldInfo, #wiCheckboxes, #wiActivationSettings, #top-settings-holder, #top-bar, #extensionTopBar, ${frontingMutationSelector}`));
                });
            };

            scan();
            const observer = new MutationObserver((mutations) => {
                if (mutations.some(isRelevantMutation)) scheduleScan();
            });
            observer.observe(document.body, {
                attributes: true,
                attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-dragged'],
                childList: true,
                subtree: true,
            });
        } catch (error) {
            console.error('[SillyTavernPlus] Failed to initialize:', error);
        }
    }

    initialize();
})();

