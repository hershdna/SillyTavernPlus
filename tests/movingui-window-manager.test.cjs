const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadApi() {
    const sandbox = vm.createContext({ console, window: { innerWidth: 1200, innerHeight: 800 }, document: {} });
    const source = fs.readFileSync(path.join(__dirname, '../modules/movingui-window-manager.js'), 'utf8')
        .replace(/^export /gm, '');
    vm.runInContext(source + '\nthis.api = { getResetGeometry, resetWindowGeometry };', sandbox);
    return sandbox.api;
}

test('resetting a MovingUI window clears geometry and its saved state entry', () => {
    const api = loadApi();
    const style = { top: '12px', left: '24px', right: 'unset', bottom: 'unset', width: '500px', height: '300px', margin: '0', transform: 'translateX(-50%)' };
    const removedAttributes = [];
    const panel = {
        id: 'example-window',
        style,
        offsetParent: null,
        getBoundingClientRect: () => ({ width: 1600, height: 1000 }),
        removeAttribute: (name) => removedAttributes.push(name),
    };
    const movingUIState = {
        'example-window': { top: 12, left: 24, width: 500, height: 300 },
        'other-window': { top: 5 },
    };

    assert.equal(api.resetWindowGeometry(panel, movingUIState), true);
    assert.deepEqual(style, { top: '80px', left: '120px', right: 'unset', bottom: 'unset', width: '960px', height: '640px', margin: '', transform: '' });
    assert.deepEqual(removedAttributes, ['data-dragged']);
    assert.deepEqual(movingUIState, { 'other-window': { top: 5 } });
});

test('reset geometry centers a window and caps it below the viewport size', () => {
    const api = loadApi();
    const panel = {
        getBoundingClientRect: () => ({ width: 2000, height: 1200 }),
    };

    assert.deepEqual({ ...api.getResetGeometry(panel, 1000, 700) }, {
        width: 800,
        height: 560,
        left: 100,
        top: 70,
    });
});
