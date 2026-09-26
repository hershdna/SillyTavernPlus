const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getStorage, setStorage, restoreStorage } = require('../server-plugin/gallery/storage.js');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stplus-storage-test-'));
  const root = path.join(home, 'account', 'images');
  const target = path.join(home, 'external');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(target);
  t.after(() => {
    // Remove our junction before recursive fixture cleanup, never traverse its target.
    if (fs.lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(root);
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, root, target };
}

test('external storage preserves local files and native read/write/delete paths, then restores', t => {
  const { root, target } = fixture(t);
  fs.writeFileSync(path.join(root, 'original.png'), 'original');
  fs.mkdirSync(path.join(target, 'Character'));
  fs.writeFileSync(path.join(target, 'Character', 'existing.png'), 'external');
  assert.equal(setStorage(root, target).external, true);
  assert.equal(fs.readFileSync(path.join(root, 'Character', 'existing.png'), 'utf8'), 'external');
  fs.writeFileSync(path.join(root, 'Character', 'upload.png'), 'new upload');
  assert.equal(fs.readFileSync(path.join(target, 'Character', 'upload.png'), 'utf8'), 'new upload');
  fs.unlinkSync(path.join(root, 'Character', 'upload.png'));
  assert.equal(fs.existsSync(path.join(target, 'Character', 'upload.png')), false);
  assert.equal(fs.readFileSync(`${root}.stplus-local/original.png`, 'utf8'), 'original');
  assert.equal(getStorage(root).path, fs.realpathSync(target)); // Fresh status, no in-memory state.
  assert.equal(setStorage(root, target).external, true); // Idempotent apply.
  assert.equal(restoreStorage(root).external, false);
  assert.equal(fs.readFileSync(path.join(root, 'original.png'), 'utf8'), 'original');
  assert.equal(fs.readFileSync(path.join(target, 'Character', 'existing.png'), 'utf8'), 'external');
});

test('target switching and offline restore never remove external files', t => {
  const { root, target, home } = fixture(t);
  const other = path.join(home, 'other');
  fs.mkdirSync(other);
  setStorage(root, target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
  setStorage(root, other);
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
  fs.renameSync(other, `${other}-offline`);
  assert.equal(getStorage(root).available, false);
  assert.equal(restoreStorage(root).external, false);
});

test('invalid targets and conflicting backup paths leave local storage unchanged', t => {
  const { root, target } = fixture(t);
  fs.mkdirSync(path.join(root, 'nested'));
  for (const invalid of ['relative/path', root, path.dirname(root), path.join(root, 'nested'), path.parse(root).root, path.join(target, 'missing')]) {
    assert.throws(() => setStorage(root, invalid));
    assert.equal(getStorage(root).external, false);
  }
  fs.mkdirSync(`${root}.stplus-local`);
  assert.throws(() => setStorage(root, target), /retained-copy/);
  assert.equal(getStorage(root).external, false);
});

test('trusted relative native gallery paths are resolved against the server working directory', t => {
  const { root, target } = fixture(t);
  const relative = path.relative(process.cwd(), root);
  assert.equal(getStorage(relative).path, root);
  assert.equal(setStorage(relative, target).external, true);
  assert.equal(restoreStorage(relative).external, false);
});

test('failed metadata save rolls back the directory change', t => {
  const { root, target } = fixture(t);
  const original = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (String(file).includes('.stplus-storage.json.')) throw new Error('simulated disk full');
    return original(file, ...args);
  };
  try { assert.throws(() => setStorage(root, target), /disk full/); }
  finally { fs.writeFileSync = original; }
  assert.equal(getStorage(root).external, false);
  assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
});
