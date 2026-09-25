const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const galleryServer = require('../server-plugin/gallery');

function response() {
    return {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.value = value; return this; },
        send(value) { this.value = value; return this; },
        sendStatus(code) { this.statusCode = code; return this; },
    };
}

async function routes() {
    const registered = new Map();
    const router = {
        get(route, handler) { registered.set(`GET ${route}`, handler); },
        post(route, handler) { registered.set(`POST ${route}`, handler); },
    };
    await galleryServer.init(router);
    return registered;
}

test('gallery server uses its own API id and registers all capabilities', async () => {
    const registered = await routes();
    assert.equal(galleryServer.info.id, 'stplus-gallery');
    const health = response();
    registered.get('GET /health')({}, health);
    assert.equal(health.value.ok, true);
    assert.deepEqual(health.value.capabilities, galleryServer.CAPABILITIES);
    for (const route of ['POST /archive', 'POST /open-folder', 'POST /external-media/list', 'POST /source-folders/list', 'GET /external-media/file/:tokenFile']) {
        assert.equal(typeof registered.get(route), 'function', route);
    }
});

test('archive rejects path traversal without moving files', async () => {
    const registered = await routes();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stplus-gallery-test-'));
    try {
        const reply = response();
        await registered.get('POST /archive')({
            body: { folder: 'character', filename: '../other.png' },
            user: { directories: { userImages: root } },
        }, reply);
        assert.equal(reply.statusCode, 400);
        assert.equal(galleryServer.resolveGalleryDirectory(root, '../other'), null);
        assert.equal(fs.readdirSync(root).length, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('external media URLs point to the integrated server component', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stplus-gallery-test-'));
    try {
        const media = path.join(root, 'sample.png');
        fs.writeFileSync(media, 'test');
        const result = await galleryServer.collectExternalMedia([media]);
        assert.equal(result.items.length, 1);
        assert.match(result.items[0].url, /^\/api\/plugins\/stplus-gallery\/external-media\/file\/[a-f0-9]{64}\.png$/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('slideshow navigation matches equivalent encoded gallery URLs', () => {
    const source = fs.readFileSync(path.join(__dirname, '../modules/gallery/ui-controls.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '')
        .replace(/^export /gm, '');
    const sandbox = { URL, location: { href: 'http://127.0.0.1:8000/' } };
    vm.runInNewContext(`${source}\nthis.helpers = { indexInList, normalizeGalleryUrls };`, sandbox);
    const list = [
        'http://127.0.0.1:8000/user/images/Yes,%20My%20Liege/first.webp',
        'http://127.0.0.1:8000/user/images/Yes,%20My%20Liege/second.webp',
    ];
    assert.equal(sandbox.helpers.indexInList(list, 'http://127.0.0.1:8000/user/images/Yes%2C%20My%20Liege/first.webp'), 0);
    assert.equal(sandbox.helpers.indexInList(list, 'http://127.0.0.1:8000/user/images/Yes%2C%20My%20Liege/second.webp'), 1);
    assert.equal(sandbox.helpers.normalizeGalleryUrls([list[0], list[0].replace('Yes,', 'Yes%2C')]).length, 1);
});

test('external refresh rebuilds pages and restores previously deleted records', () => {
    const source = fs.readFileSync(path.join(__dirname, '../modules/gallery/gallery-controls.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    class Element {}
    const gallery = new Element();
    const root = new Element();
    root.querySelector = selector => selector === '#dragGallery' ? gallery : { value: 'test' };
    const local = { src: '/user/images/test/local.png' };
    const data = { items: [local] };
    const instance = { GOM: { albumIdx: 0, pagination: { currentPage: 2 } } };
    let displayed = [local];
    let refreshes = 0;
    let initialized = true;
    const api = { data: () => initialized ? { nG2: instance } : undefined, nanogallery2(command, value) {
        assert.equal(initialized, true, 'even getters initialize NanoGallery with empty defaults');
        if (command === 'data') return data;
        if (command === 'instance') return instance;
        if (command === 'paginationGotoPage') { instance.GOM.pagination.currentPage = value; return; }
        assert.equal(command, 'refresh', 'must rebuild the gallery, not only resize its old model');
        assert.equal(instance.GOM.pagination.currentPage, 0, 'a removed last page cannot remain selected');
        displayed = data.items.filter(item => !item.deleted);
        refreshes++;
    } };
    const sandbox = {
        URL, console, HTMLElement: Element, location: { origin: 'http://localhost', href: 'http://localhost/' },
        document: { querySelectorAll: () => [root] },
        window: {
            jQuery: () => api,
            NGY2Item: { New() {
                const record = { thumbSet() {}, setMediaURL(url) { this.src = url; }, delete() { this.deleted = true; } };
                data.items.push(record);
                return record;
            } },
        },
    };
    vm.runInNewContext(`${source}\nthis.sync = syncOpenGalleryExternalMedia;`, sandbox);
    const item = { url: '/api/plugins/stplus-gallery/external-media/file/test.png', name: 'test.png',
        galleryPath: '../../../api/plugins/stplus-gallery/external-media/file/test.png' };
    assert.equal(sandbox.sync('test', [item]), true);
    assert.equal(displayed.length, 2);
    sandbox.sync('test', []);
    assert.deepEqual(displayed, [local]);
    assert.equal(data.items.length, 2, 'NanoGallery retains deleted records');
    sandbox.sync('test', [item]);
    assert.equal(displayed.length, 2, 're-enabling restores the external image');
    assert.equal(refreshes, 3);
    sandbox.sync('test', [item]);
    assert.equal(refreshes, 3, 'unchanged Apply must not rebuild');
    instance.GOM.albumIdx = -1;
    assert.equal(sandbox.sync('test', []), false, 'retry while native gallery is rebuilding');
    assert.equal(displayed.length, 2);
    initialized = false;
    assert.equal(sandbox.sync('test', [item]), false, 'wait for native initialization without calling a getter');
});
