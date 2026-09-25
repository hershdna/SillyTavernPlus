const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../modules/chat-counts.js'), 'utf8');
const pure = source.slice(0, source.indexOf('function getTreeMetadata'))
    .replaceAll('export function ', 'function ');
const { nonGreetingCount, treeMessageCount } = vm.runInNewContext(`${pure}; ({ nonGreetingCount, treeMessageCount })`);

test('chat count excludes the initial greeting and never goes below zero', () => {
    assert.equal(nonGreetingCount(0), 0);
    assert.equal(nonGreetingCount(1), 0);
    assert.equal(nonGreetingCount(3), 2);
    assert.equal(nonGreetingCount(3.9), 2);
    assert.equal(nonGreetingCount('5'), 4);
});

test('tree count includes every branch and swipe message but excludes all greeting variants', () => {
    assert.equal(treeMessageCount({
        nodes: {
            greeting: { sourceIndex: 0 },
            alternateGreeting: { sourceIndex: 0 },
            user: { sourceIndex: 1 },
            reply: { sourceIndex: 2 },
            branchReply: { sourceIndex: 2 },
            swipeReply: { sourceIndex: 3 },
        },
    }), 4);
    assert.equal(treeMessageCount({ nodes: {} }), 0);
    assert.equal(treeMessageCount(null), null);
});
