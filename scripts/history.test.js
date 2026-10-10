'use strict';

// Loads main.js the way scripts/filesystem.test.js does. Real git, and a
// temporary library only. The writer's NEO Library is never opened.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { describe, test } = require('node:test');

const root = path.join(__dirname, '..');
const localRequire = createRequire(path.join(root, 'main.js'));
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const JSZip = localRequire('jszip');

function loadMain() {
  const handlers = new Map();
  const electron = {
    app: {
      commandLine: { appendSwitch() {} },
      getPath: () => os.tmpdir(),
      getLocale: () => 'en',
      getVersion: () => localRequire('./package.json').version,
      requestSingleInstanceLock: () => true,
      whenReady: () => ({ then() {} }),
      on() {}
    },
    ipcMain: { on() {}, handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (items) => items, setApplicationMenu() {} },
    dialog: {},
    utilityProcess: { fork: () => ({ on() {}, postMessage() {} }) },
    screen: {}
  };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : localRequire(name),
    __dirname: root,
    process: { platform: process.platform, env: process.env, on() {} },
    console,
    libraryRoot: os.tmpdir()
  });
  vm.runInContext(source, context, { filename: path.join(root, 'main.js') });
  return {
    context,
    call: (name, ...args) => handlers.get(name)(null, ...args),
    pointAt(dir) {
      context.libraryRoot = dir;
      vm.runInContext('LIBRARY_DIR = libraryRoot; LIBRARY_FILE = require("path").join(libraryRoot, "library.json");', context);
    }
  };
}

const main = loadMain();

function tempLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-library-history-'));
  assert.equal(dir.startsWith(os.tmpdir()), true);
  main.pointAt(dir);
  return dir;
}

function histories() {
  return vm.runInContext('commitHistories()', main.context);
}

function setTracking(on) {
  const lib = main.call('library:read');
  lib.versionTracking = on;
  main.call('library:write', lib);
}

function gitOut(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitCount(dir) {
  return Number(gitOut(dir, ['rev-list', '--count', 'HEAD']));
}

function gitUserName() {
  return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8' }).trim();
}

function assertHistoryCommit(folder) {
  const version = localRequire('./package.json').version;
  assert.equal(gitOut(folder, ['log', '-1', '--format=%s']), 'Version history');
  assert.equal(gitOut(folder, ['log', '-1', '--format=%an']), gitUserName());
  assert.match(
    gitOut(folder, ['log', '-1', '--format=%b']),
    new RegExp('^Co-authored-by: NEO ' + version.replace(/\./g, '\\.') + ' <neo@localhost>$')
  );
}

function stamp(file) {
  const st = fs.statSync(file);
  return st.mtimeMs + ':' + st.size;
}

describe('version history', { concurrency: 1 }, () => {
  test('tracking off or absent: a pass creates no .git', async () => {
    const dir = tempLibrary();
    try {
      const absent = main.call('book:create', { title: 'Absent', author: 'Ada' });
      await histories();
      assert.equal(fs.existsSync(path.join(dir, absent.id, '.git')), false);

      const off = main.call('book:create', { title: 'Off', author: 'Ada' });
      setTracking(false);
      fs.mkdirSync(path.join(dir, off.id, '.git'));
      await histories();
      assert.equal(fs.existsSync(path.join(dir, absent.id, '.git')), false);
      assert.equal(fs.existsSync(path.join(dir, off.id, '.git', 'HEAD')), false);
      assert.equal(fs.statSync(path.join(dir, off.id, '.git')).isDirectory(), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('tracking on: first pass commits; second pass with no edits does not', async () => {
    const dir = tempLibrary();
    try {
      const book = main.call('book:create', { title: 'Hello', author: 'Ada' });
      const folder = path.join(dir, book.id);
      setTracking(true);
      await histories();
      assert.equal(fs.existsSync(path.join(folder, '.git')), true);
      assert.equal(commitCount(folder), 1);
      assertHistoryCommit(folder);
      const ignore = fs.readFileSync(path.join(folder, '.gitignore'), 'utf8');
      for (const line of ['*.tmp', '*.bak', '.DS_Store']) assert.equal(ignore.includes(line), true);

      await histories();
      assert.equal(commitCount(folder), 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a chapter write is a new commit, and the commit does not change that file', async () => {
    const dir = tempLibrary();
    try {
      const book = main.call('book:create', { title: 'Hello', author: 'Ada' });
      const folder = path.join(dir, book.id);
      setTracking(true);
      await histories();
      const before = commitCount(folder);

      const html = '<p>Once upon a time</p>';
      assert.equal(main.call('chapter:write', book.id, 'c1', html), true);
      const file = path.join(folder, 'chapters', 'c1.html');
      assert.equal(commitCount(folder), before);
      const mark = stamp(file);

      await histories();
      assert.equal(commitCount(folder), before + 1);
      assert.equal(stamp(file), mark);
      assert.equal(fs.readFileSync(file, 'utf8'), html);
      assertHistoryCommit(folder);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing git logs once and leaves the chapter in place', async () => {
    const dir = tempLibrary();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-no-git-'));
    const saved = process.env.PATH;
    try {
      const first = main.call('book:create', { title: 'One', author: 'Ada' });
      const second = main.call('book:create', { title: 'Two', author: 'Ada' });
      const html = '<p>The words stay.</p>';
      main.call('chapter:write', first.id, 'c1', html);
      main.call('chapter:write', second.id, 'c1', html);
      setTracking(true);
      process.env.PATH = empty;
      await histories();
      const log = fs.readFileSync(path.join(dir, 'neo-errors.log'), 'utf8');
      assert.equal((log.match(/\[history\]/g) || []).length, 1);
      assert.match(log, /ENOENT/);
      for (const book of [first, second]) {
        const file = path.join(dir, book.id, 'chapters', 'c1.html');
        assert.equal(fs.readFileSync(file, 'utf8'), html);
        assert.equal(fs.existsSync(path.join(dir, book.id, '.git')), false);
      }
    } finally {
      process.env.PATH = saved;
      fs.rmSync(empty, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a pass already running does not start another', async () => {
    const dir = tempLibrary();
    try {
      const book = main.call('book:create', { title: 'Hello', author: 'Ada' });
      setTracking(true);
      vm.runInContext('historyRunning = true', main.context);
      await histories();
      assert.equal(fs.existsSync(path.join(dir, book.id, '.git')), false);
    } finally {
      vm.runInContext('historyRunning = false', main.context);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('daily zip walk has no path containing /.git/', async () => {
    const dir = tempLibrary();
    try {
      const book = main.call('book:create', { title: 'Hello', author: 'Ada' });
      const folder = path.join(dir, book.id);
      setTracking(true);
      await histories();
      const marker = 'neo-history-marker-do-not-zip';
      fs.writeFileSync(path.join(folder, '.git', marker), marker);
      await vm.runInContext('dailyBackup()', main.context);
      const today = new Date().toISOString().slice(0, 10);
      const zipPath = path.join(dir, 'Backups', `neo-backup-${today}.zip`);
      const buf = fs.readFileSync(zipPath);
      assert.equal(buf.includes(marker), false);
      const zip = await JSZip.loadAsync(buf);
      const names = Object.keys(zip.files);
      assert.equal(names.some((name) => name.includes('/.git/')), false);
      assert.equal(names.some((name) => name.endsWith('book.json')), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
