const MODULE_BUTTON_ID = 'stplus-branching-chats-button';
const WINDOW_ID = 'stplus-branching-chats-window';
const METADATA_KEY = 'stplusBranchingChats';
const GRAPH_BACKUP_STORAGE_PREFIX = 'stplus-branching-backup:';
const SCHEMA_VERSION = 3;
const SYNC_DELAY = 80;
const SWIPE_SYNC_DELAY = 500;
const PERSIST_DELAY = 350;

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
let jumpInProgress = false;
let persistRevision = 0;
let persistQueue = Promise.resolve();

function getLiveContext() {
    // SillyTavern can replace chat and chat_metadata objects while loading a
    // chat. The context returned during extension startup may still reference
    // the old objects, so use a fresh context for stateful operations.
    return globalThis.SillyTavern?.getContext?.() ?? context;
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

function getChatKey() {
    const liveContext = getLiveContext();
    const currentChatId = liveContext?.getCurrentChatId?.() ?? liveContext?.chatId;
    if (currentChatId === undefined || currentChatId === null || String(currentChatId).trim() === '') return null;
    return String(currentChatId);
}

function getChatMetadata() {
    const liveContext = getLiveContext();
    return liveContext?.chatMetadata ?? liveContext?.chat_metadata ?? {};
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
    if (!stored || typeof stored !== 'object') return createGraph(currentChatId);
    const currentIntegrity = getChatIntegrity();
    if (typeof stored.chatId === 'string' && currentChatId && stored.chatId !== currentChatId) {
        const sameRenamedChat = stored.chatIntegrity && currentIntegrity && stored.chatIntegrity === currentIntegrity;
        if (!sameRenamedChat) return createGraph(currentChatId);
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

// Earlier versions observed MESSAGE_RECEIVED and DOM mutations while a
// response was streaming. That produced a new node for every partial/empty
// assistant placeholder. Remove those legacy nodes and reconnect any child
// nodes to their real parent before rebuilding the active path.
function pruneEmptyNodes(targetGraph) {
    const emptyIds = new Set(Object.values(targetGraph?.nodes ?? {})
        .filter((node) => !hasMeaningfulContent(node?.content))
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

function findNodeByKey(key) {
    return Object.values(graph?.nodes ?? {}).find((node) => node.key === key) ?? null;
}

function ensureNode(parentId, message, sourceIndex, swipeIndex, content, variantCount) {
    const key = getNodeKey(parentId, sourceIndex, swipeIndex, content);
    const existing = findNodeByKey(key);
    if (existing) return existing;
    const snapshot = clone(message) ?? {};
    snapshot.mes = content;
    if (Array.isArray(snapshot.swipes) && snapshot.swipes.length > 0) snapshot.swipe_id = swipeIndex;
    const node = {
        id: newId(),
        key,
        parentId: parentId ?? null,
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
    if (!settings?.branchingChatsEnabled) return;
    // The chat array is intentionally mutable during generation. Wait for
    // GENERATION_ENDED so streaming/reasoning updates cannot become nodes.
    if (generationActive || chatLoadPending) return;
    const chatKey = getChatKey();
    if (!chatKey) {
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
        closeWindow();
        document.getElementById(MODULE_BUTTON_ID)?.remove();
        return;
    }
    if (newChatPending || loadedChatKey !== chatKey) {
        graph = newChatPending ? createGraph(chatKey) : readStoredGraph(chatKey);
        loadedChatKey = chatKey;
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
}

function selectNode(nodeId) {
    if (!graph?.nodes?.[nodeId]) return;
    selectedNodeId = nodeId;
    render();
}

async function jumpToSelected() {
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

function createNodeButton(node, position, query) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stplus-branching-node';
    button.dataset.nodeId = node.id;
    button.style.left = `${position.x}px`;
    button.style.top = `${position.y}px`;
    button.classList.toggle('stplus-branching-node-selected', node.id === selectedNodeId);
    const matches = !query || `${node.label} ${node.name} ${node.content}`.toLowerCase().includes(query);
    button.classList.toggle('stplus-branching-node-dimmed', !matches);
    button.title = `${node.label}\n${getPreviewText(node)}`;
    button.textContent = node.role === 'user' ? 'U' : node.role === 'system' ? 'S' : 'A';
    button.addEventListener('click', () => selectNode(node.id));
    button.addEventListener('dblclick', jumpToSelected);
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
    if (status) status.textContent = `${nodes.length} message node${nodes.length === 1 ? '' : 's'} · ${graph.activePath.length} active`;
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

    panel.append(header, controls, tree, preview, compatibility);
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
    const eventTypes = context?.eventTypes ?? {};
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
    const onChatChanged = () => {
        // CHAT_CHANGED identifies the new chat, but SillyTavern finishes
        // replacing its message and metadata objects on CHAT_LOADED.
        window.clearTimeout(syncTimer);
        window.clearTimeout(persistTimer);
        persistRevision += 1;
        const currentChatKey = getChatKey();
        const isSameChatReload = reloadChatPending
            || (reloadTargetChatKey && currentChatKey === reloadTargetChatKey);
        // SillyTavern's current load path emits CHAT_LOADED before
        // CHAT_CHANGED. Do not re-arm the load guard after metadata is ready.
        const chatWasLoaded = currentChatKey !== null && loadedChatEventKey === currentChatKey;
        chatLoadPending = Boolean(eventTypes.CHAT_LOADED) && !chatWasLoaded;
        if (isSameChatReload) {
            // Keep the window/selection for a same-chat reload, but do not
            // read or write metadata until the replacement chat is loaded.
            // Keep the current graph usable during a same-chat reload.
            // Only discard it when the earlier event order already cleared it.
            if (!graph || loadedChatKey !== currentChatKey) {
                graph = null;
                loadedChatKey = null;
            }
            lastChatSignature = '';
            if (!chatLoadPending) scheduleSync(0);
            // If this is the late CHAT_CHANGED emitted after the reload
            // promise resolved, consume the marker now. If it arrived
            // before resolution, reloadChatPending keeps it alive.
            if (!reloadChatPending) reloadTargetChatKey = null;
            return;
        }
        closeWindow();
        reloadTargetChatKey = null;
        graph = null;
        loadedChatKey = null;
        lastChatSignature = '';
        selectedNodeId = null;
        pendingSelectionNodeId = null;
        if (currentChatKey) {
            installButton();
            if (!chatLoadPending) scheduleSync(250);
        } else {
            chatLoadPending = false;
            loadedChatEventKey = null;
            document.getElementById(MODULE_BUTTON_ID)?.remove();
        }
    };
    const onChatCreated = () => {
        // A new chat must start with a new graph, and its metadata may not
        // be available until CHAT_LOADED.
        newChatPending = true;
        reloadTargetChatKey = null;
        const currentChatKey = getChatKey();
        const chatWasLoaded = currentChatKey !== null && loadedChatEventKey === currentChatKey;
        chatLoadPending = Boolean(eventTypes.CHAT_LOADED) && !chatWasLoaded;
        window.clearTimeout(syncTimer);
        window.clearTimeout(persistTimer);
        persistRevision += 1;
        closeWindow();
        graph = null;
        loadedChatKey = null;
        lastChatSignature = '';
        selectedNodeId = null;
        pendingSelectionNodeId = null;
        if (getChatKey()) {
            installButton();
            if (!chatLoadPending) scheduleSync(250);
        } else {
            chatLoadPending = false;
            document.getElementById(MODULE_BUTTON_ID)?.remove();
        }
    };
    const onChatLoaded = () => {
        // This is the safe point to read persisted chat metadata. Avoid the
        // old behavior where an early CHAT_CHANGED sync could overwrite it.
        chatLoadPending = false;
        window.clearTimeout(syncTimer);
        const currentChatKey = getChatKey();
        loadedChatEventKey = currentChatKey;
        if (!currentChatKey) {
            graph = null;
            loadedChatKey = null;
            lastChatSignature = '';
            selectedNodeId = null;
            newChatPending = false;
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
        scheduleSync(0);
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
        window.clearTimeout(syncTimer);
        window.clearTimeout(persistTimer);
        persistRevision += 1;
        closeWindow();
        graph = null;
        loadedChatKey = null;
        lastChatSignature = '';
        selectedNodeId = null;
        pendingSelectionNodeId = null;
        document.getElementById(MODULE_BUTTON_ID)?.remove();
    };
    const on = (name, handler) => {
        const eventName = eventTypes[name];
        if (!eventName) return;
        context.eventSource?.on?.(eventName, handler);
    };
    on('GENERATION_STARTED', onGenerationStarted);
    on('GENERATION_ENDED', onGenerationEnded);
    on('CHAT_CHANGED', onChatChanged);
    on('CHAT_CREATED', onChatCreated);
    on('CHAT_LOADED', onChatLoaded);
    on('CHAT_DELETED', onChatDeleted);
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
}

export { createGraph, getVariantContents, getActiveSwipeIndex };
