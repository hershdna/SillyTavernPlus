const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../modules/greeting-tags.js'), 'utf8');
const pure = source.slice(source.indexOf('export function fingerprint'), source.indexOf('function live()')).replaceAll('export function', 'function');
const api = vm.runInNewContext(`${pure}; ({fingerprint, normalizeTags, reconcileGreetings})`);
const plain = value => JSON.parse(JSON.stringify(value));
test('identical greeting texts can have distinct tags in the same chat', () => {
    const recordSource = source.slice(source.indexOf('function recordFor('), source.indexOf('function tagsFor('));
    const scope = vm.runInNewContext(`${pure}; const FIELD='tags'; const ctx={chatMetadata:{}}; function live(){return ctx;} ${recordSource}; ({reconcileGreetings,recordFor})`);
    const data = scope.reconcileGreetings(null, ['Same text', 'Same text']);
    data.greetings[0].tags = ['First']; data.greetings[1].tags = ['Second'];
    assert.deepEqual(plain(scope.recordFor(data, 'Same text', 0).tags), ['First']);
    assert.deepEqual(plain(scope.recordFor(data, 'Same text', 1).tags), ['Second']);
    assert.deepEqual(plain(scope.recordFor(data, 'Same text', 0).tags), ['First']);
});
test('starts first and alternate greetings untagged and normalizes tags', () => {
    const data = api.reconcileGreetings(null, ['First', 'Second']);
    assert.deepEqual(plain(data.greetings.map(g => g.tags)), [[], []]);
    assert.deepEqual(plain(api.normalizeTags([' One ', 'one', '', 'Two words'])), ['One', 'Two words']);
});
test('reorder and deletion retain tags, with deleted greeting available to legacy chats', () => {
    const data = api.reconcileGreetings(null, ['First', 'A', 'B']);
    data.greetings[1].tags = ['A tag']; data.greetings[2].tags = ['B tag'];
    const reordered = api.reconcileGreetings(data, ['First', 'B', 'A']);
    assert.deepEqual(plain(reordered.greetings.map(g => g.tags)), [[], ['B tag'], ['A tag']]);
    const deleted = api.reconcileGreetings(reordered, ['First', 'A']);
    assert.deepEqual(plain(deleted.greetings[1].tags), ['A tag']);
    assert.deepEqual(plain(deleted.archived[0].tags), ['B tag']);
});
test('native editor newline normalization does not turn a reorder into text edits', () => {
    const data = api.reconcileGreetings(null, ['First', 'A\r\nSecond line', 'B\r\nSecond line']);
    data.greetings[1].tags = ['A tag'];
    const moved = api.reconcileGreetings(data, ['First', 'B\nSecond line', 'A\nSecond line']);
    assert.deepEqual(plain(moved.greetings.map(g => g.tags)), [[], [], ['A tag']]);
});
test('text edits keep identity and prior fingerprint; new greetings do not inherit tags', () => {
    const data = api.reconcileGreetings(null, ['First', 'A']);
    data.greetings[1].tags = ['Retained'];
    const edited = api.reconcileGreetings(data, ['First', 'A edited']);
    assert.equal(edited.greetings[1].id, data.greetings[1].id);
    assert.ok(edited.greetings[1].aliases.includes(api.fingerprint('A')));
    const added = api.reconcileGreetings(edited, ['First', 'New', 'A edited']);
    assert.deepEqual(plain(added.greetings[1].tags), []);
    assert.deepEqual(plain(added.greetings[2].tags), ['Retained']);
    assert.deepEqual(plain(api.reconcileGreetings(added, ['First', 'New', 'A edited'])), plain(added));
});
