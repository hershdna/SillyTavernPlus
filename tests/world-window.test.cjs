const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(state = {}, enabled = true) {
    const storage = new Map();
    let saves = 0;
    const ctx = { powerUserSettings: { movingUI: enabled, movingUIState: state }, saveSettingsDebounced: () => saves++ };
    const sandbox = { window: { innerWidth: 1200, innerHeight: 800 },
        localStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) } };
    vm.createContext(sandbox);
    const source = fs.readFileSync(path.join(__dirname, '../modules/lorebook-mods.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '').replace(/export function /g, 'function ').replace(/export \{ refresh \};/, '');
    vm.runInContext(source + '\nthis.api = { initialize, applyWorldWindowState, writeWorldWindowState, migrateWorldWindowState, closeFloatingWorlds };', sandbox);
    sandbox.api.initialize(ctx, {});
    const style = { setProperty(k,v,priority) { this[k] = v; assert.ok(!priority); } };
    const panel = { style, classList: { contains: () => true, add() {}, remove() {} }, getBoundingClientRect: () => ({left:60,top:70,width:650,height:500}) };
    sandbox.document = {getElementById: () => panel};
    return { ...sandbox, ctx, panel, storage, saves: () => saves };
}

test('World Info uses native preset coordinates including numeric strings without clamping or important overrides', () => {
    const { api, panel } = load({ WorldInfo: { left:'17',top:23,width:920,height:620 } });
    api.applyWorldWindowState(panel);
    assert.equal(panel.style.left, '17px');
    assert.equal(panel.style.width, '920px');
});
test('corner resize saves into native MovingUI state, not separate local geometry', () => {
    const { api, panel, ctx, storage, saves } = load();
    api.writeWorldWindowState(panel);
    assert.equal(ctx.powerUserSettings.movingUIState.WorldInfo.width,650);
    assert.equal(ctx.powerUserSettings.movingUIState.WorldInfo.left,60);
    assert.equal(storage.has('stplus.worldsWindow'),false);
    assert.equal(saves(),1);
});
test('close hides the panel without restoring stale inline geometry', () => {
    const {api,panel,ctx} = load();
    panel.style.left = '60px';
    panel.style.display = 'block';
    api.closeFloatingWorlds();
    assert.equal(panel.style.display,'none');
    assert.equal(panel.style.left,'60px');
    assert.equal(ctx.powerUserSettings.movingUIState.WorldInfo.left,60);
});
test('MovingUI disabled does not overwrite saved preset and opens at usable defaults', () => {
    const { api, panel, ctx, saves } = load({WorldInfo:{left:123}},false);
    api.applyWorldWindowState(panel);
    api.writeWorldWindowState(panel);
    assert.equal(panel.style.width,'860px');
    assert.equal(ctx.powerUserSettings.movingUIState.WorldInfo.left,123);
    assert.equal(saves(),0);
});
test('native geometry wins migration; reset does not resurrect old standalone geometry', () => {
    const {api,storage,ctx} = load({WorldInfo:{left:99}});
    storage.set('stplus.worldsWindow',JSON.stringify({left:1,top:2,width:600,height:400}));
    api.migrateWorldWindowState();
    assert.equal(ctx.powerUserSettings.movingUIState.WorldInfo.left,99);
    delete ctx.powerUserSettings.movingUIState.WorldInfo;
    api.migrateWorldWindowState();
    assert.equal(ctx.powerUserSettings.movingUIState.WorldInfo,undefined);
});
test('shared drag module does not add a second handle to an already draggable window', () => {
    const sandbox = {};
    vm.createContext(sandbox);
    const source = fs.readFileSync(path.join(__dirname,'../modules/movingui-drag.js'),'utf8').replace(/export function /g,'function ');
    vm.runInContext(source+'\nthis.add = addDragHandle; this.selector = MOVINGUI_PANEL_SELECTOR;',sandbox);
    const panel = {querySelector: selector => selector === '.drag-grabber' ? {} : null};
    assert.equal(typeof sandbox.add(panel),'function');
    assert.ok(!sandbox.selector.includes('WorldInfo'));
});
