const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadApi() {
    const sandbox = vm.createContext({ console, structuredClone, window: {}, document: {} });
    const source = fs.readFileSync(path.join(__dirname, '../modules/chat-visible-edit.js'), 'utf8')
        .replace(/^export /gm, '');
    vm.runInContext(source + '\nthis.api = { syncMessageSwipe, applyVisibleTextEdit, applyFormattingMarkup, getAddedFormattingRanges, getSourceBoundary, normalizeMappingText, removeEmptyHtmlBlocks };', sandbox);
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

test('pasted HTML is preserved as source markup during a formatted edit', () => {
    const api = loadApi();
    const edit = {
        originalSource: '<p>STAGE TEST</p>',
        sourceMap: {
            renderedText: 'STAGE TEST',
            complete: true,
            segments: [{
                renderedStart: 0,
                renderedEnd: 10,
                sourceStart: 3,
                sourceEnd: 13,
                sourceOffsets: Array.from({ length: 11 }, (_, index) => index + 3),
            }],
        },
    };
    const pasted = '<!-- GFX_START --><div style="color:red">Formatted</div><!-- GFX_END -->';

    assert.equal(
        api.applyVisibleTextEdit(edit, pasted),
        '<p><!-- GFX_START --><div style="color:red">Formatted</div><!-- GFX_END --></p>',
    );
});

test('pasted HTML can replace an empty markup-only message', () => {
    const api = loadApi();
    const edit = {
        originalSource: '<hr>',
        sourceMap: { renderedText: '', complete: true, segments: [] },
    };
    const pasted = '<div style="color:red">Formatted</div>';

    assert.equal(api.applyVisibleTextEdit(edit, pasted), pasted);
});

test('HTML entities stay aligned with their visible text during mapping', () => {
    const api = loadApi();
    const mapped = api.normalizeMappingText('&lt;div&gt;');

    assert.equal(mapped.text, '<div>');
    assert.equal(mapped.normalizedToOriginal.at(-1), 11);
    assert.equal(mapped.originalToNormalized[4], 1);
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

test('formatted mark offsets stay aligned after emoji text', () => {
    const api = loadApi();
    const text = 'A 🕯️ B';
    const original = { text, marks: Array.from({ length: text.length }, () => new Set()) };
    const current = {
        text,
        marks: Array.from({ length: text.length }, (_, index) => index >= 6 ? new Set(['strong']) : new Set()),
    };

    assert.deepEqual(JSON.parse(JSON.stringify(api.getAddedFormattingRanges(original, current))), [
        { mark: 'strong', start: 6, end: text.length },
    ]);
});

test('source boundaries prefer the next text segment for formatting starts', () => {
    const api = loadApi();
    const sourceMap = {
        segments: [
            { renderedStart: 0, renderedEnd: 5, sourceStart: 0, sourceEnd: 5 },
            { renderedStart: 5, renderedEnd: 9, sourceStart: 7, sourceEnd: 11 },
        ],
    };

    assert.equal(api.getSourceBoundary(sourceMap, 5), 7);
    assert.equal(api.getSourceBoundary(sourceMap, 5, true), 5);
});

test('formatted deletion removes empty HTML/CSS wrappers', () => {
    const api = loadApi();

    assert.equal(
        api.removeEmptyHtmlBlocks('Before <span style="color: red"><strong></strong></span> after'),
        'Before  after',
    );
    assert.equal(
        api.removeEmptyHtmlBlocks('<div><span style="color: red"><!-- hidden --></span></div>Visible'),
        'Visible',
    );
});

test('empty-block cleanup preserves meaningful visible elements and text', () => {
    const api = loadApi();

    assert.equal(
        api.removeEmptyHtmlBlocks('<span style="color: red"><img src="kept.png"></span>'),
        '<span style="color: red"><img src="kept.png"></span>',
    );
    assert.equal(
        api.removeEmptyHtmlBlocks('<span style="color: red">Visible</span>'),
        '<span style="color: red">Visible</span>',
    );
});
