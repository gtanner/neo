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
  const listeners = new Map();
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
    ipcMain: {
      on: (name, fn) => listeners.set(name, fn),
      handle: (name, fn) => handlers.set(name, fn)
    },
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
    emit: (name, ...args) => listeners.get(name)(null, ...args),
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

function gitUserEmail() {
  return execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim();
}

function logIdentity() {
  return vm.runInContext('logGitIdentity()', main.context);
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

function resetTrackingState() {
  vm.runInContext('versionTrackingState = false; versionTrackingKnown = false;', main.context);
}

async function withHistoryConsole(fn) {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => {
    const s = args.map(String).join(' ');
    if (s.startsWith('[history]')) lines.push(s);
  };
  console.error = (...args) => {
    const s = args.map(String).join(' ');
    if (s.startsWith('[history]')) lines.push(s);
  };
  try {
    await fn(lines);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return lines;
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
      const lines = await withHistoryConsole(async () => {
        await histories();
      });
      assert.equal(fs.existsSync(path.join(folder, '.git')), true);
      assert.equal(commitCount(folder), 1);
      assertHistoryCommit(folder);
      const ignore = fs.readFileSync(path.join(folder, '.gitignore'), 'utf8');
      for (const line of ['*.tmp', '*.bak', '.DS_Store']) assert.equal(ignore.includes(line), true);
      const hash = gitOut(folder, ['rev-parse', '--short', 'HEAD']);
      assert.equal(lines.filter((l) => l.includes('checkpoint saved')).length, 1);
      assert.match(lines.join('\n'), new RegExp(
        'checkpoint saved book=' + book.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        ' title="Hello" commit=' + hash
      ));

      const again = await withHistoryConsole(async () => {
        await histories();
      });
      assert.equal(commitCount(folder), 1);
      assert.equal(again.filter((l) => l.includes('checkpoint saved')).length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('startup logs the git identity', async () => {
    const dir = tempLibrary();
    try {
      const lines = await withHistoryConsole(async () => { await logIdentity(); });
      assert.match(
        lines.join('\n'),
        new RegExp(
          'git identity name=' + JSON.stringify(gitUserName()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          ' email=' + JSON.stringify(gitUserEmail()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        )
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('startup logs when git is missing or has no identity', async () => {
    const dir = tempLibrary();
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-no-git-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-no-git-id-'));
    const blank = path.join(home, 'gitconfig');
    fs.writeFileSync(blank, '');
    const savedPath = process.env.PATH;
    const saved = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL
    };
    try {
      process.env.PATH = empty;
      let lines = await withHistoryConsole(async () => { await logIdentity(); });
      assert.match(lines.join('\n'), /git not found/);

      process.env.PATH = savedPath;
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.GIT_CONFIG_GLOBAL = blank;
      process.env.GIT_CONFIG_SYSTEM = blank;
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.GIT_AUTHOR_NAME;
      delete process.env.GIT_AUTHOR_EMAIL;
      delete process.env.GIT_COMMITTER_NAME;
      delete process.env.GIT_COMMITTER_EMAIL;
      lines = await withHistoryConsole(async () => { await logIdentity(); });
      assert.match(lines.join('\n'), /git identity name="" email=""/);
    } finally {
      process.env.PATH = savedPath;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(empty, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('turning tracking on or off prints to the terminal', async () => {
    const dir = tempLibrary();
    try {
      main.call('book:create', { title: 'Hello', author: 'Ada' });
      main.call('book:create', { title: 'Two', author: 'Ada' });
      resetTrackingState();
      const version = localRequire('./package.json').version;
      const lines = await withHistoryConsole(async () => {
        main.emit('versionTracking:state', true);
        main.emit('versionTracking:state', true);
        main.emit('versionTracking:state', false);
      });
      assert.equal(lines.filter((l) => l.includes('version control enabled')).length, 1);
      assert.match(
        lines.join('\n'),
        new RegExp(
          'version control enabled version=' + version.replace(/\./g, '\\.') +
          ' books=2 library=' + dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        )
      );
      assert.match(lines.join('\n'), /version control disabled/);
    } finally {
      resetTrackingState();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a chapter write is a new commit, and the commit does not change that file', async () => {
    const dir = tempLibrary();
    try {
      const book = main.call('book:create', { title: 'Hello', author: 'Ada' });
      const folder = path.join(dir, book.id);
      setTracking(true);
      await withHistoryConsole(async () => { await histories(); });
      const before = commitCount(folder);

      const html = '<p>Once upon a time</p>';
      assert.equal(main.call('chapter:write', book.id, 'c1', html), true);
      const file = path.join(folder, 'chapters', 'c1.html');
      assert.equal(commitCount(folder), before);
      const mark = stamp(file);

      await withHistoryConsole(async () => { await histories(); });
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
      const lines = await withHistoryConsole(async () => { await histories(); });
      const log = fs.readFileSync(path.join(dir, 'neo-errors.log'), 'utf8');
      assert.equal((log.match(/\[history\]/g) || []).length, 1);
      assert.match(log, /ENOENT/);
      assert.equal(lines.some((l) => l.includes('ENOENT')), true);
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

  test('git with no user identity logs and leaves the chapter in place', async () => {
    const dir = tempLibrary();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-no-git-id-'));
    const blank = path.join(home, 'gitconfig');
    fs.writeFileSync(blank, '');
    const saved = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL
    };
    try {
      const first = main.call('book:create', { title: 'One', author: 'Ada' });
      const second = main.call('book:create', { title: 'Two', author: 'Ada' });
      const html = '<p>The words stay.</p>';
      main.call('chapter:write', first.id, 'c1', html);
      main.call('chapter:write', second.id, 'c1', html);
      setTracking(true);
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      process.env.GIT_CONFIG_GLOBAL = blank;
      process.env.GIT_CONFIG_SYSTEM = blank;
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.GIT_AUTHOR_NAME;
      delete process.env.GIT_AUTHOR_EMAIL;
      delete process.env.GIT_COMMITTER_NAME;
      delete process.env.GIT_COMMITTER_EMAIL;

      const lines = await withHistoryConsole(async () => { await histories(); });
      const log = fs.readFileSync(path.join(dir, 'neo-errors.log'), 'utf8');
      assert.equal((log.match(/\[history\]/g) || []).length, 2);
      assert.match(log, /author|identity|user\.|who you are/i);
      assert.equal(lines.some((l) => /author|identity|user\.|who you are/i.test(l)), true);
      assert.equal(lines.some((l) => l.includes('checkpoint saved')), false);
      for (const book of [first, second]) {
        const folder = path.join(dir, book.id);
        const file = path.join(folder, 'chapters', 'c1.html');
        assert.equal(fs.readFileSync(file, 'utf8'), html);
        assert.equal(fs.existsSync(path.join(folder, '.git')), true);
        let head = true;
        try {
          execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
            cwd: folder,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
          });
        } catch {
          head = false;
        }
        assert.equal(head, false);
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(home, { recursive: true, force: true });
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
      await withHistoryConsole(async () => { await histories(); });
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
