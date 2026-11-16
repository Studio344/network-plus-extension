'use strict';
// Direct unit coverage for the background worker's undocked DevTools minimize behavior. The worker source is
// executed against a scripted chrome.windows so every response branch —
// focused pick, single-window fallback, ambiguous decline, error paths —
// can fail a gate instead of only being reachable in a real browser.
const fs = require('fs');
const path = require('path');

const workerSource = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');

function runWorker({ windows, getAllError = null, updateError = null } = {}) {
  const updates = [];
  let listener = null;
  const chromeMock = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
    },
    windows: {
      getAll: (options, cb) => {
        expect(options).toEqual({ windowTypes: ['devtools'] });
        if (getAllError) chromeMock.runtime.lastError = { message: getAllError };
        cb(windows);
        chromeMock.runtime.lastError = null;
      },
      update: (id, opts, cb) => {
        updates.push({ id, opts });
        if (updateError) chromeMock.runtime.lastError = { message: updateError };
        cb();
        chromeMock.runtime.lastError = null;
      },
    },
  };
  new Function('chrome', workerSource)(chromeMock);
  if (typeof listener !== 'function') throw new Error('The worker registered no onMessage listener.');
  return { listener, updates };
}

function ask(listener, message) {
  let response = null;
  const keepChannelOpen = listener(message, {}, (answer) => {
    response = answer;
  });
  return { response, keepChannelOpen };
}

describe('background worker minimize handshake', () => {
  test('minimizes the focused DevTools window among several', () => {
    const { listener, updates } = runWorker({
      windows: [
        { id: 10, type: 'devtools', focused: false },
        { id: 11, type: 'devtools', focused: true },
      ],
    });
    const { response, keepChannelOpen } = ask(listener, { type: 'networkplus-minimize-devtools' });
    expect(keepChannelOpen).toBe(true);
    expect(response).toEqual({ minimized: true });
    expect(updates).toEqual([{ id: 11, opts: { state: 'minimized' } }]);
  });

  test('falls back to the only DevTools window when focus already moved', () => {
    const { listener, updates } = runWorker({ windows: [{ id: 20, type: 'devtools', focused: false }] });
    const { response } = ask(listener, { type: 'networkplus-minimize-devtools' });
    expect(response).toEqual({ minimized: true });
    expect(updates).toEqual([{ id: 20, opts: { state: 'minimized' } }]);
  });

  test('answers minimized:false when no DevTools window exists (docked session)', () => {
    const { listener, updates } = runWorker({ windows: [] });
    const { response } = ask(listener, { type: 'networkplus-minimize-devtools' });
    expect(response).toEqual({ minimized: false });
    expect(updates).toHaveLength(0);
  });

  test('declines to guess between multiple unfocused DevTools windows', () => {
    const { listener, updates } = runWorker({
      windows: [
        { id: 30, type: 'devtools', focused: false },
        { id: 31, type: 'devtools', focused: false },
      ],
    });
    const { response } = ask(listener, { type: 'networkplus-minimize-devtools' });
    expect(response).toEqual({ minimized: false });
    expect(updates).toHaveLength(0);
  });

  test('a getAll error answers minimized:false instead of throwing', () => {
    const { listener, updates } = runWorker({
      windows: [{ id: 40, type: 'devtools', focused: true }],
      getAllError: 'windows unavailable',
    });
    const { response } = ask(listener, { type: 'networkplus-minimize-devtools' });
    expect(response).toEqual({ minimized: false });
    expect(updates).toHaveLength(0);
  });

  test('an update error reports the truthful minimized:false outcome', () => {
    const { listener } = runWorker({
      windows: [{ id: 50, type: 'devtools', focused: true }],
      updateError: 'window vanished',
    });
    const { response } = ask(listener, { type: 'networkplus-minimize-devtools' });
    expect(response).toEqual({ minimized: false });
  });

  test('unrelated messages are ignored without touching windows', () => {
    let touched = false;
    const chromeMock = {
      runtime: { lastError: null, onMessage: { addListener: () => {} } },
      windows: {
        getAll: () => {
          touched = true;
        },
        update: () => {
          touched = true;
        },
      },
    };
    let listener = null;
    chromeMock.runtime.onMessage.addListener = (fn) => {
      listener = fn;
    };
    new Function('chrome', workerSource)(chromeMock);
    const result = listener({ type: 'someone-elses-message' }, {}, () => {
      touched = true;
    });
    expect(result).toBeUndefined();
    expect(touched).toBe(false);
  });
});

const launcherSource = fs.readFileSync(path.join(__dirname, '..', 'launcher.js'), 'utf8');

function runLauncher({ search = '' } = {}) {
  const elements = new Map();
  const chrome = {
    storage: { local: { get: (_keys, callback) => callback({}) } },
    runtime: {
      getURL: (file) => 'chrome-extension://network-plus-test/' + file,
    },
    tabs: { create: jest.fn(async () => ({})) },
  };
  const document = {
    body: { dataset: {} },
    documentElement: { style: {} },
    querySelectorAll: () => [],
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          disabled: false, hidden: false, textContent: '', handlers: {},
          addEventListener(name, handler) { this.handlers[name] = handler; },
        });
      }
      return elements.get(id);
    },
  };
  const location = { search };
  const window = { close: jest.fn() };
  new Function('chrome', 'document', 'location', 'navigator', 'window', launcherSource)(
    chrome, document, location, { language: 'en-US' }, window,
  );
  const get = (id) => document.getElementById(id);
  return { chrome, get, close: window.close };
}

describe('extension icon launcher', () => {
  test.each([
    ['open-saved', 'panel.html?view=offline'],
    ['open-live', 'launcher.html?view=live'],
  ])('opens the audited destination for %s', async (id, target) => {
    const { get, chrome, close } = runLauncher();
    expect(get('launcher-actions').hidden).toBe(false);
    expect(get('live-setup').hidden).toBe(true);
    await get(id).handlers.click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://network-plus-test/' + target });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('the live guide leaves navigation to the user in the same tab', () => {
    const { chrome, get, close } = runLauncher({ search: '?view=live' });
    expect(get('live-setup').hidden).toBe(false);
    expect(get('launcher-actions').hidden).toBe(true);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
