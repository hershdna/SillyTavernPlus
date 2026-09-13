const MODULE_BUTTON_ID = 'stplus-branching-chats-button';
const WINDOW_ID = 'stplus-branching-chats-window';
const METADATA_KEY = 'stplusBranchingChats';
const GRAPH_BACKUP_STORAGE_PREFIX = 'stplus-branching-backup:';
const NODE_ID_FIELD = 'stplusBranchingNodeId';
const SCHEMA_VERSION = 3;
const SYNC_DELAY = 80;
const SWIPE_SYNC_DELAY = 500;
const PERSIST_DELAY = 350;
const CHAT_STATE_POLL_INTERVAL = 100;
const DEBUG_CHAT_LIFECYCLE = true;
let lastDebugState = '';

function debugChatLifecycle(phase, extra = {}) {
    if (!DEBUG_CHAT_LIFECYCLE) return;
    const state = {
        phase,
        chatKey: getChatKey(),
        chatIdentity: getChatIdentity(),
        chatLength: getChat().length,
        loadedChatKey,
        loadedChatRawKey,
        loadedChatEventKey,
        graphNodes: graph ? Object.keys(graph.nodes ?? {}).length : null,
        ...extra,
    };
    const serialized = JSON.stringify(state);
    if (serialized === lastDebugState) return;
    lastDebugState = serialized;
    console.warn('[SillyTavernPlus][chat-debug]', state);
}

let context = null;
let settings = null;
let panel = null;
let graph = null;
let loadedChatKey = null;
let lastChatSignature = '';
let selectedNodeId = null;
let syncTimer = null;
let persistTimer = null;
let listenersBound = false;
let generationActive = false;
let newChatPending = false;
let reloadChatPending = false;
let pendingSelectionNodeId = null;
let reloadTargetChatKey = null;
let chatLoadPending = false;
let loadedChatEventKey = null;
let loadedChatRawKey = null;
let reopenAfterChatLoad = false;
let jumpInProgress = false;
let persistRevision = 0;
let persistQueue = Promise.resolve();
let chatStateWatcher = null;
let observedChatIdentity = null;
let observedChatState = '';
let chatDomWatcher = null;
let chatDomSyncTimer = null;
// CHAT_CHANGED/CHAT_LOADED are the authoritative lifecycle signals. Keep
// the filename they report separately from the context snapshot because
// Connection Manager profile application can briefly leave getContext()
// one step behind the chat loader.
let lifecycleChatKey = null;
let pendingLifecycleChatKey = null;
let pendingLifecycleChatKeyUntil = 0;
const objectIdentityTokens = new WeakMap();
let nextObjectIdentityToken = 1;

function getObjectIdentityToken(value) {
    if (!value || typeof value !== 'object') return 'none';
    let token = objectIdentityTokens.get(value);
    if (!token) {
        token = nextObjectIdentityToken++;
        objectIdentityTokens.set(value, token);
    }
    return String(token);
}

function clearTreeViewport() {
    if (!panel) return;
    panel.querySelector('.stplus-branching-node-layer')?.replaceChildren();
    panel.querySelector('.stplus-branching-edge-layer')?.replaceChildren();
    const previewTitle = panel.querySelector('.stplus-branching-preview-title');
    const previewText = panel.querySelector('.stplus-branching-preview-text');
    const jumpButton = panel.querySelector('[data-action="jump"]');
    const status = panel.querySelector('.stplus-branching-status');
    if (previewTitle) previewTitle.textContent = 'Select a message node';
    if (previewText) previewText.textContent = 'Click a node to preview its message.';
    if (jumpButton instanceof HTMLButtonElement) jumpButton.disabled = true;
    if (status) status.textContent = 'Waiting for the current chat';
}

function isGenerationInProgress() {
    return generationActive || document.body?.dataset.generating === 'true';
}

function startChatDomWatcher() {
    if (chatDomWatcher || typeof MutationObserver !== 'function') return;
    const schedule = () => {
        window.clearTimeout(chatDomSyncTimer);
        chatDomSyncTimer = window.setTimeout(reconcile, 180);
    };
    const reconcile = () => {
        if (!settings?.branchingChatsEnabled) return;
        // The lifecycle flag is only advisory. CHAT_LOADED can be missed by
        // an extension, and waiting on it permanently strands the new chat
        // with an empty viewport. The current identity is the authoritative
        // fallback once chat data has actually changed.
        if (isGenerationInProgress()) {
            schedule();
            return;
        }
        const currentChatKey = getChatKey();
        const currentChatIdentity = getChatIdentity();
        if (!currentChatKey || !currentChatIdentity) {
            graph = null;
            loadedChatKey = null;
            lastChatSignature = '';
            selectedNodeId = null;
            pendingSelectionNodeId = null;
            clearTreeViewport();
            closeWindow();
            document.getElementById(MODULE_BUTTON_ID)?.remove();
            return;
        }
        const keepWindowOpen = panel?.classList.contains('stplus-branching-window-open') === true
            || reopenAfterChatLoad;
        const settledNewChat = currentChatIdentity !== loadedChatKey;
        // Do not let the advisory load flag suppress reconciliation. The
        // current chat state is the source of truth once #chat has settled.
        chatLoadPending = false;
        if (settledNewChat) {
            window.clearTimeout(syncTimer);
            window.clearTimeout(persistTimer);
            persistRevision += 1;
            graph = null;
            loadedChatKey = null;
            lastChatSignature = '';
            selectedNodeId = null;
            pendingSelectionNodeId = null;
            loadedChatEventKey = currentChatIdentity;
            loadedChatRawKey = currentChatKey;
            clearTreeViewport();
        }
        installButton();
        // Chat switching and chat rendering both mutate #chat. Rebuild after
        // the DOM has settled so this path also works when a ST lifecycle
        // event is not delivered to an extension listener.
        syncGraph(true);
        if (keepWindowOpen) panel?.classList.add('stplus-branching-window-open');
        reopenAfterChatLoad = false;
        render();
    };
    chatDomWatcher = new MutationObserver((mutations) => {
        const relevant = mutations.some((mutation) => {
            const target = mutation.target instanceof Element
                ? mutation.target
                : mutation.target?.parentElement;
            if (target?.closest?.('#chat')) return true;
            return Array.from(mutation.addedNodes ?? []).some((node) =>
                node instanceof Element && (node.id === 'chat' || node.closest?.('#chat')));
        });
        if (relevant) schedule();
    });
    chatDomWatcher.observe(document.body, { childList: true, subtree: true, characterData: true });
}
function startChatStateWatcher() {
    if (chatStateWatcher) return;
    // Some chat-browser paths replace the chat and/or metadata without
    // reliably emitting every lifecycle event to third-party extensions.
    // Observe the live state itself. The full message signature is included
    // because a few ST paths can reuse the first message object while loading
    // another file; the old identity-only watcher missed that transition.
    const check = () => {
        if (!settings?.branchingChatsEnabled) return;
        // Never consume the observed state while a response is streaming.
        // Otherwise the final state would look unchanged when generation
        // ends and the graph would miss the completed response.
        if (isGenerationInProgress()) return;
        const currentChatKey = getChatKey();
        const currentChatIdentity = getChatIdentity();
        const currentChatSignature = currentChatIdentity ? getChatSignature(getChat()) : '';
        const currentChatState = JSON.stringify([currentChatKey, currentChatIdentity, currentChatSignature]);
        if (currentChatState === observedChatState) return;
        observedChatState = currentChatState;
        if (!currentChatIdentity) {
            window.clearTimeout(syncTimer);
            window.clearTimeout(persistTimer);
            persistRevision += 1;
            chatLoadPending = false;
            graph = null;
            loadedChatKey = null;
            lastChatSignature = '';
            loadedChatEventKey = null;
            loadedChatRawKey = null;
            selectedNodeId = null;
            pendingSelectionNodeId = null;
            reopenAfterChatLoad = false;
            closeWindow();
            document.getElementById(MODULE_BUTTON_ID)?.remove();
            return;
        }
        // A changed load identity or raw chat key means a different chat was
        // loaded, even if the lifecycle event was absent or arrived early.
        if (currentChatIdentity !== loadedChatKey || currentChatKey !== loadedChatRawKey) {
            const keepWindowOpen = reopenAfterChatLoad
                || panel?.classList.contains('stplus-branching-window-open') === true;
            chatLoadPending = false;
            newChatPending = false;
            graph = null;
            loadedChatKey = null;
            lastChatSignature = '';
            selectedNodeId = null;
            pendingSelectionNodeId = null;
            loadedChatEventKey = currentChatIdentity;
            loadedChatRawKey = currentChatKey;
            syncGraph(true);
            if (keepWindowOpen) panel?.classList.add('stplus-branching-window-open');
            reopenAfterChatLoad = false;
            render();
            return;
        }
        // The chat can be replaced without a load event while retaining the
        // same identity. Force a viewport rebuild for that settled state.
        syncGraph(true);
    };
    chatStateWatcher = window.setInterval(check, CHAT_STATE_POLL_INTERVAL);
}

function getLiveContext() {
    // SillyTavern can replace chat and chat_metadata objects while loading a
    // chat. The context returned during extension startup may still reference
    // the old objects, so use a fresh context for stateful operations.
    try {
        return globalThis.SillyTavern?.getContext?.() ?? context;
    } catch (error) {
        // Some SillyTavern builds briefly throw while the selected character or
        // group is being swapped. Keep the extension alive and use the last
        // context until the next poll/event sees the settled chat.
        return context;
    }
}

const clone = (value) => {
    try {
        return structuredClone(value);
    } catch {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return value;
        }
    }
};

function newId() {
    if (globalThis.crypto?.randomUUID) return `stplus-${crypto.randomUUID()}`;
    return `stplus-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getChat() {
    const liveContext = getLiveContext();
    return Array.isArray(liveContext?.chat) ? liveContext.chat : [];
}

function normalizeChatKey(value) {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

function getLifecycleChatKey(detail) {
    // CHAT_LOADED is emitted as { detail: { id: characterIndex,
    // character: characters[characterIndex] } }. The character.chat field is
    // the chat filename; detail.id is only a character index and must never
    // be used as a chat ID.
    const loadedDetail = detail?.detail ?? detail;
    return normalizeChatKey(
        loadedDetail?.character?.chat
        ?? loadedDetail?.chatId
        ?? loadedDetail?.chat_id,
    );
}

function getContextChatKey(liveContext = getLiveContext()) {
    // getCurrentChatId() is the documented live accessor. Do not prefer a
    // context property first: some ST versions expose `chatId` as a snapshot
    // while the accessor has already moved to the newly opened chat.
    let currentChatId = null;
    try {
        currentChatId = liveContext?.getCurrentChatId?.();
    } catch (error) {
        currentChatId = null;
    }
    if (currentChatId === undefined || currentChatId === null || String(currentChatId).trim() === '') {
        currentChatId = liveContext?.chatId;
    }
    // Some SillyTavern builds expose the live selected character/group on the
    // context but return an empty value from getCurrentChatId() briefly while
    // a profile-backed chat is being applied. Resolve the same filename from
    // those documented context collections before using integrity.
    if (currentChatId === undefined || currentChatId === null || String(currentChatId).trim() === '') {
        const characterId = liveContext?.characterId;
        const character = characterId !== undefined && characterId !== null
            ? liveContext?.characters?.[characterId]
            : null;
        const groupId = liveContext?.groupId;
        const group = groupId !== undefined && groupId !== null
            ? liveContext?.groups?.find?.((item) => String(item?.id) === String(groupId))
            : null;
        currentChatId = group?.chat_id ?? character?.chat;
    }
    // Older SillyTavern context versions do not expose chatId at all. Since
    // Loaded chats have a stable metadata integrity token. Use it as a
    // chat-scoped fallback even before the filename accessor catches up. This
    // keeps later chat opens addressable without ever using the character ID
    // (which would incorrectly merge multiple chats for one character).
    if (currentChatId === undefined || currentChatId === null || String(currentChatId).trim() === '') {
        const integrity = liveContext?.chatMetadata?.integrity ?? liveContext?.chat_metadata?.integrity;
        // Integrity is created by SillyTavern before CHAT_LOADED and is
        // scoped to the chat file. Do not require chat.length here: a new
        // chat can be between metadata assignment and its first render.
        if (typeof integrity === 'string' && integrity.trim()) {
            currentChatId = `integrity:${integrity}`;
        }
    }
    return normalizeChatKey(currentChatId);
}

function getVisibleChatKey() {
    // The selected-chat field is maintained by SillyTavern's chat browser and
    // remains available on builds where the public context accessor is late
    // to update. Only use it when it contains a real filename; an empty field
    // is also used for the neutral/unsaved-chat state.
    const selectedChat = document.querySelector('#selected_chat_pole');
    return normalizeChatKey(selectedChat?.value ?? selectedChat?.getAttribute('value'));
}

function noteLifecycleChatKey(chatKey) {
    const normalized = normalizeChatKey(chatKey);
    if (!normalized) {
        lifecycleChatKey = null;
        pendingLifecycleChatKey = null;
        pendingLifecycleChatKeyUntil = 0;
        return;
    }
    lifecycleChatKey = normalized;
    // Keep an event-provided filename authoritative briefly while
    // getContext() catches up. After that window, the live accessor wins so
    // eventless chat-browser implementations can still be detected.
    pendingLifecycleChatKey = normalized;
    pendingLifecycleChatKeyUntil = Date.now() + 1500;
}

function getChatKey() {
    const liveContext = getLiveContext();
    const contextChatKey = getContextChatKey(liveContext) ?? getVisibleChatKey();
    if (pendingLifecycleChatKey) {
        if (contextChatKey === pendingLifecycleChatKey) {
            pendingLifecycleChatKey = null;
            pendingLifecycleChatKeyUntil = 0;
            lifecycleChatKey = contextChatKey;
        } else if (Date.now() < pendingLifecycleChatKeyUntil) {
            return pendingLifecycleChatKey;
        } else {
            pendingLifecycleChatKey = null;
            pendingLifecycleChatKeyUntil = 0;
        }
    }
    if (contextChatKey) {
        lifecycleChatKey = contextChatKey;
        return contextChatKey;
    }
    // Keep the event-provided filename as a stable fallback while an active
    // chat is still present. This covers builds where the context accessor
    // remains empty after chat load, while the active-chat checks prevent a
    // closed chat from resurrecting the previous tree.
    const hasActiveChatData = getChat().length > 0 || Boolean(getChatIntegrity());
    if (lifecycleChatKey && hasActiveChatData) return lifecycleChatKey;
    return null;
}

function getChatIdentity() {
    const chatKey = getChatKey();
    if (!chatKey) return null;
    // Chat IDs can be reused or remain unchanged while SillyTavern loads a
    // different file. Include the integrity value and the object identity
    // of the first loaded message as an in-memory load token. That token stays
    // stable while replies are appended, but changes when another chat file
    // is loaded—even when its greeting text is equal. Do not use metadata
    // object identity: updateChatMetadata replaces that object on every save.
    const firstMessage = getChat()[0] ?? null;
    return chatKey + '::' + (getChatIntegrity() ?? 'unknown')
        + '::first-' + getObjectIdentityToken(firstMessage);
}

const EMPTY_CHAT_METADATA = {};

function getChatMetadata() {
    const liveContext = getLiveContext();
    return liveContext?.chatMetadata ?? liveContext?.chat_metadata ?? EMPTY_CHAT_METADATA;
}

function getChatIntegrity() {
    const integrity = getChatMetadata()?.integrity;
    return typeof integrity === 'string' && integrity.trim() ? integrity : null;
}

function getGraphBackupStorageKey(chatId = getChatKey(), integrity = getChatIntegrity()) {
    if (!chatId) return null;
    return `${GRAPH_BACKUP_STORAGE_PREFIX}${encodeURIComponent(chatId)}:${encodeURIComponent(integrity ?? 'unknown')}`;
}

function readBackupGraph(currentChatId) {
    const storageKey = getGraphBackupStorageKey(currentChatId);
    if (!storageKey) return null;
    try {
        const raw = window.localStorage?.getItem(storageKey);
        if (!raw) return null;
        const stored = JSON.parse(raw);
        if (!stored || typeof stored !== 'object') return null;
        const currentIntegrity = getChatIntegrity();
        if (stored.chatId && currentChatId && String(stored.chatId) !== String(currentChatId)) return null;
        if (stored.chatIntegrity && currentIntegrity && stored.chatIntegrity !== currentIntegrity) return null;
        const backup = {
            schemaVersion: SCHEMA_VERSION,
            chatId: typeof stored.chatId === 'string' ? stored.chatId : currentChatId,
            chatIntegrity: typeof stored.chatIntegrity === 'string' ? stored.chatIntegrity : currentIntegrity,
            nodes: stored.nodes && typeof stored.nodes === 'object'
                ? Object.fromEntries(Object.entries(stored.nodes).filter(([, node]) => node && typeof node === 'object'))
                : {},
            activePath: Array.isArray(stored.activePath) ? stored.activePath.filter((id) => typeof id === 'string') : [],
        };
        normalizeGraph(backup);
        pruneEmptyNodes(backup);
        normalizeGraph(backup);
        return backup;
    } catch {
        return null;
    }
}

function mergeStoredGraphs(primary, backup) {
    if (!primary || !backup) return primary;
    const merged = clone(primary) ?? primary;
    const existingKeys = new Set(Object.values(merged.nodes ?? {}).map((node) => node?.key).filter(Boolean));
    for (const [id, node] of Object.entries(backup.nodes ?? {})) {
        if (merged.nodes[id] || existingKeys.has(node?.key)) continue;
        merged.nodes[id] = clone(node) ?? node;
        if (node?.key) existingKeys.add(node.key);
    }
    if ((!Array.isArray(merged.activePath) || merged.activePath.length === 0) && Array.isArray(backup.activePath)) {
        merged.activePath = [...backup.activePath];
    }
    normalizeGraph(merged);
    return merged;
}

function createGraph(chatId = null) {
    return { schemaVersion: SCHEMA_VERSION, chatId, chatIntegrity: getChatIntegrity(), nodes: {}, activePath: [] };
}

function readStoredGraph(currentChatId = getChatKey()) {
    let stored = getChatMetadata()?.[METADATA_KEY];
    if (typeof stored === 'string') {
        try {
            stored = JSON.parse(stored);
        } catch {
            stored = null;
        }
    }
    if (!stored || typeof stored !== 'object') {
        return mergeStoredGraphs(createGraph(currentChatId), readBackupGraph(currentChatId));
    }
    const currentIntegrity = getChatIntegrity();
    if (typeof stored.chatId === 'string' && currentChatId && stored.chatId !== currentChatId) {
        const sameRenamedChat = stored.chatIntegrity && currentIntegrity && stored.chatIntegrity === currentIntegrity;
        if (!sameRenamedChat) {
            return mergeStoredGraphs(createGraph(currentChatId), readBackupGraph(currentChatId));
        }
    }
    const storedNodes = stored.nodes && typeof stored.nodes === 'object' ? stored.nodes : {};
    const targetGraph = {
        schemaVersion: SCHEMA_VERSION,
        chatId: typeof stored.chatId === 'string' ? stored.chatId : null,
        chatIntegrity: typeof stored.chatIntegrity === 'string' ? stored.chatIntegrity : null,
        nodes: Object.fromEntries(Object.entries(storedNodes).filter(([, node]) => node && typeof node === 'object')),
        activePath: Array.isArray(stored.activePath) ? stored.activePath.filter((id) => typeof id === 'string') : [],
    };
    normalizeGraph(targetGraph);
    pruneEmptyNodes(targetGraph);
    normalizeGraph(targetGraph);
    // Metadata is authoritative, but retain a chat-scoped local mirror as a
    // recovery source if a competing save temporarily wrote an older header.
    return mergeStoredGraphs(targetGraph, readBackupGraph(currentChatId));
}

function writeStoredGraph() {
    if (!graph || !getChatKey()) return;
    const payload = clone(graph);
    // Keep a browser-local recovery mirror keyed by chat ID + integrity before
    // the asynchronous server save begins. This never crosses chats.
    try {
        const storageKey = getGraphBackupStorageKey();
        if (storageKey) window.localStorage?.setItem(storageKey, JSON.stringify(payload));
    } catch {
        // Private browsing/storage quotas must not prevent normal chat saves.
    }
    const liveContext = getLiveContext();
    if (typeof liveContext?.updateChatMetadata === 'function') {
        liveContext.updateChatMetadata({ [METADATA_KEY]: payload }, false);
    } else if (liveContext?.chatMetadata && typeof liveContext.chatMetadata === 'object') {
        liveContext.chatMetadata[METADATA_KEY] = payload;
    }
}

async function saveCurrentChat(liveContext = getLiveContext()) {
    // Current SillyTavern exposes saveChat; older builds may only expose
    // saveMetadata. Both persist the complete chat, so choose one API only.
    if (typeof liveContext?.saveChat === 'function') return liveContext.saveChat();
    if (typeof liveContext?.saveMetadata === 'function') return liveContext.saveMetadata();
    return undefined;
}

function schedulePersist() {
    writeStoredGraph();
    const chatKeyAtSchedule = getChatKey();
    const revision = ++persistRevision;
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
        // Serialize saves so an older request cannot finish after a newer
        // request and restore an incomplete graph. Also refuse to save if
        // the active chat changed while this revision was queued.
        persistQueue = persistQueue.catch(() => {}).then(async () => {
            if (revision !== persistRevision
                || !chatKeyAtSchedule
                || getChatKey() !== chatKeyAtSchedule
                || !graph) return;
            writeStoredGraph();
            const liveContext = getLiveContext();
            // SillyTavern's metadata save is a full chat save. One serialized
            // save prevents an older snapshot from overwriting this graph.
            await saveCurrentChat(liveContext);
        });
    }, PERSIST_DELAY);
}

function getActiveSwipeIndex(message) {
    if (!Array.isArray(message?.swipes) || message.swipes.length === 0) return 0;
    const value = Number.parseInt(message.swipe_id, 10);
    if (Number.isInteger(value) && value >= 0 && value < message.swipes.length) return value;
    const current = String(message?.mes ?? '');
    const matching = message.swipes.findIndex((swipe) => String(swipe) === current);
    return matching >= 0 ? matching : 0;
}

function getVariantContents(message) {
    if (Array.isArray(message?.swipes) && message.swipes.length > 0) {
        return message.swipes.map((swipe) => String(swipe ?? ''));
    }
    return [String(message?.mes ?? '')];
}

function getNodeRole(message) {
    if (message?.is_system === true || message?.role === 'system') return 'system';
    if (message?.is_user === true || message?.role === 'user') return 'user';
    return 'assistant';
}

function getNodeLabel(message, sourceIndex, swipeIndex, variantCount) {
    const role = getNodeRole(message);
    const name = String(message?.name ?? '').trim();
    const speaker = name || role;
    return variantCount > 1 ? `${speaker} ${sourceIndex + 1}.${swipeIndex + 1}` : `${speaker} ${sourceIndex + 1}`;
}

function getNodeDepth(node) {
    return Number.isInteger(node?.depth) ? node.depth : Math.max(0, Number(node?.sourceIndex) || 0);
}

function getNodeKey(parentId, sourceIndex, swipeIndex, content) {
    return `${parentId ?? 'root'}|${sourceIndex}|${swipeIndex}|${content}`;
}

function hasMeaningfulContent(content) {
    return String(content ?? '').trim().length > 0;
}

function hasMeaningfulNode(node) {
    return hasMeaningfulContent(node?.content)
        || hasMeaningfulContent(node?.message?.mes)
        || hasMeaningfulContent(node?.message?.reasoning)
        || hasMeaningfulContent(node?.message?.extra?.reasoning)
        || hasMeaningfulContent(node?.message?.extra?.reasoning_display_text)
        || hasMeaningfulContent(node?.message?.extra?.display_text);
}

// Earlier versions observed MESSAGE_RECEIVED and DOM mutations while a
// response was streaming. That produced a new node for every partial/empty
// assistant placeholder. Remove those legacy nodes and reconnect any child
// nodes to their real parent before rebuilding the active path.
function pruneEmptyNodes(targetGraph) {
    const emptyIds = new Set(Object.values(targetGraph?.nodes ?? {})
        .filter((node) => !hasMeaningfulNode(node))
        .map((node) => node.id));
    if (emptyIds.size === 0) return false;

    for (const node of Object.values(targetGraph.nodes)) {
        if (!emptyIds.has(node.parentId)) continue;
        const emptyParent = targetGraph.nodes[node.parentId];
        node.parentId = emptyParent?.parentId ?? null;
        node.key = getNodeKey(node.parentId, node.sourceIndex, node.swipeIndex, node.content);
    }
    emptyIds.forEach((id) => delete targetGraph.nodes[id]);
    targetGraph.activePath = (targetGraph.activePath ?? []).filter((id) => !emptyIds.has(id));
    normalizeGraph(targetGraph);
    return true;
}

// Stored graphs from the first versions used the linear chat index for layout.
// A branch is a tree edge, however, so depth must be derived from parent links.
// Normalize old metadata on load and also repair orphaned/cyclic links before
// the renderer uses it.
function normalizeGraph(targetGraph) {
    const nodes = targetGraph?.nodes ?? {};
    const validIds = new Set(Object.keys(nodes));
    for (const [id, node] of Object.entries(nodes)) {
        node.id = id;
        node.parentId = validIds.has(node.parentId) && node.parentId !== id ? node.parentId : null;
        node.sourceIndex = Number.isInteger(node.sourceIndex) ? node.sourceIndex : 0;
        node.swipeIndex = Number.isInteger(node.swipeIndex) ? node.swipeIndex : 0;
        node.variantCount = Math.max(1, Number(node.variantCount) || 1);
        node.createdAt = Number(node.createdAt) || 0;
    }

    const visiting = new Set();
    const resolved = new Map();
    const resolveDepth = (node) => {
        if (!node || resolved.has(node.id)) return resolved.get(node?.id) ?? 0;
        if (visiting.has(node.id)) {
            node.parentId = null;
            resolved.set(node.id, 0);
            return 0;
        }
        visiting.add(node.id);
        const parent = node.parentId ? nodes[node.parentId] : null;
        const depth = parent ? resolveDepth(parent) + 1 : 0;
        visiting.delete(node.id);
        resolved.set(node.id, depth);
        node.depth = depth;
        return depth;
    };
    Object.values(nodes).forEach(resolveDepth);
    targetGraph.activePath = (targetGraph.activePath ?? []).filter((id) => validIds.has(id));
    targetGraph.schemaVersion = SCHEMA_VERSION;
}

function getMessageNodeId(message, swipeIndex) {
    const swipeInfoId = message?.swipe_info?.[swipeIndex]?.extra?.[NODE_ID_FIELD];
    if (typeof swipeInfoId === 'string' && swipeInfoId.trim()) return swipeInfoId;
    const directId = message?.extra?.[NODE_ID_FIELD];
    return typeof directId === 'string' && directId.trim() ? directId : null;
}

function setMessageNodeId(message, swipeIndex, nodeId) {
    if (!message || typeof message !== 'object' || !nodeId) return;
    if (Array.isArray(message.swipes) && message.swipes.length > 0) {
        if (!Array.isArray(message.swipe_info)) {
            message.swipe_info = message.swipes.map(() => ({
                send_date: message.send_date,
                gen_started: void 0,
                gen_finished: void 0,
                extra: {},
            }));
        }
        if (!message.swipe_info[swipeIndex] || typeof message.swipe_info[swipeIndex] !== 'object') {
            message.swipe_info[swipeIndex] = { send_date: message.send_date, extra: {} };
        }
        if (!message.swipe_info[swipeIndex].extra || typeof message.swipe_info[swipeIndex].extra !== 'object') {
            message.swipe_info[swipeIndex].extra = {};
        }
        message.swipe_info[swipeIndex].extra[NODE_ID_FIELD] = nodeId;
        return;
    }
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    message.extra[NODE_ID_FIELD] = nodeId;
}

function findNodeByKey(key) {
    return Object.values(graph?.nodes ?? {}).find((node) => node.key === key) ?? null;
}

function findNodeByStructuralSlot(parentId, sourceIndex, swipeIndex, message) {
    const normalizedParentId = parentId ?? null;
    const role = getNodeRole(message);
    const candidates = Object.values(graph?.nodes ?? {}).filter((node) =>
        node.parentId === normalizedParentId
        && node.sourceIndex === sourceIndex
        && node.swipeIndex === swipeIndex
        && node.role === role);
    // A native swipe occupies one structural slot. Use the slot only when it
    // is unambiguous; legacy duplicate nodes must not be silently conflated.
    return candidates.length === 1 ? candidates[0] : null;
}

function updateNodeFromMessage(node, message, sourceIndex, swipeIndex, content, variantCount) {
    node.key = getNodeKey(node.parentId, sourceIndex, swipeIndex, content);
    node.content = content;
    node.sourceIndex = sourceIndex;
    node.swipeIndex = swipeIndex;
    node.variantCount = variantCount;
    node.role = getNodeRole(message);
    node.name = String(message?.name ?? '');
    node.label = getNodeLabel(message, sourceIndex, swipeIndex, variantCount);
    node.message = clone(message) ?? node.message;
    node.message.mes = content;
    if (Array.isArray(node.message.swipes) && node.message.swipes.length > 0) {
        node.message.swipe_id = swipeIndex;
    }
    setMessageNodeId(message, swipeIndex, node.id);
}

function ensureNode(parentId, message, sourceIndex, swipeIndex, content, variantCount) {
    const key = getNodeKey(parentId, sourceIndex, swipeIndex, content);
    const persistedId = getMessageNodeId(message, swipeIndex);
    const persistedNode = persistedId ? graph?.nodes?.[persistedId] : null;
    const normalizedParentId = parentId ?? null;
    if (persistedNode
        && persistedNode.parentId === normalizedParentId
        && persistedNode.sourceIndex === sourceIndex
        && persistedNode.swipeIndex === swipeIndex) {
        updateNodeFromMessage(persistedNode, message, sourceIndex, swipeIndex, content, variantCount);
        return persistedNode;
    }
    // The message-level ID is preferred, followed by the exact content key.
    // Some SillyTavern serializers/extensions omit unknown `extra` fields on
    // assistant messages, so the ID may be absent after reload. In that case
    // use the stable parent/depth/swipe slot before creating a new node.
    const existing = findNodeByKey(key)
        ?? findNodeByStructuralSlot(parentId, sourceIndex, swipeIndex, message);
    if (existing) {
        updateNodeFromMessage(existing, message, sourceIndex, swipeIndex, content, variantCount);
        return existing;
    }
    const nodeId = newId();
    setMessageNodeId(message, swipeIndex, nodeId);
    const snapshot = clone(message) ?? {};
    snapshot.mes = content;
    if (Array.isArray(snapshot.swipes) && snapshot.swipes.length > 0) snapshot.swipe_id = swipeIndex;
    const node = {
        id: nodeId,
        key,
        parentId: normalizedParentId,
        sourceIndex,
        depth: parentId && graph.nodes[parentId] ? getNodeDepth(graph.nodes[parentId]) + 1 : 0,
        swipeIndex,
        variantCount,
        role: getNodeRole(message),
        name: String(message?.name ?? ''),
        label: getNodeLabel(message, sourceIndex, swipeIndex, variantCount),
        content,
        message: snapshot,
        createdAt: Date.now(),
    };
    graph.nodes[node.id] = node;
    return node;
}

function getChatSignature(chat) {
    return JSON.stringify(chat.map((message) => ({
        mes: message?.mes,
        swipeId: message?.swipe_id,
        swipes: message?.swipes,
        name: message?.name,
        isUser: message?.is_user,
    })));
}


function mergeGeneratedSiblingIntoSwipe(message, parentId, sourceIndex) {
    // Alternate greetings are already native swipes on the first message.
    // They must not be mistaken for generated same-parent replies.
    if (parentId === null && sourceIndex === 0) return false;
    // When a user jumps back to a parent and generates a fresh assistant
    // reply, SillyTavern creates a new linear message. If the same parent
    // already has assistant replies in this graph, fold the fresh reply into
    // that turn's native swipe array so it remains vanilla-compatible.
    if (getNodeRole(message) !== 'assistant' || !hasMeaningfulContent(message?.mes)) return false;
    const siblings = Object.values(graph?.nodes ?? {})
        .filter((node) => node.parentId === (parentId ?? null)
            && node.sourceIndex === sourceIndex
            && node.role === 'assistant')
        .sort((a, b) => a.swipeIndex - b.swipeIndex || a.createdAt - b.createdAt);
    if (siblings.length === 0) return false;

    const variants = [];
    const addVariant = (content) => {
        const value = String(content ?? '');
        if (hasMeaningfulContent(value) && !variants.includes(value)) variants.push(value);
    };
    siblings.forEach((node) => addVariant(node.content));
    if (Array.isArray(message?.swipes)) message.swipes.forEach(addVariant);
    addVariant(message.mes);
    if (variants.length < 2) return false;

    const activeContent = String(message.mes ?? '');
    message.swipes = variants;
    message.swipe_id = Math.max(0, variants.lastIndexOf(activeContent));
    return true;
}

function syncGraph(force = false) {
    debugChatLifecycle('sync-enter', { force, generationActive, enabled: settings?.branchingChatsEnabled });
    if (!settings?.branchingChatsEnabled) return;
    // The chat array is intentionally mutable during generation. Wait for
    // GENERATION_ENDED so streaming/reasoning updates cannot become nodes.
    // Chat-load state must never block this function: some ST paths do not
    // deliver CHAT_LOADED to third-party listeners, and that would leave the
    // next chat permanently blank. The generation guard is sufficient.
    if (generationActive) {
        debugChatLifecycle('sync-blocked-generation');
        return;
    }
    const chatKey = getChatKey();
    const chatIdentity = getChatIdentity();
    if (!chatKey) {
        debugChatLifecycle('sync-no-chat-key');
        window.clearTimeout(syncTimer);
        window.clearTimeout(persistTimer);
        persistRevision += 1;
        graph = null;
        loadedChatKey = null;
        lastChatSignature = '';
        selectedNodeId = null;
        newChatPending = false;
        chatLoadPending = false;
        loadedChatEventKey = null;
        loadedChatRawKey = null;
        closeWindow();
        document.getElementById(MODULE_BUTTON_ID)?.remove();
        return;
    }
    if (newChatPending || loadedChatKey !== chatIdentity) {
        graph = newChatPending ? createGraph(chatKey) : readStoredGraph(chatKey);
        loadedChatKey = chatIdentity;
        lastChatSignature = '';
        selectedNodeId = null;
        newChatPending = false;
    }
    const chat = getChat();
    const signature = getChatSignature(chat);
    if (!force && signature === lastChatSignature) return;
    lastChatSignature = signature;
    if (!graph) graph = createGraph(chatKey);
    graph.chatId = chatKey;
    graph.chatIntegrity = getChatIntegrity();
    pruneEmptyNodes(graph);
    normalizeGraph(graph);

    let parentId = null;
    const activePath = [];
    chat.forEach((message, sourceIndex) => {
        mergeGeneratedSiblingIntoSwipe(message, parentId, sourceIndex);
        const variants = getVariantContents(message);
        const requestedSwipeIndex = Math.min(getActiveSwipeIndex(message), variants.length - 1);
        const activeSwipeIndex = hasMeaningfulContent(variants[requestedSwipeIndex])
            ? requestedSwipeIndex
            : variants.findIndex(hasMeaningfulContent);
        let activeNode = null;
        variants.forEach((content, swipeIndex) => {
            if (!hasMeaningfulContent(content)) return;
            const node = ensureNode(parentId, message, sourceIndex, swipeIndex, content, variants.length);
            if (swipeIndex === activeSwipeIndex) activeNode = node;
        });
        if (activeNode) {
            activePath.push(activeNode.id);
            parentId = activeNode.id;
        }
    });
    graph.activePath = activePath;
    normalizeGraph(graph);
    if (!selectedNodeId || !graph.nodes[selectedNodeId]) selectedNodeId = activePath.at(-1) ?? null;
    schedulePersist();
    debugChatLifecycle('sync-render', { signatureLength: signature.length });
    render();
}

function getPathToNode(nodeId) {
    const path = [];
    const seen = new Set();
    let node = graph?.nodes?.[nodeId];
    while (node && !seen.has(node.id)) {
        path.unshift(node);
        seen.add(node.id);
        node = node.parentId ? graph.nodes[node.parentId] : null;
    }
    return path;
}

function getSelectedNode() {
    return graph?.nodes?.[selectedNodeId] ?? null;
}

function getPreviewText(node) {
    const content = String(node?.content ?? '').trim();
    return content.length > 600 ? `${content.slice(0, 600)}…` : content;
}

function createButton(label, title, onClick, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button stplus-branching-button ${className}`.trim();
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
}

function getToolbarHost() {
    const candidates = ['#top-settings-holder', '#top-bar', '#extensionTopBar'];
    return candidates.map((selector) => document.querySelector(selector))
        .find((element) => element instanceof HTMLElement) ?? null;
}

function openWindow() {
    if (!getChatKey()) return;
    if (!panel) createWindow();
    syncGraph(true);
    panel.classList.add('stplus-branching-window-open');
    render();
}

function closeWindow() {
    panel?.classList.remove('stplus-branching-window-open');
    // The graph is rebuilt on the next open/load. Clear rendered nodes now so
    // an out-of-order lifecycle event can never leave the previous chat visible.
    clearTreeViewport();
}

function selectNode(nodeId) {
    if (!graph?.nodes?.[nodeId]) return;
    selectedNodeId = nodeId;
    // Keep the clicked DOM node alive. Rebuilding the whole graph here made
    // MovingUI/fronting observers detach the button before the browser could
    // complete the click/double-click sequence.
    updateSelectionPresentation();
}

async function jumpToSelected(nodeId = selectedNodeId) {
    if (nodeId && graph?.nodes?.[nodeId]) selectedNodeId = nodeId;
    if (jumpInProgress || !getChatKey()) return;
    const selected = getSelectedNode();
    const path = getPathToNode(selected?.id);
    const chat = getChat();
    if (!selected || path.length === 0 || !Array.isArray(chat)) return;

    jumpInProgress = true;
    const jumpButton = panel?.querySelector('[data-action="jump"]');
    if (jumpButton instanceof HTMLButtonElement) jumpButton.disabled = true;
    try {
        const chatKeyBeforeReload = getChatKey();
        const keepWindowOpen = panel?.classList.contains('stplus-branching-window-open') === true;
        const replacement = path.map((node) => clone(node.message) ?? { mes: node.content });
        // Alternate greetings are native first-message swipes in SillyTavern.
        // Preserve that structure even when jumping to a continuation below
        // the greeting, so subsequent replies remain attached to the swipe.
        const greetingMessage = createGreetingSwipeMessage(path[0], chat[0]);
        if (greetingMessage) replacement[0] = greetingMessage;
        chat.splice(0, chat.length, ...replacement);
        selectedNodeId = selected.id;
        pendingSelectionNodeId = selected.id;
        // Persist the new current endpoint before the reload begins.
        graph.activePath = path.map((node) => node.id);
        normalizeGraph(graph);
        lastChatSignature = '';
        const liveContext = getLiveContext();
        const willReload = typeof liveContext?.reloadCurrentChat === 'function';
        // Mark the reload before saving so lifecycle handlers retain this
        // graph even if SillyTavern emits an event during the save.
        if (willReload) {
            reloadTargetChatKey = chatKeyBeforeReload;
            reloadChatPending = true;
        }
        writeStoredGraph();
        // The selected path and chat_metadata are persisted together. The
        // helper chooses one compatible SillyTavern save API, never both.
        await saveCurrentChat(liveContext);
        if (willReload) {
            try {
                await liveContext.reloadCurrentChat();
            } finally {
                reloadChatPending = false;
            }
        }
        if (getChatKey() !== chatKeyBeforeReload) {
            reloadTargetChatKey = null;
            pendingSelectionNodeId = null;
            return;
        }
        syncGraph(true);
        if (pendingSelectionNodeId && graph?.nodes?.[pendingSelectionNodeId]) selectedNodeId = pendingSelectionNodeId;
        pendingSelectionNodeId = null;
        if (keepWindowOpen) panel?.classList.add('stplus-branching-window-open');
        render();
        window.toastr?.success?.('Jumped to ' + selected.label);
    } finally {
        jumpInProgress = false;
        if (panel?.classList.contains('stplus-branching-window-open')) render();
    }
}
function createGreetingSwipeMessage(node, currentFirstMessage = null) {
    if (!node
        || node.sourceIndex !== 0
        || node.parentId !== null
        || node.role !== 'assistant'
        || !Array.isArray(node.message?.swipes)
        || node.message.swipes.length === 0) {
        return null;
    }
    const source = clone(node.message) ?? {};
    const swipes = source.swipes.map((swipe) => String(swipe ?? ''));
    const selectedSwipeIndex = Math.min(Math.max(0, Number(node.swipeIndex) || 0), swipes.length - 1);
    const message = clone(currentFirstMessage) ?? source;
    message.swipes = swipes;
    message.swipe_id = selectedSwipeIndex;
    if (Array.isArray(source.swipe_info)) message.swipe_info = clone(source.swipe_info);
    message.mes = swipes[selectedSwipeIndex] ?? String(node.content ?? '');
    if (!Array.isArray(message.swipe_info)) message.swipe_info = [];
    while (message.swipe_info.length < swipes.length) {
        message.swipe_info.push({
            send_date: message.send_date,
            gen_started: void 0,
            gen_finished: void 0,
            extra: {},
        });
    }
    message.swipe_info = message.swipe_info.slice(0, swipes.length);
    return message;
}

function getExportPath() {
    const selected = getSelectedNode();
    return selected ? getPathToNode(selected.id) : (graph?.activePath ?? []).map((id) => graph.nodes[id]).filter(Boolean);
}

function flattenForExport(node) {
    const message = clone(node?.message) ?? {};
    message.mes = String(node?.content ?? message.mes ?? '');
    delete message.swipes;
    delete message.swipe_id;
    delete message.swipe_info;
    return message;
}

function exportSelectedBranch() {
    if (!getChatKey()) return;
    const path = getExportPath();
    if (path.length === 0) {
        window.toastr?.warning?.('There are no chat messages to export yet.');
        return;
    }
    const metadata = clone(getChatMetadata()) ?? {};
    delete metadata[METADATA_KEY];
    const lines = [JSON.stringify({ chat_metadata: metadata }), ...path.map(flattenForExport).map((message) => JSON.stringify(message))];
    const blob = new Blob([`${lines.join('\n')}\n`], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${getChatKey().replace(/[^a-z0-9_-]+/gi, '_')}-branch.jsonl`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    window.toastr?.success?.('Selected branch exported as a vanilla SillyTavern chat.');
}

function getCurrentNodeId() {
    return graph?.activePath?.at(-1) ?? null;
}

function updateSelectionPresentation() {
    if (!panel || !graph) return;
    const currentNodeId = getCurrentNodeId();
    panel.querySelectorAll('.stplus-branching-node').forEach((button) => {
        const nodeId = button.dataset.nodeId;
        const node = graph.nodes[nodeId];
        if (!node) return;
        const isSelected = nodeId === selectedNodeId;
        const isActive = nodeId === currentNodeId;
        button.classList.toggle('stplus-branching-node-selected', isSelected);
        button.classList.toggle('stplus-branching-node-active', isActive);
        button.title = (isActive ? 'Current chat message\n' : '') + (isSelected ? 'Selected for preview/jump\n' : '') + node.label + '\n' + getPreviewText(node);
        button.setAttribute('aria-label', node.label + (isActive ? ' (current chat message)' : '') + (isSelected ? ' (selected)' : ''));
    });
    const selected = getSelectedNode();
    const previewTitle = panel.querySelector('.stplus-branching-preview-title');
    const previewText = panel.querySelector('.stplus-branching-preview-text');
    const jumpButton = panel.querySelector('[data-action="jump"]');
    if (previewTitle) previewTitle.textContent = selected ? selected.label + (selected.variantCount > 1 ? ' · variant ' + (selected.swipeIndex + 1) + '/' + selected.variantCount : '') : 'Select a message node';
    if (previewText) previewText.textContent = selected ? (getPreviewText(selected) || '(empty message)') : 'Click a node to preview its message. Double-click or use Jump to Here to make it the active chat path.';
    if (jumpButton instanceof HTMLButtonElement) jumpButton.disabled = !selected;
}

function getNodeIdFromEvent(event) {
    const target = event.target instanceof Element ? event.target.closest('.stplus-branching-node') : null;
    return target instanceof HTMLButtonElement && panel?.querySelector('.stplus-branching-node-layer')?.contains(target)
        ? target.dataset.nodeId
        : null;
}

function handleNodeLayerPointerDown(event) {
    if (event.button !== 0) return;
    const nodeId = getNodeIdFromEvent(event);
    if (!nodeId) return;
    // Select on the first reliable primary-pointer event. This avoids losing
    // selection when another extension cancels the later compatibility click.
    event.stopPropagation();
    selectNode(nodeId);
}

function handleNodeLayerPointerUp(event) {
    const nodeId = getNodeIdFromEvent(event);
    if (!nodeId) return;
    // Some extensions cancel the compatibility click event after pointer-up.
    // Select here as a fallback without preventing the browser's click.
    event.stopPropagation();
    selectNode(nodeId);
}

function handleNodeLayerClick(event) {
    const nodeId = getNodeIdFromEvent(event);
    if (!nodeId) return;
    event.preventDefault();
    event.stopPropagation();
    selectNode(nodeId);
}

function handleNodeLayerDoubleClick(event) {
    const nodeId = getNodeIdFromEvent(event);
    if (!nodeId) return;
    event.preventDefault();
    event.stopPropagation();
    selectNode(nodeId);
    void jumpToSelected(nodeId);
}

function createNodeButton(node, position, query) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stplus-branching-node';
    button.dataset.nodeId = node.id;
    button.style.left = `${position.x}px`;
    button.style.top = `${position.y}px`;
    const isSelected = node.id === selectedNodeId;
    // Only the final node is the currently visible message. Earlier nodes
    // remain in the path but do not receive the solid active fill.
    const isActive = node.id === getCurrentNodeId();
    button.classList.toggle('stplus-branching-node-selected', isSelected);
    button.classList.toggle('stplus-branching-node-active', isActive);
    const matches = !query || `${node.label} ${node.name} ${node.content}`.toLowerCase().includes(query);
    button.classList.toggle('stplus-branching-node-dimmed', !matches);
    button.title = `${isActive ? 'Current chat message\\n' : ''}${isSelected ? 'Selected for preview/jump\\n' : ''}${node.label}\\n${getPreviewText(node)}`;
    button.setAttribute('aria-label', `${node.label}${isActive ? ' (current chat message)' : ''}${isSelected ? ' (selected)' : ''}`);
    button.textContent = node.role === 'user' ? 'U' : node.role === 'system' ? 'S' : 'A';
    return button;
}

function render() {
    if (!panel || !graph) return;
    const nodeLayer = panel.querySelector('.stplus-branching-node-layer');
    const edgeLayer = panel.querySelector('.stplus-branching-edge-layer');
    const previewTitle = panel.querySelector('.stplus-branching-preview-title');
    const previewText = panel.querySelector('.stplus-branching-preview-text');
    const jumpButton = panel.querySelector('[data-action="jump"]');
    const status = panel.querySelector('.stplus-branching-status');
    if (!(nodeLayer instanceof HTMLElement) || !(edgeLayer instanceof SVGElement)) return;

    nodeLayer.replaceChildren();
    edgeLayer.replaceChildren();
    const nodes = Object.values(graph.nodes).sort((a, b) => getNodeDepth(a) - getNodeDepth(b) || a.createdAt - b.createdAt);
    const query = String(panel.querySelector('.stplus-branching-search')?.value ?? '').trim().toLowerCase();
    const children = new Map(nodes.map((node) => [node.id, []]));
    const roots = [];
    nodes.forEach((node) => {
        if (node.parentId && children.has(node.parentId)) children.get(node.parentId).push(node);
        else roots.push(node);
    });
    const compareNodes = (a, b) => a.createdAt - b.createdAt || a.sourceIndex - b.sourceIndex || a.swipeIndex - b.swipeIndex || a.id.localeCompare(b.id);
    children.forEach((items) => items.sort(compareNodes));
    roots.sort(compareNodes);
    const positions = new Map();
    let canvasWidth = 720;
    let canvasHeight = 300;
    let leafIndex = 0;
    const laidOut = new Set();
    const layoutNode = (node) => {
        if (!node || laidOut.has(node.id)) return positions.get(node.id)?.x ?? 0;
        laidOut.add(node.id);
        const nodeChildren = children.get(node.id) ?? [];
        let x;
        if (nodeChildren.length === 0) {
            x = 54 + leafIndex * 112;
            leafIndex += 1;
        } else {
            const childPositions = nodeChildren.map(layoutNode);
            x = childPositions.reduce((sum, value) => sum + value, 0) / childPositions.length;
        }
        const position = { x, y: 28 + getNodeDepth(node) * 92 };
        positions.set(node.id, position);
        canvasWidth = Math.max(canvasWidth, position.x + 96);
        canvasHeight = Math.max(canvasHeight, position.y + 76);
        return x;
    };
    roots.forEach(layoutNode);
    // Include any disconnected legacy nodes that were not reachable from a root.
    nodes.forEach(layoutNode);
    nodes.forEach((node) => {
        const position = positions.get(node.id);
        if (position) nodeLayer.appendChild(createNodeButton(node, position, query));
    });
    edgeLayer.setAttribute('width', String(canvasWidth));
    edgeLayer.setAttribute('height', String(canvasHeight));
    nodeLayer.style.width = `${canvasWidth}px`;
    nodeLayer.style.height = `${canvasHeight}px`;
    nodes.forEach((node) => {
        if (!node.parentId || !positions.has(node.parentId)) return;
        const start = positions.get(node.parentId);
        const end = positions.get(node.id);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(start.x + 22));
        line.setAttribute('y1', String(start.y + 22));
        line.setAttribute('x2', String(end.x + 22));
        line.setAttribute('y2', String(end.y + 22));
        line.classList.add('stplus-branching-edge');
        edgeLayer.appendChild(line);
    });

    const selected = getSelectedNode();
    if (previewTitle) previewTitle.textContent = selected ? `${selected.label}${selected.variantCount > 1 ? ` · variant ${selected.swipeIndex + 1}/${selected.variantCount}` : ''}` : 'Select a message node';
    if (previewText) previewText.textContent = selected ? (getPreviewText(selected) || '(empty message)') : 'Click a node to preview its message. Double-click or use Jump to Here to make it the active chat path.';
    if (jumpButton instanceof HTMLButtonElement) jumpButton.disabled = !selected;
    const currentNode = graph.nodes[getCurrentNodeId()];
    if (status) status.textContent = `${nodes.length} message node${nodes.length === 1 ? '' : 's'} · current ${currentNode?.label ?? 'none'}`;
}

function createWindow() {
    panel = document.createElement('section');
    panel.id = WINDOW_ID;
    panel.className = 'stplus-branching-window';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'SillyTavernPlus chat branches');

    const header = document.createElement('div');
    header.className = 'stplus-branching-header';
    const title = document.createElement('h3');
    title.textContent = 'Chat Branches';
    const status = document.createElement('small');
    status.className = 'stplus-branching-status';
    const close = createButton('×', 'Close chat branches', closeWindow, 'stplus-branching-close');
    close.setAttribute('aria-label', 'Close chat branches');
    header.append(title, status, close);

    const controls = document.createElement('div');
    controls.className = 'stplus-branching-controls';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'stplus-branching-search';
    search.placeholder = 'Search messages…';
    search.title = 'Filter the branch tree by message text or speaker';
    search.addEventListener('input', render);
    const refreshButton = createButton('Refresh', 'Rebuild the tree from the current chat', () => syncGraph(true));
    const jump = createButton('Jump to Here', 'Make the selected node the active chat path', jumpToSelected);
    jump.dataset.action = 'jump';
    const exportButton = createButton('Export Branch', 'Export the selected path as a vanilla SillyTavern JSONL chat', exportSelectedBranch);
    controls.append(search, refreshButton, jump, exportButton);

    const tree = document.createElement('div');
    tree.className = 'stplus-branching-tree';
    const edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    edgeLayer.classList.add('stplus-branching-edge-layer');
    const nodeLayer = document.createElement('div');
    nodeLayer.className = 'stplus-branching-node-layer';
    // Delegate node events from the persistent layer. Individual node
    // buttons are replaced when the graph is rebuilt, but this layer is not.
    nodeLayer.addEventListener('pointerdown', handleNodeLayerPointerDown);
    nodeLayer.addEventListener('pointerup', handleNodeLayerPointerUp);
    nodeLayer.addEventListener('click', handleNodeLayerClick);
    nodeLayer.addEventListener('dblclick', handleNodeLayerDoubleClick);
    tree.append(edgeLayer, nodeLayer);

    const preview = document.createElement('div');
    preview.className = 'stplus-branching-preview';
    const previewTitle = document.createElement('strong');
    previewTitle.className = 'stplus-branching-preview-title';
    const previewText = document.createElement('p');
    previewText.className = 'stplus-branching-preview-text';
    preview.append(previewTitle, previewText);

    const compatibility = document.createElement('small');
    compatibility.className = 'stplus-branching-compatibility';
    compatibility.textContent = 'This tree is a navigator for the current chat. Swipe/reroll variants and their continuations are stored in this chat’s metadata. Native SillyTavern Branch still creates a separate chat; use Export Branch for a vanilla-compatible copy.';

    const legend = document.createElement('small');
    legend.className = 'stplus-branching-legend';
    legend.textContent = 'Solid fill = current chat message · colored ring = selected node';
    panel.append(header, controls, legend, tree, preview, compatibility);
    document.body.appendChild(panel);
}

function installButton() {
    const host = getToolbarHost();
    if (!(host instanceof HTMLElement)) return;
    let button = document.getElementById(MODULE_BUTTON_ID);
    if (!(button instanceof HTMLButtonElement)) {
        button = createButton('Branches', 'Open SillyTavernPlus chat branches', openWindow, 'stplus-branching-toolbar-button');
        button.id = MODULE_BUTTON_ID;
        button.innerHTML = '<i class="fa-solid fa-code-branch" aria-hidden="true"></i><span>Branches</span>';
    }
    if (button.parentElement !== host) host.appendChild(button);
}

function bindEvents() {
    if (listenersBound) return;
    const liveContext = getLiveContext();
    const eventTypeSources = [context?.eventTypes, liveContext?.eventTypes]
        .filter((value) => value && typeof value === 'object');
    const eventSources = [...new Set([context?.eventSource, liveContext?.eventSource]
        .filter((value) => value && typeof value.on === 'function'))];
    const scheduleSync = (delay = SYNC_DELAY) => {
        window.clearTimeout(syncTimer);
        syncTimer = window.setTimeout(() => syncGraph(true), delay);
    };
    const onGenerationStarted = () => {
        generationActive = true;
        window.clearTimeout(syncTimer);
    };
    const onGenerationEnded = () => {
        generationActive = false;
        scheduleSync(0);
    };
    const onSafeChatMutation = () => {
        if (!generationActive) scheduleSync(0);
    };
    const onSwipe = () => {
        // Swiping emits before the replacement response is finished. Give
        // GENERATION_STARTED time to mark the stream active; GENERATION_ENDED
        // will perform the immediate final sync and cancel this timer.
        if (!generationActive) scheduleSync(SWIPE_SYNC_DELAY);
    };
    const onChatChanged = (chatId) => {
        debugChatLifecycle('event-chat-changed', { eventChatId: chatId });
        // CHAT_CHANGED is the stable lifecycle signal available across ST
        // releases. CHAT_LOADED is not present in every release and may be
        // delivered before or after this callback. Invalidate the watcher
        // cache here: otherwise it can already contain the new chat state,
        // see no change after we clear the graph, and leave the panel blank.
        window.clearTimeout(syncTimer);
        window.clearTimeout(persistTimer);
        persistRevision += 1;
        observedChatState = '';
        const eventChatKey = normalizeChatKey(chatId);
        noteLifecycleChatKey(eventChatKey);
        const currentChatKey = getChatKey();
        const wasOpen = panel?.classList.contains('stplus-branching-window-open') === true;
        if (currentChatKey) reopenAfterChatLoad = reopenAfterChatLoad || wasOpen;
        else reopenAfterChatLoad = false;

        const currentChatIdentity = getChatIdentity();
        // Retain state only when the loaded handler and this event agree. The
        // normal path below clears the viewport immediately, then the state
        // watcher or CHAT_LOADED rebuilds it from the newly active chat.
        const chatWasLoaded = eventChatKey !== null
            && currentChatKey === eventChatKey
            && loadedChatRawKey === eventChatKey
            && currentChatIdentity !== null
            && loadedChatEventKey === currentChatIdentity;
        chatLoadPending = false;
        if (chatWasLoaded) {
            // The loaded-chat handler already selected the new graph. Keep
            // the panel open state and refresh the viewport in this event too
            // because ST emits CHAT_CHANGED immediately afterward.
            if (!graph || loadedChatKey !== currentChatIdentity) {
                graph = null;
                loadedChatKey = null;
                lastChatSignature = '';
            }
            if (getChatKey() === eventChatKey) syncGraph(true);
            if (reopenAfterChatLoad) panel?.classList.add('stplus-branching-window-open');
            render();
            reopenAfterChatLoad = false;
            return;
        }

        closeWindow();
        reloadTargetChatKey = null;
        loadedChatEventKey = null;
        loadedChatRawKey = null;
        graph = null;
        loadedChatKey = null;
        lastChatSignature = '';
        selectedNodeId = null;
        pendingSelectionNodeId = null;
        if (currentChatKey) {
            installButton();
            // This is deliberately scheduled even when CHAT_LOADED exists:
            // older/current ST paths can omit it for chat-browser actions.
            scheduleSync(250);
        } else {
            chatLoadPending = false;
            loadedChatEventKey = null;
            loadedChatRawKey = null;
            // The event can arrive during the neutral/loading part of a
            // profile-backed chat switch. Leave the module alive and let the
            // state/DOM watchers install it once metadata or the chat ID is
            // available. A genuinely closed chat is handled by those same
            // watchers once both signals are empty.
            scheduleSync(250);
        }
    };

    const onChatCreated = () => {
        debugChatLifecycle('event-chat-created');
        // A fresh chat can emit CHAT_CREATED after CHAT_LOADED and
        // CHAT_CHANGED. In that order the graph is already the new chat's
        // graph; clearing it here would restore the stale-viewport bug.
        // CHAT_CREATED can be emitted after the chat state has already
        // changed. Invalidate the watcher cache for the same reason as
        // CHAT_CHANGED, and let the settled state decide what to load.
        observedChatState = '';
        const currentChatKey = getChatKey();
        const currentChatIdentity = getChatIdentity();
        const chatWasLoaded = currentChatIdentity !== null
            && loadedChatRawKey === currentChatKey
            && loadedChatEventKey === currentChatIdentity;
        if (chatWasLoaded) {
            newChatPending = false;
            chatLoadPending = false;
            installButton();
            syncGraph(true);
            if (reopenAfterChatLoad) panel?.classList.add('stplus-branching-window-open');
            render();
            reopenAfterChatLoad = false;
            return;
        }

        newChatPending = true;
        reloadTargetChatKey = null;
        chatLoadPending = false;
        window.clearTimeout(syncTimer);
        window.clearTimeout(persistTimer);
        persistRevision += 1;
        reopenAfterChatLoad = panel?.classList.contains('stplus-branching-window-open') === true;
        closeWindow();
        graph = null;
        loadedChatKey = null;
        lastChatSignature = '';
        selectedNodeId = null;
        pendingSelectionNodeId = null;
        if (getChatKey()) {
            installButton();
            scheduleSync(250);
        } else {
            chatLoadPending = false;
            document.getElementById(MODULE_BUTTON_ID)?.remove();
        }
    };

    const onChatLoaded = (detail) => {
        debugChatLifecycle('event-chat-loaded', { eventChatId: getLifecycleChatKey(detail) });
        // CHAT_LOADED is the authoritative point: chat and chat_metadata have
        // been replaced and SillyTavern has finished loading the file.
        const keepWindowOpen = reopenAfterChatLoad
            || panel?.classList.contains('stplus-branching-window-open') === true;
        reopenAfterChatLoad = keepWindowOpen;
        chatLoadPending = false;
        observedChatState = '';
        window.clearTimeout(syncTimer);
        const eventChatKey = getLifecycleChatKey(detail);
        noteLifecycleChatKey(eventChatKey);
        const currentChatKey = getChatKey();
        const currentChatIdentity = getChatIdentity();
        loadedChatEventKey = currentChatIdentity;
        loadedChatRawKey = currentChatKey;
        if (!currentChatKey) {
            graph = null;
            loadedChatKey = null;
            lastChatSignature = '';
            selectedNodeId = null;
            newChatPending = false;
            reopenAfterChatLoad = false;
            closeWindow();
            document.getElementById(MODULE_BUTTON_ID)?.remove();
            return;
        }
        const isSameChatReload = reloadChatPending
            || (reloadTargetChatKey && currentChatKey === reloadTargetChatKey);
        if (!isSameChatReload) {
            graph = null;
            loadedChatKey = null;
        }
        lastChatSignature = '';
        installButton();
        // Build the new graph now, while the chat file and metadata are
        // authoritative. This runs even if the branch window is hidden.
        syncGraph(true);
        if (keepWindowOpen) panel?.classList.add('stplus-branching-window-open');
        render();
    };

    const onChatDeleted = (deletedChat) => {
        // Deleting an unrelated chat from the chat browser must not discard
        // the tree for the chat that is still open. ST versions differ in
        // whether this event carries a string ID or an object, so only treat
        // it as unrelated when an explicit ID is available.
        const deletedChatId = typeof deletedChat === 'string'
            ? deletedChat
            : deletedChat?.chatId ?? deletedChat?.chat_id ?? deletedChat?.id;
        const currentChatId = getChatKey();
        if (deletedChatId && currentChatId && String(deletedChatId) !== currentChatId) return;
        newChatPending = false;
        reloadTargetChatKey = null;
        chatLoadPending = false;
        loadedChatEventKey = null;
        loadedChatRawKey = null;
        window.clearTimeout(syncTimer);
        window.clearTimeout(persistTimer);
        persistRevision += 1;
        observedChatState = '';
        closeWindow();
        graph = null;
        loadedChatKey = null;
        lastChatSignature = '';
        selectedNodeId = null;
        pendingSelectionNodeId = null;
        noteLifecycleChatKey(null);
        document.getElementById(MODULE_BUTTON_ID)?.remove();
    };
    const on = (name, handler) => {
        const eventNames = [...new Set(eventTypeSources
            .map((eventTypes) => eventTypes[name])
            .filter(Boolean))];
        eventSources.forEach((eventSource) => {
            eventNames.forEach((eventName) => eventSource.on(eventName, handler));
        });
    };
    on('GENERATION_STARTED', onGenerationStarted);
    on('GENERATION_ENDED', onGenerationEnded);
    on('CHAT_CHANGED', onChatChanged);
    on('CHAT_CREATED', onChatCreated);
    on('CHAT_LOADED', onChatLoaded);
    on('CHAT_DELETED', onChatDeleted);
    // Connection Manager applies a profile asynchronously. In that window
    // it can replace API-related context objects without emitting a chat
    // event, so give the chat lifecycle a fresh reconciliation opportunity.
    const onContextReady = () => {
        observedChatState = '';
        window.clearTimeout(syncTimer);
        scheduleSync(0);
    };
    on('CONNECTION_PROFILE_LOADED', onContextReady);
    on('APP_READY', onContextReady);
    on('MAIN_API_CHANGED', onContextReady);
    on('MESSAGE_SENT', onSafeChatMutation);
    on('MESSAGE_SWIPED', onSwipe);
    on('MESSAGE_UPDATED', onSafeChatMutation);
    on('MESSAGE_EDITED', onSafeChatMutation);
    on('MESSAGE_DELETED', onSafeChatMutation);
    // MESSAGE_RECEIVED is deliberately not used: SillyTavern can emit it
    // while a streamed response is still being assembled.
    listenersBound = true;
}

export function initialize(stContext, stSettings) {
    context = stContext;
    settings = stSettings;
    createWindow();
    bindEvents();
    startChatStateWatcher();
    startChatDomWatcher();
}

export function refresh() {
    if (!settings?.branchingChatsEnabled) {
        closeWindow();
        document.getElementById(MODULE_BUTTON_ID)?.remove();
        return;
    }
    if (!getChatKey()) {
        chatLoadPending = false;
        closeWindow();
        document.getElementById(MODULE_BUTTON_ID)?.remove();
        return;
    }
    installButton();
    syncGraph();
    render();
}

export { createGraph, getVariantContents, getActiveSwipeIndex };
