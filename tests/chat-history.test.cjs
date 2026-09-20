const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture() {
    class Element { constructor() { this.value = ''; this.disabled = false; this.hidden = false; } }
    const nodes = new Map();
    for (const key of ['summary', 'status', 'stale', 'info', 'depth', 'inject']) nodes.set('.stplus-chat-history-' + key, new Element());
    for (const key of ['generate', 'save', 'clear']) nodes.set(`[data-action="${key}"]`, new Element());
    let metadata = { integrity: 'chat-a' };
    let chatId = 'chat-a';
    let chat = [message('a'), message('b')];
    let saved;
    const prompts = {};
    let generator = async () => 'Generated summary';
    const document = { activeElement: null, querySelector: () => null };
    const sandbox = vm.createContext({ console, structuredClone, setTimeout, clearTimeout, document, AbortController,
        generateHistory: args => generator(args),
        HTMLElement: Element, HTMLInputElement: Element, HTMLTextAreaElement: Element, HTMLButtonElement: Element,
        window: { setTimeout, clearTimeout },
        SillyTavern: { getContext: () => ({ chat, chatMetadata: metadata, getCurrentChatId: () => chatId,
            updateChatMetadata: patch => { metadata = { ...metadata, ...patch }; },
            saveChat: async () => { saved = structuredClone(metadata); },
            setExtensionPrompt: (key, value, position, depth, scan, role) => { prompts[key] = {value, position, depth, scan, role}; },
            generateRaw: args => generator(args), generateQuietPrompt: args => generator(args),
        }) },
    });
    const source = fs.readFileSync(path.join(__dirname, '../modules/chat-history.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(source + '\nthis.api = { render, saveEditedSummary, getSnapshot, generateSummary, clearCurrentSummary, resolveStale, injectCurrentSummary, stripBookmarks, parseBookmark, editableSummary };', sandbox);
    sandbox.testPanel = { querySelector: s => nodes.get(s) || null };
    vm.runInContext("panel = testPanel; settings = { chatHistoryEnabled: true, chatHistoryAutoInjectEnabled: true };", sandbox);
    return { api: sandbox.api, sandbox, nodes, document, prompts,
        get metadata() { return metadata; }, get saved() { return saved; }, get chat() { return chat; },
        setGenerator(fn) { generator = fn; },
        reload() { metadata = JSON.parse(JSON.stringify(saved)); },
        switchChat() { chatId = 'chat-b'; metadata = { integrity: 'chat-b' }; chat = [message('z')]; },
        async edit(text, addBookmark = true) {
            sandbox.api.render();
            const box = nodes.get('.stplus-chat-history-summary');
            document.activeElement = box;
            const tag = box.value.match(/\[\[history:\d+\]\]/g)?.at(-1) ?? `[[history:${chat.length}]]`;
            box.value = addBookmark ? `${text}\n\n${tag}` : text;
            // Native pointerdown/blur can trigger an unrelated global UI scan
            // before the subsequent click dispatches Save.
            document.activeElement = null;
            sandbox.api.render();
            await sandbox.api.saveEditedSummary();
        },
    };
}
function message(text) { return { mes: text, name: 'Test', send_date: text, is_user: false, extra: { stplusBranchingNodeId: text } }; }

test('draft survives blur + refresh before Save; metadata round trips', async () => {
    const f = fixture();
    await f.edit('Saved test summary');
    assert.equal(f.saved?.stplusChatHistory.records[0].summary, 'Saved test summary\n\n[[history:2]]');
    f.reload();
    assert.equal(f.api.getSnapshot().anchorIndex, 1);
    assert.equal(f.nodes.get('.stplus-chat-history-summary').value, 'Saved test summary\n\n[[history:2]]');
});

test('editing a summary does not move its bookmark over new messages', async () => {
    const f = fixture(); await f.edit('Summary');
    f.chat.push(message('c'));
    await f.edit('Pruned summary');
    assert.equal(f.api.getSnapshot().anchorIndex, 1);
    assert.equal(f.api.getSnapshot().newMessages.length, 1);
});

test('incremental generation sends only previous summary and new range; retains checkpoints', async () => {
    const f = fixture(); await f.edit('Previous facts');
    f.chat.push(message('c'));
    let prompt;
    f.setGenerator(async args => { prompt = args.prompt; return 'Updated facts'; });
    await f.api.generateSummary();
    assert.match(prompt, /Previous facts/);
    assert.match(prompt, /\[Message 2 \| Test\]/);
    assert.doesNotMatch(prompt, /\[Message [01] \| Test\]/);
    assert.match(prompt, /do not repeat PREVIOUS CONTEXT/i);
    assert.equal(f.saved.stplusChatHistory.records.length, 2);
    assert.equal(f.api.getSnapshot().record.summary, 'Previous facts\n\n[[history:2]]\n\nUpdated facts\n\n[[history:3]]');
    assert.doesNotMatch(prompt, /\[\[history:/);
    f.chat.push(message('d'));
    let secondPrompt;
    f.setGenerator(async args => { secondPrompt = args.prompt; return 'More facts'; });
    await f.api.generateSummary();
    assert.match(secondPrompt, /\[Message 3 \| Test\]/);
    assert.doesNotMatch(secondPrompt, /\[Message [012] \| Test\]/);
    assert.equal(f.saved.stplusChatHistory.records.length, 3);
    assert.equal(f.api.getSnapshot().record.summary, 'Previous facts\n\n[[history:2]]\n\nUpdated facts\n\n[[history:3]]\n\nMore facts\n\n[[history:4]]');
});

test('editing or deleting the visible bookmark controls the next range and survives reload', async () => {
    const f = fixture(); await f.edit('Summary');
    await f.edit('Summary [[history:1]]', false);
    f.reload();
    assert.equal(f.api.getSnapshot().anchorIndex, 0);
    assert.equal(f.api.getSnapshot().newMessages.length, 1);
    await f.edit('Summary without a bookmark', false);
    f.reload();
    assert.equal(f.api.getSnapshot().anchorIndex, -1);
    assert.equal(f.api.getSnapshot().stale, false);
    assert.equal(f.api.getSnapshot().newMessages.length, 2);
    assert.equal(f.nodes.get('.stplus-chat-history-summary').value, 'Summary without a bookmark');
});

test('last bookmark wins, all tags are culled, and invalid edits do not save', async () => {
    const f = fixture();
    await f.edit('First [[history:2]]\nSecond [[history:1]]', false);
    assert.equal(f.api.getSnapshot().anchorIndex, 0);
    f.api.injectCurrentSummary();
    assert.doesNotMatch(f.prompts.stplus_chat_history.value, /history:/);
    for (const invalid of ['[[history:99]]', '[[history:0]]', '[[history:abc]]', '[[history:2']) {
        await f.edit(`Do not save ${invalid}`, false);
        assert.equal(f.api.getSnapshot().record.summary, 'First [[history:2]]\nSecond [[history:1]]');
        assert.doesNotMatch(f.api.stripBookmarks(`Private tag ${invalid}`), /history:/);
    }
});

test('legacy summaries show an editable tag without silently writing metadata', async () => {
    const f = fixture(); await f.edit('Legacy');
    const record = f.metadata.stplusChatHistory.records[0];
    delete record.bookmarkFormat; record.summary = 'Legacy';
    f.api.render();
    assert.equal(f.nodes.get('.stplus-chat-history-summary').value, 'Legacy\n\n[[history:2]]');
    assert.equal(record.summary, 'Legacy');
});

test('streamed reasoning is saved separately and never injected or included in future summary requests', async () => {
    const f = fixture();
    f.setGenerator(async args => {
        args.onProgress({text:'', reasoning:'Private model thought', duration:20, done:false});
        args.onProgress({text:'Facts', reasoning:'Private model thought', duration:20, done:true});
        return {text:'Facts', reasoning:'Private model thought'};
    });
    await f.api.generateSummary();
    assert.equal(f.saved.stplusChatHistory.records[0].generationReasoning.reasoning, 'Private model thought');
    f.api.injectCurrentSummary();
    assert.equal(f.prompts.stplus_chat_history.value, 'Chat history summary:\nFacts');
});

test('branch metadata IDs and summary anchor use the same path', async () => {
    const f = fixture();
    f.metadata.stplusBranchingChats = { activePath: ['tree-a', 'tree-b'] };
    await f.edit('Summary');
    assert.equal(f.api.getSnapshot().anchorIndex, 1);
    assert.equal(f.api.getSnapshot().stale, false);
    f.metadata.stplusBranchingChats.activePath[1] = 'tree-c';
    assert.equal(f.api.getSnapshot().stale, true);
});

test('bookmark boundary retains summary when a later swipe changes the active branch', async () => {
    const f = fixture();
    f.chat.push(message('c'));
    await f.api.generateSummary();
    const record = f.metadata.stplusChatHistory.records.at(-1);
    // Simulate a record created before the visible bookmark was edited: its
    // stored arrays still include messages after the bookmark. The bookmark,
    // not that obsolete suffix, defines what survives a later branch/swipe.
    record.anchorMessageId = 'b';
    record.anchorFingerprint = record.sourceFingerprints[1];
    f.metadata.stplusBranchingChats = { activePath: ['a', 'b', 'alternate-c'] };
    const snapshot = f.api.getSnapshot();
    assert.equal(snapshot.stale, false);
    assert.equal(snapshot.anchorIndex, 1);
    assert.equal(snapshot.newMessages.length, 1);
});

test('editing a previously summarized message invalidates the summary', async () => {
    const f = fixture(); await f.edit('Summary');
    f.chat[0].mes = 'Changed earlier event';
    assert.equal(f.api.getSnapshot().stale, true);
});

test('generation completing after a chat switch never writes into new chat', async () => {
    const f = fixture(); let resolve;
    f.setGenerator(() => new Promise(r => { resolve = r; }));
    const pending = f.api.generateSummary();
    f.switchChat(); resolve('Wrong chat summary'); await pending;
    assert.equal(f.metadata.stplusChatHistory, undefined);
});

test('injection is idempotent and Clear removes active injection', async () => {
    const f = fixture(); await f.edit('Summary');
    const prompt = structuredClone(f.chat);
    await f.api.injectCurrentSummary(prompt); await f.api.injectCurrentSummary(prompt);
    assert.equal(prompt.length, f.chat.length);
    assert.equal(Object.keys(f.prompts).length, 1);
    assert.equal(f.prompts.stplus_chat_history.value, 'Chat history summary:\nSummary');
    assert.equal(f.prompts.stplus_chat_history.position, 1);
    assert.equal(f.prompts.stplus_chat_history.role, 0);
    await f.api.clearCurrentSummary();
    await f.api.injectCurrentSummary(prompt);
    assert.equal(f.prompts.stplus_chat_history.value, '');
});

test('injection rejects stale sources and clears after switching chats', async () => {
    const f = fixture(); await f.edit('Summary');
    f.chat[0].mes = 'Different event';
    f.api.injectCurrentSummary();
    assert.equal(f.prompts.stplus_chat_history.value, '');
    await f.api.resolveStale('keep');
    f.api.injectCurrentSummary();
    assert.match(f.prompts.stplus_chat_history.value, /Summary/);
    f.switchChat();
    f.api.injectCurrentSummary();
    assert.equal(f.prompts.stplus_chat_history.value, '');
});

test('Keep and use clears the stale state for the approved branch', async () => {
    const f = fixture(); await f.edit('Summary');
    f.metadata.stplusBranchingChats = { activePath: ['a', 'different'] };
    assert.equal(f.api.getSnapshot().stale, true);
    await f.api.resolveStale('keep');
    assert.equal(f.api.getSnapshot().stale, false);
    f.api.injectCurrentSummary();
    assert.match(f.prompts.stplus_chat_history.value, /Summary/);
});

test('Prune archives a stale summary instead of leaving it active', async () => {
    const f = fixture(); await f.edit('Summary');
    f.metadata.stplusBranchingChats = { activePath: ['a', 'different'] };
    await f.api.resolveStale('prune');
    assert.equal(f.api.getSnapshot().record, null);
    assert.equal(f.metadata.stplusChatHistory.archived.at(-1).archiveReason, 'stale-pruned');
});

test('Regenerate here replaces a stale summary on the current branch', async () => {
    const f = fixture(); await f.edit('Old summary');
    f.metadata.stplusBranchingChats = { activePath: ['a', 'different'] };
    f.setGenerator(async () => 'Regenerated summary');
    await f.api.resolveStale('regenerate');
    assert.equal(f.api.getSnapshot().stale, false);
    assert.match(f.api.getSnapshot().record.summary, /Regenerated summary/);
});
