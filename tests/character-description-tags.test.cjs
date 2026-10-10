const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApi() {
    const sandbox = vm.createContext({ console });
    const source = fs.readFileSync(path.join(__dirname, '../modules/character-description-tags.js'), 'utf8')
        .replace(/^import .*?;\r?\n/gm, '')
        .replace(/^export /gm, '');
    vm.runInContext(`${source}\nthis.api = { normalizeTags, findActiveTags, expandAdjacentTags, filterDescriptionByTags, getFilteredDescription, initialize };`, sandbox);
    return sandbox.api;
}

const description = [
    'Permanent character information.',
    '',
    '- Stage 0: First state.',
    '',
    '- Stage 1: Second state.',
    'Still part of Stage 1.',
    '',
    '- UserRel 2: Trusted ally state.',
].join('\n');

test('only bracketed, defined latest-message tags activate matching headers', () => {
    const api = loadApi();
    const tags = ['Stage 0', 'Stage 1', 'UserRel 2'];
    const active = api.findActiveTags('Advance to [Stage 1] with [UserRel 2]. Stage 0 stays prose.', tags);
    assert.deepEqual([...active], ['Stage 1', 'UserRel 2']);
    assert.equal(api.filterDescriptionByTags(description, active, tags), [
        'Permanent character information.',
        '',
        '- Stage 1: Second state.',
        'Still part of Stage 1.',
        '',
        '- UserRel 2: Trusted ally state.',
    ].join('\n'));
});

test('untagged text and headers for undefined tags remain while inactive defined sections prune', () => {
    const api = loadApi();
    const source = ['Core.', '- Stage 0: Pruned.', '- Other: Always retained.'].join('\n');
    assert.equal(api.getFilteredDescription(source, '', ['Stage 0']), 'Core.\n- Other: Always retained.');
});

test('plain, list, and Markdown-emphasized headers match case-insensitively', () => {
    const api = loadApi();
    const source = [
        '- Stage 1: Pruned.',
        '-**Stage 2**: Included.',
        'stage 3: Also pruned.',
    ].join('\n');
    assert.equal(api.getFilteredDescription(source, '[Stage 2]', ['Stage 1', 'Stage 2', 'Stage 3']), '-**Stage 2**: Included.');
});

test('adjacent-tag options include only direct neighbors in the card tag order', () => {
    const api = loadApi();
    const tags = ['Stage 0', 'Stage 1', 'Stage 2', 'Stage 3'];
    const expanded = api.expandAdjacentTags(new Set(['Stage 2']), tags, { includePreceding: true, includeSucceeding: true });
    assert.deepEqual([...expanded], ['Stage 2', 'Stage 1', 'Stage 3']);
    const source = tags.map((tag) => `${tag}: ${tag} text.`).join('\n');
    const result = api.getFilteredDescription(source, '[Stage 2]', tags, { includePreceding: true, includeSucceeding: true });
    assert.doesNotMatch(result, /Stage 0 text/);
    assert.match(result, /Stage 1 text/);
    assert.match(result, /Stage 2 text/);
    assert.match(result, /Stage 3 text/);
});

test('generation hook filters only the outgoing prompt description using the latest message', () => {
    const api = loadApi();
    let listener;
    api.initialize({
        chat: [{ mes: '[Stage 1]' }],
        characterId: 0,
        characters: [{ data: { extensions: { stplus_character_description_tags: { tags: ['Stage 0', 'Stage 1'] } } } }],
        eventTypes: { GENERATE_BEFORE_COMBINE_PROMPTS: 'before-combine' },
        eventSource: { on: (_event, callback) => { listener = callback; } },
    }, {
        characterDescriptionTagFilterEnabled: true,
    });
    const data = { description };
    listener(data);
    assert.match(data.description, /Stage 1/);
    assert.doesNotMatch(data.description, /Stage 0/);
});
