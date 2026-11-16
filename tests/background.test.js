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

function runLauncher({
  search = '',
  uiLocale,
  languages = ['en-US'],
  preferences = {},
  deferStorage = false,
} = {}) {
  const elements = new Map();
  const guideLanguageKey = 'networkPlus.liveGuideLang';
  let loadPreferences;
  const chrome = {
    i18n: { getUILanguage: () => uiLocale },
    storage: { local: {
      get(_keys, callback) {
        loadPreferences = () => callback(preferences);
        if (!deferStorage) loadPreferences();
      },
      set: jest.fn((_values, callback) => callback()),
    } },
    runtime: {
      getURL: (file) => 'chrome-extension://network-plus-test/' + file,
    },
    tabs: { create: jest.fn(async () => ({})) },
  };
  const document = {
    body: { dataset: {} },
    documentElement: { style: {} },
    querySelectorAll(query) {
      if (query === '[data-copy]') {
        const title = this.getElementById('setup-title');
        title.dataset = { copy: 'setupTitle' };
        return [title];
      }
      return [];
    },
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          disabled: false, hidden: false, textContent: '', handlers: {}, attributes: {},
          setAttribute(name, value) { this.attributes[name] = value; },
          addEventListener(name, handler) { this.handlers[name] = handler; },
        });
      }
      return elements.get(id);
    },
  };
  const location = { search };
  const window = { close: jest.fn() };
  new Function('chrome', 'document', 'location', 'navigator', 'window', launcherSource)(
    chrome, document, location, { language: languages[0], languages }, window,
  );
  const get = (id) => document.getElementById(id);
  return { chrome, get, close: window.close, root: document.documentElement, loadPreferences, guideLanguageKey };
}

describe('extension icon launcher', () => {
  test.each([
    ['open-saved', 'panel.html?view=offline'],
    ['open-live', 'launcher.html?view=live'],
  ])('opens the audited destination for %s', async (id, target) => {
    const { get, chrome, close } = runLauncher();
    expect(get('launcher-actions').hidden).toBe(false);
    expect(get('live-setup').hidden).toBe(true);
    expect(get('guide-languages').hidden).toBe(true);
    await get(id).handlers.click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://network-plus-test/' + target });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('the live guide leaves navigation to the user in the same tab', () => {
    const { chrome, get, close } = runLauncher({ search: '?view=live' });
    expect(get('live-setup').hidden).toBe(false);
    expect(get('launcher-actions').hidden).toBe(true);
    expect(get('guide-languages').hidden).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  test.each([
    ['ja-JP', ['en-US'], {}, 'ja'],
    ['en-US', ['ja-JP', 'ja'], {}, 'ja'],
    ['fr-FR', ['fr-FR', 'ja'], {}, 'ja'],
    ['ja-JP', ['ja-JP'], { 'networkPlus.lang': 'en' }, 'en'],
    ['en-US', ['en-US'], { 'networkPlus.lang': 'en', 'networkPlus.liveGuideLang': 'ja' }, 'ja'],
  ])('initializes the live guide from UI locale %s and language preferences', (uiLocale, languages, preferences, expected) => {
    const { get, root } = runLauncher({ search: '?view=live', uiLocale, languages, preferences });
    expect(root.lang).toBe(expected);
    expect(get('setup-title').textContent).toBe(expected === 'ja' ? 'ライブ記録の準備' : 'Set up live recording');
    expect(get('guide-' + expected).attributes['aria-pressed']).toBe('true');
  });

  test('switches the guide to Japanese even before preferences load and saves the guide preference only', () => {
    const { get, root, chrome, loadPreferences, guideLanguageKey } = runLauncher({
      search: '?view=live',
      preferences: { 'networkPlus.lang': 'en' },
      deferStorage: true,
    });
    get('guide-ja').handlers.click();
    loadPreferences();
    expect(root.lang).toBe('ja');
    expect(get('setup-title').textContent).toBe('ライブ記録の準備');
    expect(get('guide-en').attributes['aria-pressed']).toBe('false');
    expect(chrome.storage.local.set).toHaveBeenLastCalledWith({ [guideLanguageKey]: 'ja' }, expect.any(Function));
    get('guide-en').handlers.click();
    expect(root.lang).toBe('en');
    expect(chrome.storage.local.set).toHaveBeenLastCalledWith({ [guideLanguageKey]: 'en' }, expect.any(Function));
  });

  test('the guide language override does not change the popup language', () => {
    const { root } = runLauncher({ preferences: { 'networkPlus.lang': 'en', 'networkPlus.liveGuideLang': 'ja' } });
    expect(root.lang).toBe('en');
  });
});
