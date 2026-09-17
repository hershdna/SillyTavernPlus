(() => {
    'use strict';

    // The manifest entrypoint is loaded as a classic script. Capture its
    // source URL while document.currentScript is still available, then use
    // that URL to resolve sibling modules. import.meta is invalid syntax in
    // a classic script and would prevent the entire extension from loading.
    const extensionScript = document.currentScript
        || Array.from(document.scripts).find((script) => script.src.includes('SillyTavernPlus') && script.src.includes('/index.js'));
    const extensionRoot = extensionScript?.src
        ? new URL('./', extensionScript.src)
        : new URL('./', window.location.href);
    // Use a changing query parameter so reloaded extensions receive the
    // current module source instead of a stale ESM cache entry.
    const MODULE_CACHE_VERSION = '0.5.100';
    const loadModule = (name) => {
        const moduleUrl = new URL('modules/' + name + '.js?v=' + MODULE_CACHE_VERSION, extensionRoot);
        return import(moduleUrl);
    };

    async function initialize() {
        const context = window.SillyTavern?.getContext?.();
        if (!context || !document.body) {
            window.setTimeout(initialize, 250);
            return;
        }

        try {
            const [settingsStore, greetingMods, lorebookMods, branchingChats, chatVisibleEdit, chatHistory, settingsPanel, movingUiResize, movingUiDrag, movingUiFront] = await Promise.all([
                loadModule('settings-store'),
                loadModule('greeting-mods'),
                loadModule('lorebook-mods'),
                loadModule('branching-chats'),
                loadModule('chat-visible-edit'),
                loadModule('chat-history'),
                loadModule('settings-panel'),
                loadModule('movingui-resize'),
                loadModule('movingui-drag'),
                loadModule('movingui-front'),
            ]);
            const settings = settingsStore.initializeSettings(context);

            greetingMods.initialize(settings);
            lorebookMods.initialize(context, settings);
            branchingChats.initialize(context, settings);
            chatVisibleEdit.initialize(context, settings);
            chatHistory.initialize(context, settings);
            movingUiResize.initialize(context, settings);
            movingUiDrag.initialize(context, settings);
            movingUiFront.initialize(context, settings);
            settingsPanel.initialize(settings, {
                onGreetingModsChanged: () => greetingMods.refresh(),
                onBranchingChatsChanged: () => branchingChats.refresh(),
                onFormattedMessageEditChanged: () => chatVisibleEdit.refresh(),
                onChatHistoryChanged: () => chatHistory.refresh(),
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
                chatVisibleEdit.refresh();
                chatHistory.refresh();
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
            // Perform the branch module's initial install/sync once. Later
            // generic UI scans intentionally leave its selection state alone.
            branchingChats.refresh();
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
