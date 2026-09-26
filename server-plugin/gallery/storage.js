const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Keep native user/images URLs and all native upload/delete routes unchanged.
// Only the directory entry is redirected; media is never copied or deleted here.
const stat = file => fs.lstatSync(file, { throwIfNoEntry: false });
const same = (a, b) => path.relative(a, b) === '';
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

function locations(imagesRoot) {
  // SillyTavern may supply a trusted path relative to its server working directory.
  if (typeof imagesRoot !== 'string' || !imagesRoot) throw new Error('Gallery directory is unavailable.');
  const root = path.resolve(imagesRoot);
  return { root, backup: `${root}.stplus-local`, config: `${root}.stplus-storage.json` };
}

function readState(files) {
  if (!stat(files.config)) return null;
  const value = JSON.parse(fs.readFileSync(files.config, 'utf8'));
  if (value.version !== 1 || typeof value.target !== 'string' || !path.isAbsolute(value.target)) {
    throw new Error('Invalid gallery storage record. No directories were changed.');
  }
  return value;
}

function managed(files, state) {
  if (!state || !stat(files.root)?.isSymbolicLink()
    || !same(path.resolve(path.dirname(files.root), fs.readlinkSync(files.root)), state.target)) {
    throw new Error('Gallery directory does not match the managed redirect. No directories were changed.');
  }
}

function getStorage(imagesRoot) {
  const files = locations(imagesRoot);
  const state = readState(files);
  if (state) managed(files, state);
  else if (stat(files.root)?.isSymbolicLink()) throw new Error('This gallery already has an unmanaged directory link. It will not be replaced.');
  let available = false;
  try { available = fs.statSync(files.root).isDirectory(); } catch { /* disconnected drive */ }
  return { external: Boolean(state), path: state?.target || files.root, localPath: files.root,
    retainedLocalPath: state ? files.backup : null, available };
}

function saveState(files, value) {
  const temporary = `${files.config}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx' });
    fs.renameSync(temporary, files.config);
  } finally {
    if (stat(temporary)) fs.unlinkSync(temporary);
  }
}

function setStorage(imagesRoot, address) {
  const files = locations(imagesRoot);
  const previous = readState(files);
  getStorage(imagesRoot); // Reject unowned links or inconsistent state before any mutation.
  if (typeof address !== 'string') throw new Error('Enter an absolute folder path on the server.');
  const input = address.trim().replace(/^"(.*)"$/, '$1');
  if (!path.isAbsolute(input) || input.includes('\0')) throw new Error('Enter an absolute folder path on the server.');
  const target = fs.realpathSync(input); // Folder must exist; resolve aliases before checking cycles.
  fs.readdirSync(target); // Check read access as well as the write probe below.
  const parent = fs.realpathSync(path.dirname(files.root));
  const canonicalRoot = path.join(parent, path.basename(files.root));
  const canonicalBackup = `${canonicalRoot}.stplus-local`;
  if (!fs.statSync(target).isDirectory() || same(target, path.parse(target).root)
    || inside(target, canonicalRoot) || inside(canonicalRoot, target)
    || inside(target, canonicalBackup) || inside(canonicalBackup, target)) {
    throw new Error('Choose a dedicated external folder, not the local gallery, its parent, or its retained copy.');
  }
  // Prove real write access (access() alone is unreliable on network shares).
  const probe = path.join(target, `.stplus-write-test-${crypto.randomUUID()}`);
  try { fs.writeFileSync(probe, '', { flag: 'wx' }); }
  finally { if (stat(probe)) fs.unlinkSync(probe); }
  if (previous && same(previous.target, target)) return getStorage(imagesRoot);
  if (!previous && (stat(files.backup) || !stat(files.root)?.isDirectory())) {
    throw new Error('Local gallery or retained-copy location is not ready. No directories were changed.');
  }
  const prepared = `${files.root}.stplus-link-${crypto.randomUUID()}`;
  const displaced = previous ? `${files.root}.stplus-old-${crypto.randomUUID()}` : files.backup;
  let moved = false;
  let installed = false;
  try {
    // Windows junctions need no elevation; UNC targets require directory symlinks.
    const type = process.platform === 'win32' && !target.startsWith('\\\\') ? 'junction' : 'dir';
    fs.symlinkSync(target, prepared, type);
    fs.renameSync(files.root, displaced);
    moved = true;
    fs.renameSync(prepared, files.root);
    installed = true;
    saveState(files, { version: 1, target });
  } catch (error) {
    if (installed) fs.unlinkSync(files.root); // Link only, never its contents.
    if (moved) fs.renameSync(displaced, files.root);
    throw error;
  } finally {
    if (stat(prepared)?.isSymbolicLink()) fs.unlinkSync(prepared);
  }
  if (previous) fs.unlinkSync(displaced); // Old link only; old external folder is untouched.
  return getStorage(imagesRoot);
}

function restoreStorage(imagesRoot) {
  const files = locations(imagesRoot);
  const previous = readState(files);
  if (!previous) return getStorage(imagesRoot);
  managed(files, previous); // Works even when the external disk is disconnected.
  const backup = stat(files.backup);
  if (!backup?.isDirectory() || backup.isSymbolicLink()) throw new Error('Retained local gallery is missing. No directories were changed.');
  const displaced = `${files.root}.stplus-old-${crypto.randomUUID()}`;
  fs.renameSync(files.root, displaced);
  let restored = false;
  try {
    fs.renameSync(files.backup, files.root);
    restored = true;
    fs.unlinkSync(files.config);
  } catch (error) {
    if (restored) fs.renameSync(files.root, files.backup);
    fs.renameSync(displaced, files.root);
    throw error;
  }
  fs.unlinkSync(displaced);
  return getStorage(imagesRoot);
}

module.exports = { getStorage, setStorage, restoreStorage };
