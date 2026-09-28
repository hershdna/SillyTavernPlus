const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Style {
    values = {};
    priorities = {};
    get zIndex() { return this.values['z-index'] ?? ''; }
    set zIndex(value) { this.setProperty('z-index', value); }
    getPropertyValue(name) { return this.values[name] ?? ''; }
    getPropertyPriority(name) { return this.priorities[name] ?? ''; }
    setProperty(name, value, priority = '') { this.values[name] = String(value); this.priorities[name] = priority; }
    removeProperty(name) { delete this.values[name]; delete this.priorities[name]; }
}

class FakeElement {
    constructor(id) { this.id = id; this.style = new Style(); this.isConnected = true; this.parentElement = null; }
    matches(selector) { return selector.split(',').map(value => value.trim()).includes(`#${this.id}`); }
    closest(selector) { return selector.includes('.prompt-manager-edit-action') && this.id === 'edit' ? this : null; }
    getBoundingClientRect() { return { width: 500, height: 400 }; }
}

function loadApi() {
    const popup = new FakeElement('completion_prompt_manager_popup');
    const edit = new FakeElement('edit');
    const sandbox = {
        console,
        HTMLElement: FakeElement,
        Element: FakeElement,
        window: { setTimeout: callback => callback() },
        document: {
            body: { classList: { contains: value => value === 'movingUI' } },
            querySelector: selector => selector === '#completion_prompt_manager_popup' ? popup : null,
            querySelectorAll: () => [popup],
        },
        getComputedStyle: element => ({
            position: 'absolute',
            zIndex: element.style.zIndex || '3010',
            transform: 'none', opacity: '1', filter: 'none', display: 'block', visibility: 'visible',
        }),
    };
    vm.createContext(sandbox);
    const source = fs.readFileSync(path.join(__dirname, '../modules/movingui-front.js'), 'utf8').replace(/^export /gm, '');
    vm.runInContext(`${source}\nthis.api = { initialize, handleClick, restoreZIndexes, selector: MOVINGUI_PANEL_SELECTOR };`, sandbox);
    sandbox.api.initialize({ powerUserSettings: { movingUI: true }, isMobile: () => false }, { movingUiBringToFrontEnabled: true, movingUiOpenOnTopEnabled: false });
    return { api: sandbox.api, popup, edit };
}

test('Prompt Manager pencil raises its native absolute editor above important native z-index rules', () => {
    const { api, popup, edit } = loadApi();
    assert.match(api.selector, /#completion_prompt_manager_popup/);
    api.handleClick({ target: edit });
    assert.equal(popup.style.zIndex, '3011');
    assert.equal(popup.style.getPropertyPriority('z-index'), 'important');
    api.restoreZIndexes();
    assert.equal(popup.style.zIndex, '');
});
