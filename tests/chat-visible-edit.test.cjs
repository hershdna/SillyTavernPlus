const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadApi() {
    const sandbox = vm.createContext({ console, structuredClone, window: {}, document: {} });
    const source = fs.readFileSync(path.join(__dirname, '../modules/chat-visible-edit.js'), 'utf8')
        .replace(/^export /gm, '');
    vm.runInContext(source + '\nthis.api = { syncMessageSwipe, applyFormattingMarkup, getAddedFormattingRanges };', sandbox);
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

test('new formatted marks are written as source markup without flattening other text', () => {
    const api = loadApi();
    assert.equal(
        api.applyFormattingMarkup('Before added text after', [
            { mark: 'strong', start: 7, end: 17 },
        ]),
        'Before <strong>added text</strong> after',
    );
});

test('formatted editor identifies marks that were added to existing visible text', () => {
    const api = loadApi();
    const original = {
        text: 'Keep this text',
        marks: Array.from({ length: 14 }, () => new Set()),
    };
    const current = {
        text: 'Keep this text',
        marks: Array.from({ length: 14 }, (_, index) => index >= 5 ? new Set(['strong']) : new Set()),
    };

    assert.deepEqual(JSON.parse(JSON.stringify(api.getAddedFormattingRanges(original, current))), [
        { mark: 'strong', start: 5, end: 14 },
    ]);
});
