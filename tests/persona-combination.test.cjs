const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'modules', 'persona-combination.js'), 'utf8');
const functionSource = source.match(/export function combinePersonaDescriptions\([\s\S]*?\n}\n/)[0]
    .replace('export function', 'function');
const combinePersonaDescriptions = vm.runInNewContext(`${functionSource}; combinePersonaDescriptions`);

test('persona descriptions combine in selection order with real newlines', () => {
    const descriptions = {
        one: { description: 'First persona' },
        two: { description: 'Second persona' },
        empty: { description: '  ' },
    };
    assert.equal(combinePersonaDescriptions(['one', 'empty', 'two'], descriptions), 'First persona\nSecond persona');
});

test('empty persona descriptions do not add blank prompt blocks', () => {
    assert.equal(combinePersonaDescriptions(['missing', 'empty'], {}), '');
});
