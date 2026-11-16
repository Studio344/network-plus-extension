'use strict';

const copy = {
  en: {
    saved: 'Open HAR or SAZ',
    live: 'Start live recording',
    setupTitle: 'Set up live recording',
    stepDevTools: 'Open DevTools in this tab and select Network+.',
    stepNavigate: 'Use a bookmark or the address bar to open the site you want to record in this same tab.',
    cannotOpen: 'The workspace could not open. Please try again.',
  },
  ja: {
    saved: 'HAR・SAZを開く',
    live: 'ライブ記録を始める',
    setupTitle: 'ライブ記録の準備',
    stepDevTools: 'このタブで DevTools を開き、Network+ を選びます。',
    stepNavigate: 'ブックマークなどから、記録したいサイトを同じタブで開きます。',
    cannotOpen: 'Network+の画面を開けませんでした。もう一度お試しください。',
  },
};

const root = document.documentElement;
const liveSetup = new URLSearchParams(location.search).get('view') === 'live';
const statusMessage = document.getElementById('launcher-status');
const browserLanguage = navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
let language = browserLanguage;
let statusKey = '';

function setStatus(key) {
  statusKey = key;
  statusMessage.textContent = key ? copy[language][key] : '';
}

function renderLanguage() {
  root.lang = language;
  document.querySelectorAll('[data-copy]').forEach((element) => {
    element.textContent = copy[language][element.dataset.copy];
  });
  setStatus(statusKey);
}

document.getElementById('launcher-actions').hidden = liveSetup;
document.getElementById('live-setup').hidden = !liveSetup;
if (liveSetup) document.body.dataset.view = 'live';
renderLanguage();

chrome.storage.local.get(['networkPlus.lang', 'networkPlus.theme'], (preferences) => {
  if (chrome.runtime.lastError) return;
  const preferredLanguage = preferences['networkPlus.lang'];
  if (preferredLanguage === 'en' || preferredLanguage === 'ja') {
    language = preferredLanguage;
    renderLanguage();
  }
  const theme = preferences['networkPlus.theme'];
  if (theme === 'light' || theme === 'dark') root.style.colorScheme = theme;
});

if (!liveSetup) {
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
