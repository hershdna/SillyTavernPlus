const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadApi() {
    const sandbox = vm.createContext({ console, structuredClone, window: {}, document: {} });
    const source = fs.readFileSync(path.join(__dirname, '../modules/chat-visible-edit.js'), 'utf8')
        .replace(/^export /gm, '');
    vm.runInContext(source + '\nthis.api = { syncMessageSwipe };', sandbox);
    return sandbox.api;
}

test('formatted edits persist display metadata on the active swipe', () => {
    const api = loadApi();
    const message = {
        mes: 'source text',
        extra: { display_text: 'edited visible text', media: ['kept'] },
        swipes: ['source text'],
        swipe_id: 0,
        swipe_info: [{ extra: { display_text: 'old visible text' } }],
    };

    api.syncMessageSwipe(message);

    assert.equal(message.swipes[0], 'source text');
    assert.deepEqual(message.swipe_info[0].extra, message.extra);
    assert.notEqual(message.swipe_info[0].extra, message.extra);
});
