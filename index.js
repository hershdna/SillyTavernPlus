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
            const [settingsStore, greetingMods, lorebookMods, branchingChats, settingsPanel, movingUiResize, movingUiDrag, movingUiFront] = await Promise.all([
                loadModule('settings-store'),
                loadModule('greeting-mods'),
                loadModule('lorebook-mods'),
                loadModule('branching-chats'),
                loadModule('settings-panel'),
                loadModule('movingui-resize'),
                loadModule('movingui-drag'),
                loadModule('movingui-front'),
            ]);
            const settings = settingsStore.initializeSettings(context);

            greetingMods.initialize(settings);
            lorebookMods.initialize(context, settings);
            branchingChats.initialize(context, settings);
            movingUiResize.initialize(context, settings);
            movingUiDrag.initialize(context, settings);
            movingUiFront.initialize(context, settings);
            settingsPanel.initialize(settings, {
                onGreetingModsChanged: () => greetingMods.refresh(),
                onBranchingChatsChanged: () => branchingChats.refresh(),
                onLorebookModsChanged: () => lorebookMods.refresh(),
                onMovingUiResizeChanged: () => movingUiResize.refresh(),
                onMovingUiDragChanged: () => movingUiDrag.refresh(),
                onMovingUiBringToFrontChanged: () => movingUiFront.refresh(),
                onMovingUiOpenOnTopChanged: () => movingUiFront.refresh(),
                onMovingUiUnboundedResizeChanged: () => movingUiResize.refresh(),
            });

            let scanScheduled = false;
            const scan = () => {
                scanScheduled = false;
                greetingMods.refresh();
                lorebookMods.refresh();
                // Branching chats owns its own chat lifecycle and graph
                // synchronization. Do not refresh it for unrelated UI
                // mutations such as MovingUI z-index changes.
                settingsPanel.refresh();
                movingUiResize.refresh();
                movingUiDrag.refresh();
                movingUiFront.refresh();
            };
            const scheduleScan = () => {
                if (scanScheduled) return;
                scanScheduled = true;
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scan);
                else window.setTimeout(scan, 0);
            };
            const frontingMutationSelector = '#movingDivs, #top-settings-holder, #top-bar, [data-dragged], [role="dialog"], .stplus-branching-window, .ui-dialog, .ui-autocomplete, .popup';
            const branchingWindowSelector = '#stplus-branching-chats-window';
            const isInsideBranchingWindow = (element) => {
                const branchingWindow = document.querySelector(branchingWindowSelector);
                return element instanceof Element && branchingWindow instanceof Element
                    && element !== branchingWindow
                    && branchingWindow.contains(element);
            };
            const isRelevantMutation = (mutation) => {
                const target = mutation.target instanceof Element ? mutation.target : null;
                // Rendering selection must not trigger another global scan:
                // the branch module rebuilds its buttons during a scan, and
                // observing those children can detach the button being clicked.
                if (isInsideBranchingWindow(target)) return false;
                if (target === document.body || target?.matches(frontingMutationSelector) || target?.closest(`.alternate_grettings, #WorldInfo, #wiCheckboxes, #wiActivationSettings, #top-settings-holder, #top-bar, #extensionTopBar, ${frontingMutationSelector}`)) return true;
                return Array.from(mutation.addedNodes).some((node) => {
                    if (!(node instanceof Element)) return false;
                    if (node.matches(branchingWindowSelector)) return true;
                    if (isInsideBranchingWindow(node)) return false;
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
