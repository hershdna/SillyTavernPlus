const SELECTORS = [
    '.recentChat .counterBlock > small',
    '.chat_messages_num',
];

const TREE_METADATA_KEY = 'stplusBranchingChats';
const RECENT_REFRESH_DELAY = 180;

let recentTreeCounts = new Map();
let recentRefreshTimer = null;
let recentRefreshInFlight = null;
let recentRefreshQueued = false;

export function nonGreetingCount(messageCount) {
    const count = Number(messageCount);
    if (!Number.isFinite(count)) return 0;
    return Math.max(0, Math.floor(count) - 1);
}

/**
 * Return the number of non-greeting nodes represented by an ST+ tree.
 * A null result means this is not an ST+ tree (or is legacy metadata), so
 * callers can fall back to SillyTavern's native active-path count.
 */
export function treeMessageCount(storedGraph) {
    const nodes = storedGraph?.nodes;
    if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return null;

    return Object.values(nodes).filter((node) => {
        if (!node || typeof node !== 'object') return false;
        // All sourceIndex 0 nodes are greeting variants. Every later node is
        // a real conversation message, including branch and swipe siblings.
        return Number(node.sourceIndex) > 0;
    }).length;
}

function getTreeMetadata(chat) {
    let metadata = chat?.chat_metadata?.[TREE_METADATA_KEY];
    if (typeof metadata === 'string') {
        try {
            metadata = JSON.parse(metadata);
        } catch {
            metadata = null;
        }
    }
    return metadata && typeof metadata === 'object' ? metadata : null;
}

function normalizeFileName(value) {
    return String(value ?? '').replace(/\.jsonl$/i, '');
}

function getChatKey(file, avatar = '', group = '') {
    const normalizedFile = normalizeFileName(file);
    if (!normalizedFile) return null;
    return `${String(avatar ?? '')}|${String(group ?? '')}|${normalizedFile}`;
}

function getCardTreeCount(element) {
    const card = element.closest('.recentChat, [data-file], [data-chat-file]');
    if (!card) return null;
    const file = card.dataset.file || card.dataset.chatFile;
    const avatar = card.dataset.avatar ?? '';
    const group = card.dataset.group ?? '';
    const exact = recentTreeCounts.get(getChatKey(file, avatar, group));
    if (Number.isFinite(exact)) return exact;

    // An active-chat event can identify the current file before its avatar or
    // group is available. Only use the file-only fallback when unambiguous.
    const fileOnly = [...recentTreeCounts.entries()]
        .filter(([key]) => key.endsWith(`||${normalizeFileName(file)}`));
    return fileOnly.length === 1 ? fileOnly[0][1] : null;
}

function updateCount(element) {
    const text = element.textContent ?? '';
    const match = text.match(/^(\s*)(\d+)/);
    if (!match) return;

    const visibleCount = Number(match[2]);
    if (!Number.isFinite(visibleCount)) return;

    const lastRendered = Number(element.dataset.stplusLastRenderedCount);
    let nativeCount = Number(element.dataset.stplusNativeMessageCount);
    // If SillyTavern redrew this element, its new leading number is the raw
    // native count. If this is our own redraw, keep the stored raw value.
    if (!Number.isFinite(lastRendered) || visibleCount !== lastRendered || !Number.isFinite(nativeCount)) {
        nativeCount = visibleCount;
        element.dataset.stplusNativeMessageCount = String(nativeCount);
    }

    const treeCount = getCardTreeCount(element);
    const expected = Number.isFinite(treeCount) ? treeCount : nonGreetingCount(nativeCount);
    element.dataset.stplusLastRenderedCount = String(expected);
    if (visibleCount === expected) return;
    element.textContent = text.replace(/^\s*\d+/, `${match[1]}${expected}`);
}

export function refresh(root = document) {
    const selector = SELECTORS.join(', ');
    root.querySelectorAll(selector).forEach(updateCount);
}

async function getNativeRequestHeaders() {
    try {
        const nativeScript = await import('/script.js');
        return nativeScript.getRequestHeaders?.() ?? {};
    } catch {
        return {};
    }
}

async function refreshRecentTreeCounts() {
    if (!document.querySelector('.recentChat')) return;
    if (recentRefreshInFlight) {
        recentRefreshQueued = true;
        return recentRefreshInFlight;
    }

    recentRefreshInFlight = (async () => {
        try {
            const response = await fetch('/api/chats/recent', {
                method: 'POST',
                headers: { ...await getNativeRequestHeaders(), 'Content-Type': 'application/json' },
                // Metadata contains the compact tree index without loading
                // full message records or changing the active chat.
                body: JSON.stringify({ max: 10000, metadata: true }),
                cache: 'no-cache',
            });
            if (!response.ok) return;
            const chats = await response.json();
            if (!Array.isArray(chats)) return;

            const nextCounts = new Map();
            chats.forEach((chat) => {
                const graph = getTreeMetadata(chat);
                const count = treeMessageCount(graph);
                if (count === null) return;
                const key = getChatKey(chat.file_name, chat.avatar, chat.group);
                if (key) nextCounts.set(key, count);
            });
            recentTreeCounts = nextCounts;
            document.querySelectorAll(SELECTORS.join(', ')).forEach(updateCount);
        } catch (error) {
            console.debug('[SillyTavernPlus] Could not refresh tree chat counts.', error);
        } finally {
            recentRefreshInFlight = null;
            if (recentRefreshQueued) {
                recentRefreshQueued = false;
                scheduleRecentTreeRefresh();
            }
        }
    })();
    return recentRefreshInFlight;
}

function scheduleRecentTreeRefresh() {
    window.clearTimeout(recentRefreshTimer);
    recentRefreshTimer = window.setTimeout(() => void refreshRecentTreeCounts(), RECENT_REFRESH_DELAY);
}

function shouldRefreshRecentTreeCounts(mutations) {
    return mutations.some((mutation) => {
        if (mutation.type !== 'childList') return false;
        // Updating the counter itself replaces its text node. Do not treat
        // that internal redraw as a reason to fetch the entire recent-chat
        // index again.
        if (mutation.target?.closest?.('.counterBlock')) return false;
        return mutation.target?.closest?.('.recentChatList, #recent_chats')
            || [...mutation.addedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE
                && (node.matches?.('.recentChat, .recentChatList, #recent_chats')
                    || node.querySelector?.('.recentChat')));
    });
}

function handleTreeUpdate(event) {
    const detail = event?.detail ?? {};
    const file = detail.chatKey;
    const count = Number(detail.count);
    if (!file || !Number.isFinite(count)) return;
    // Store a file-only key; getCardTreeCount uses it only when unambiguous.
    recentTreeCounts.set(`||${normalizeFileName(file)}`, count);
    refresh();
}

export function initialize() {
    refresh();
    scheduleRecentTreeRefresh();
    window.addEventListener('stplus:chat-tree-updated', handleTreeUpdate);
    const observer = new MutationObserver((mutations) => {
        refresh();
        if (shouldRefreshRecentTreeCounts(mutations)) scheduleRecentTreeRefresh();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
