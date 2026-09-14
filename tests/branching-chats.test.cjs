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
    vm.runInContext(source + '\nthis.api = { pruneDeletedGraphNodes, reconcileDeletedGraph, getChatNodeIds };', sandbox);
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
