'use strict';

const copy = {
  en: {
    saved: 'Open HAR or SAZ',
    live: 'Start live recording',
    setupTitle: 'Set up live recording',
    guideLanguage: 'Guide language',
    stepDevTools: 'Open DevTools in this tab',
    stepPanel: 'Select the Network+ tab',
    stepPanelHelp: 'If it is hidden, look under » or the + button (More tools) in DevTools.',
    stepNavigate: 'Open a bookmark in this tab',
    stepNavigateHelp: 'Keep DevTools open and go to the site you want to record from your bookmarks or favorites.',
    cannotOpen: 'The workspace could not open. Please try again.',
  },
  ja: {
    saved: 'HAR・SAZを開く',
    live: 'ライブ記録を始める',
    setupTitle: 'ライブ記録の準備',
    guideLanguage: '案内の表示言語',
    stepDevTools: 'このタブで開発者ツール（DevTools）を開く',
    stepPanel: 'Network+ タブを選ぶ',
    stepPanelHelp: '見つからないときは、開発者ツールの「»」または「＋」から探せます。',
    stepNavigate: 'このタブでブックマークを開く',
    stepNavigateHelp: '開発者ツールを開いたまま、お気に入りやブックマークから記録したいサイトに移動します。',
    cannotOpen: 'Network+の画面を開けませんでした。もう一度お試しください。',
  },
};

const root = document.documentElement;
const liveSetup = new URLSearchParams(location.search).get('view') === 'live';
const statusMessage = document.getElementById('launcher-status');
const guideLangKey = 'networkPlus.liveGuideLang';
const preferredLocale = (navigator.languages || []).find((locale) => /^(ja|en)(?:[-_]|$)/i.test(locale));
const browserLanguage = [chrome.i18n?.getUILanguage(), preferredLocale || navigator.language]
  .some((locale) => /^ja(?:[-_]|$)/i.test(locale)) ? 'ja' : 'en';
let language = browserLanguage;
let statusKey = '';
let guideLanguagePicked = false;
const guideLanguages = {
  ja: document.getElementById('guide-ja'),
  en: document.getElementById('guide-en'),
};

function setStatus(key) {
  statusKey = key;
  statusMessage.textContent = key ? copy[language][key] : '';
}

function renderLanguage() {
  root.lang = language;
  document.querySelectorAll('[data-copy]').forEach((element) => {
    element.textContent = copy[language][element.dataset.copy];
  });
  document.querySelectorAll('[data-label]').forEach((element) => {
    element.setAttribute('aria-label', copy[language][element.dataset.label]);
  });
  if (liveSetup) {
    for (const [locale, button] of Object.entries(guideLanguages)) {
      button.setAttribute('aria-pressed', String(locale === language));
    }
  }
  setStatus(statusKey);
}

document.getElementById('launcher-actions').hidden = liveSetup;
document.getElementById('live-setup').hidden = !liveSetup;
if (liveSetup) document.body.dataset.view = 'live';
renderLanguage();

chrome.storage.local.get(['networkPlus.lang', 'networkPlus.theme', guideLangKey], (preferences) => {
  if (chrome.runtime.lastError) return;
  if (!guideLanguagePicked) {
    const guideLanguage = preferences[guideLangKey];
    const panelLanguage = preferences['networkPlus.lang'];
    if (liveSetup && (guideLanguage === 'en' || guideLanguage === 'ja')) {
      language = guideLanguage;
    } else if (panelLanguage === 'en' || panelLanguage === 'ja') {
      language = panelLanguage;
    }
    renderLanguage();
  }
  const theme = preferences['networkPlus.theme'];
  if (theme === 'light' || theme === 'dark') root.style.colorScheme = theme;
});

if (liveSetup) {
  for (const [locale, button] of Object.entries(guideLanguages)) {
    button.addEventListener('click', () => {
      guideLanguagePicked = true;
      language = locale;
      renderLanguage();
      chrome.storage.local.set({ [guideLangKey]: locale }, () => {
        if (chrome.runtime.lastError) console.warn('Network+ could not save the guide language.');
      });
    });
  }
} else {
  const saved = document.getElementById('open-saved');
  const live = document.getElementById('open-live');
  const open = async (target) => {
    if (saved.disabled) return;
    saved.disabled = true;
    live.disabled = true;
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL(target) });
      window.close();
    } catch {
      setStatus('cannotOpen');
      saved.disabled = false;
      live.disabled = false;
    }
  };
  saved.addEventListener('click', () => open('panel.html?view=offline'));
  live.addEventListener('click', () => open('launcher.html?view=live'));
}
