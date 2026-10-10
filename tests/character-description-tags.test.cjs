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

test('defined tags activate from flexible bot text without partial tag matches', () => {
    const api = loadApi();
    const tags = ['Stage 0', 'Stage 1', 'Stage 10', 'UserRel 2'];
    const active = api.findActiveTags('<!-- Day 3, stage 10, USERREL 2 -->', tags);
    assert.deepEqual([...active], ['Stage 10', 'UserRel 2']);
    assert.equal(api.filterDescriptionByTags(description, active, tags), [
        'Permanent character information.',
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

test('Chat Completion hook filters the charDescription prompt using the most recent bot message', () => {
    const api = loadApi();
    let listener;
    api.initialize({
        chat: [
            { is_user: false, mes: '[Stage 1]' },
            { is_user: true, mes: 'Continue without changing the stage.' },
        ],
        characterId: 0,
        characters: [{ data: { extensions: { stplus_character_description_tags: { tags: ['Stage 0', 'Stage 1'] } } } }],
        eventTypes: { CHAT_COMPLETION_PROMPT_READY: 'chat-prompt-ready' },
        eventSource: { on: (_event, callback) => { listener = callback; } },
    }, {
        characterDescriptionTagFilterEnabled: true,
    });
    const data = {
        chat: [
            { identifier: 'otherPrompt', content: description },
            { identifier: 'charDescription', content: description },
        ],
    };
    listener(data);
    assert.equal(data.chat[0].content, description);
    assert.match(data.chat[1].content, /Stage 1/);
    assert.doesNotMatch(data.chat[1].content, /Stage 0/);
});
