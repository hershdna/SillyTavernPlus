const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadApi() {
    const sandbox = vm.createContext({
        console,
        structuredClone,
        setTimeout,
        clearTimeout,
        window: { setTimeout, clearTimeout },
        document: {},
    });
    const source = fs.readFileSync(path.join(__dirname, '../modules/branching-chats.js'), 'utf8')
        .replace(/^export /gm, '');
    vm.runInContext(source + '\nthis.api = { canStartBranchGeneration, pruneDeletedGraphNodes, reconcileDeletedGraph, getChatNodeIds, getBranchSwipeAction, isRepresentableVariant };', sandbox);
    return sandbox.api;
}

function node(id, parentId, sourceIndex, content, role = 'assistant', swipeIndex = 0) {
    return {
        id,
        parentId,
        sourceIndex,
        swipeIndex,
        content,
        role,
        variantCount: 1,
        createdAt: sourceIndex + swipeIndex,
    };
}

test('deleting an active message removes its obsolete descendants but preserves parallel branches', () => {
    const api = loadApi();
    const graph = {
        nodes: {
            a: node('a', null, 0, 'A', 'user'),
            b1: node('b1', 'a', 1, 'B1'),
            b2: node('b2', 'a', 1, 'B2'),
            c1: node('c1', 'b1', 2, 'C1'),
            c1b: node('c1b', 'c1', 3, 'C1 branch'),
            c2: node('c2', 'b2', 2, 'C2'),
        },
        activePath: ['a', 'b1', 'c1'],
    };

    api.pruneDeletedGraphNodes(graph, new Set(['a', 'b1']));

    assert.deepEqual(Object.keys(graph.nodes).sort(), ['a', 'b1', 'b2', 'c2']);
    assert.equal(graph.nodes.b2.parentId, 'a');
    assert.equal(graph.nodes.c2.parentId, 'b2');
    assert.deepEqual(graph.activePath, ['a', 'b1']);
});

test('a later message that survives a normal splice is reparented instead of duplicated', () => {
    const api = loadApi();
    const graph = {
        nodes: {
            a: node('a', null, 0, 'A', 'user'),
            b1: node('b1', 'a', 1, 'B1'),
            b2: node('b2', 'b1', 2, 'B2'),
            b2branch: node('b2branch', 'b1', 2, 'B2 alternate'),
        },
        activePath: ['a', 'b1', 'b2'],
    };

    api.pruneDeletedGraphNodes(graph, new Set(['a', 'b2']));

    assert.deepEqual(Object.keys(graph.nodes).sort(), ['a', 'b2']);
    assert.equal(graph.nodes.b2.parentId, 'a');
    assert.deepEqual(graph.activePath, ['a', 'b2']);
});

test('deleting one native swipe removes only that swipe subtree', () => {
    const api = loadApi();
    const graph = {
        nodes: {
            s0: node('s0', null, 0, 'Greeting 0', 'assistant', 0),
            s1: node('s1', null, 0, 'Greeting 1', 'assistant', 1),
            s1reply: node('s1reply', 's1', 1, 'Reply to greeting 1'),
        },
        activePath: ['s1', 's1reply'],
    };

    const chat = [{
        mes: 'Greeting 0',
        swipes: ['Greeting 0'],
        swipe_id: 0,
        swipe_info: [{ extra: { stplusBranchingNodeId: 's0' } }],
    }];
    api.reconcileDeletedGraph(graph, chat, [{ messageIndex: 0, swipeIndex: 1 }]);

    assert.deepEqual(Object.keys(graph.nodes), ['s0']);
    assert.deepEqual(graph.activePath, []);
});

test('previous-message swipe navigation follows depth sibling rules', () => {
    const api = loadApi();
    const assistant1 = node('assistant-1', 'parent', 2, 'Reply 1', 'assistant', 0);
    const assistant2 = node('assistant-2', 'parent', 2, 'Reply 2', 'assistant', 1);
    const user1 = node('user-1', 'parent', 2, 'Choice 1', 'user', 0);
    const user2 = node('user-2', 'parent', 2, 'Choice 2', 'user', 1);
    const assistants = [assistant1, assistant2];
    const users = [user1, user2];

    assert.equal(api.getBranchSwipeAction(assistant1, assistants, 'right').type, 'jump');
    assert.equal(api.getBranchSwipeAction(assistant1, assistants, 'right').node.id, assistant2.id);
    assert.equal(api.getBranchSwipeAction(assistant2, assistants, 'right').type, 'generate');
    assert.equal(api.getBranchSwipeAction(user2, users, 'right').type, 'jump');
    assert.equal(api.getBranchSwipeAction(user2, users, 'right').node.id, user1.id);
    assert.equal(api.getBranchSwipeAction(user1, users, 'left').type, 'jump');
    assert.equal(api.getBranchSwipeAction(user1, users, 'left').node.id, user2.id);
    assert.equal(api.getBranchSwipeAction(user1, [user1], 'right').type, 'none');
});

test('a failed API connection cannot strand branch generation state', () => {
    const api = loadApi();

    assert.equal(api.canStartBranchGeneration({ onlineStatus: 'no_connection' }), false);
    assert.equal(api.canStartBranchGeneration({ onlineStatus: 'connected' }), true);
    assert.equal(api.canStartBranchGeneration({}), true);
});

test('metadata-backed empty native swipes remain navigable without reviving placeholders', () => {
    const api = loadApi();
    const message = {
        swipes: ['', '', 'visible'],
        swipe_info: [
            { send_date: '2026-09-16T00:00:00Z', extra: { reasoning: 'stopped reasoning' } },
            { send_date: '2026-09-16T00:00:00Z', extra: {} },
            { send_date: '2026-09-16T00:00:00Z', extra: {} },
        ],
    };

    assert.equal(api.isRepresentableVariant(message, 0, ''), true);
    assert.equal(api.isRepresentableVariant(message, 1, ''), false);
    assert.equal(api.isRepresentableVariant(message, 2, 'visible'), true);
});
