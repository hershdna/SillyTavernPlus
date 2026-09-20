const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadApi() {
    const sandbox = vm.createContext({ console, window: {}, document: {} });
    const source = fs.readFileSync(path.join(__dirname, '../modules/movingui-window-manager.js'), 'utf8')
        .replace(/^export /gm, '');
    vm.runInContext(source + '\nthis.api = { resetWindowGeometry };', sandbox);
    return sandbox.api;
}

test('resetting a MovingUI window clears geometry and its saved state entry', () => {
    const api = loadApi();
    const style = { top: '12px', left: '24px', right: 'unset', bottom: 'unset', width: '500px', height: '300px', margin: '0' };
    const removedAttributes = [];
    const panel = {
        id: 'example-window',
        style,
        removeAttribute: (name) => removedAttributes.push(name),
    };
    const movingUIState = {
        'example-window': { top: 12, left: 24, width: 500, height: 300 },
        'other-window': { top: 5 },
    };

    assert.equal(api.resetWindowGeometry(panel, movingUIState), true);
    assert.deepEqual(style, { top: '', left: '', right: '', bottom: '', width: '', height: '', margin: '' });
    assert.deepEqual(removedAttributes, ['data-dragged']);
    assert.deepEqual(movingUIState, { 'other-window': { top: 5 } });
});
