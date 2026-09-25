const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
