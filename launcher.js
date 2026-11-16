'use strict';

const copy = {
  en: {
    saved: 'Open HAR or SAZ',
    savedDescription: 'Inspect a saved capture',
    live: 'Start live recording',
    liveDescription: 'Set up before visiting a site',
    setupTitle: 'Set up live recording',
    setupIntro: 'Select Network+ before visiting a site to capture its very first request.',
    languageLabel: 'Language',
    systemLanguage: 'Browser default',
    guideLanguage: 'Guide language',
    stepDevTools: 'Open DevTools in this tab',
    stepPanel: 'Select the Network+ tab',
    stepPanelHelp: 'If it is hidden, look under » or the + button (More tools) in DevTools.',
    stepNavigate: 'Open the site in this tab',
    stepNavigateHelp: 'Keep DevTools open and navigate to the site you want to record, for example from a bookmark.',
    reportProblem: 'Report a problem',
    cannotOpen: 'The workspace could not open. Please try again.',
    cannotSaveLanguage: 'Could not save the language. Please try again.',
  },
  ja: {
    saved: 'HAR・SAZを開く',
    savedDescription: '保存済みの通信を調べる',
    live: 'ライブ記録を始める',
    liveDescription: 'サイトを開く前に記録を準備する',
    setupTitle: 'ライブ記録の準備',
    setupIntro: 'サイトを開く前に Network+ を選ぶと、最初の通信から記録できます。',
    languageLabel: '表示言語',
    systemLanguage: 'ブラウザーに合わせる',
    guideLanguage: '案内の表示言語',
    stepDevTools: 'このタブで開発者ツール（DevTools）を開く',
    stepPanel: 'Network+ タブを選ぶ',
    stepPanelHelp: '見えないときは、開発者ツールの「»」か「＋」を開きます。',
    stepNavigate: 'このタブで記録したいサイトを開く',
    stepNavigateHelp: '開発者ツールを開いたまま、ブックマークなど普段の方法で移動します。',
    reportProblem: '不具合を報告',
    cannotOpen: 'Network+の画面を開けませんでした。もう一度お試しください。',
    cannotSaveLanguage: '表示言語を保存できませんでした。もう一度お試しください。',
  },
};

const root = document.documentElement;
const liveSetup = new URLSearchParams(location.search).get('view') === 'live';
const statusMessage = document.getElementById('launcher-status');
const languageSelect = document.getElementById('launcher-language');
const reportLink = document.getElementById('report-problem');
const reportFormUrl = 'https://docs.google.com/forms/d/e/1FAIpQLScPzbNqgDnYQEjHr0yFsBA9ANAoB_n1SlTUe1AYEhTC_iJk3w/viewform';
const reportEnvironmentEntry = 'entry.554959465';
const langKey = 'networkPlus.lang';
const guideLangKey = 'networkPlus.liveGuideLang';
const themeKey = 'networkPlus.theme';
const preferredLocale = (navigator.languages || []).find((locale) => /^(ja|en)(?:[-_]|$)/i.test(locale));
const browserLanguage = [chrome.i18n?.getUILanguage(), preferredLocale || navigator.language]
  .some((locale) => /^ja(?:[-_]|$)/i.test(locale)) ? 'ja' : 'en';
let language = browserLanguage;
let statusKey = '';
let languagePreference = 'system';
let guidePreference;
let pendingLanguageSave;
const changedPreferences = new Set();
const guideLanguages = {
  ja: document.getElementById('guide-ja'),
  en: document.getElementById('guide-en'),
};

function reportEnvironment() {
  const agentData = navigator.userAgentData;
  const agent = (navigator.userAgent || '').slice(0, 512);
  const brands = Array.isArray(agentData?.brands) ? agentData.brands : [];
  const platform = agentData?.platform;
  const browsers = [
    ['Microsoft Edge', /\bEdg\/([1-9]\d{0,2})(?:\.|\s|$)/],
    ['Google Chrome', /\bChrome\/([1-9]\d{0,2})(?:\.|\s|$)/],
  ];
  const osFamilies = [
    ['Windows', /Windows NT/i],
    ['iOS', /iPhone|iPad|iPod/i],
    ['macOS', /Macintosh|Mac OS X/i],
    ['Android', /Android/i],
    ['Chrome OS', /CrOS/i],
    ['Linux', /Linux/i],
  ];
  const details = [];
  const version = chrome.runtime.getManifest().version;
  if (typeof version === 'string' && /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(version)) {
    details.push(`Network+: ${version}`);
  }
  for (const [name, token] of browsers) {
    const brand = brands.find((candidate) => candidate?.brand === name);
    const versionMatch = typeof brand?.version === 'string'
      ? brand.version.match(/^([1-9]\d{0,2})(?:\.\d{1,5}){0,3}$/) : null;
    const major = versionMatch?.[1] || agent.match(token)?.[1];
    if (brand || major) {
      details.push(`Browser: ${major ? `${name} ${major}` : name}`);
      break;
    }
  }
  const platformName = platform === 'ChromeOS' ? 'Chrome OS' : platform;
  const os = platformName ? osFamilies.find(([name]) => name === platformName)
    : osFamilies.find(([, token]) => token.test(agent));
  if (os) details.push(`OS: ${os[0]}`);
  return details.join(' | ');
}

function setStatus(key) {
  statusKey = key;
  statusMessage.textContent = key ? copy[language][key] : '';
}

function renderLanguage() {
  const preferred = liveSetup && guidePreference ? guidePreference : languagePreference;
  language = preferred === 'system' ? browserLanguage : preferred;
  root.lang = language;
  languageSelect.value = languagePreference;
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
  } else {
    const url = new URL(reportFormUrl);
    url.searchParams.set('hl', language);
    if (environment) {
      url.searchParams.set('usp', 'pp_url');
      url.searchParams.set(reportEnvironmentEntry, environment);
    }
    reportLink.href = url.href;
  }
  setStatus(statusKey);
}

function explicitLanguage(value) {
  return value === 'ja' || value === 'en' ? value : undefined;
}

function renderTheme(theme) {
  root.style.colorScheme = theme === 'light' || theme === 'dark' ? theme : '';
}

function saveLanguage(preferences) {
  setStatus('');
  pendingLanguageSave = new Promise((resolve) => {
    chrome.storage.local.set(preferences, () => {
      if (chrome.runtime.lastError) setStatus('cannotSaveLanguage');
      resolve();
    });
  });
}

document.getElementById('launcher-actions').hidden = liveSetup;
document.getElementById('launcher-preferences').hidden = liveSetup;
document.getElementById('live-setup').hidden = !liveSetup;
document.getElementById('guide-languages').hidden = !liveSetup;
if (liveSetup) document.body.dataset.view = 'live';
const environment = liveSetup ? '' : reportEnvironment();
renderLanguage();

chrome.storage.local.get([langKey, themeKey, guideLangKey], (preferences) => {
  if (chrome.runtime.lastError) return;
  if (!changedPreferences.has(langKey)) languagePreference = explicitLanguage(preferences[langKey]) || 'system';
  if (!changedPreferences.has(guideLangKey)) guidePreference = explicitLanguage(preferences[guideLangKey]);
  if (!changedPreferences.has(themeKey)) renderTheme(preferences[themeKey]);
  renderLanguage();
});

chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  for (const key of Object.keys(changes)) changedPreferences.add(key);
  if (changes[themeKey]) renderTheme(changes[themeKey].newValue);
  if (!changes[langKey] && !changes[guideLangKey]) return;
  if (changes[langKey]) languagePreference = explicitLanguage(changes[langKey].newValue) || 'system';
  if (changes[guideLangKey]) guidePreference = explicitLanguage(changes[guideLangKey].newValue);
  renderLanguage();
});

if (liveSetup) {
  for (const [locale, button] of Object.entries(guideLanguages)) {
    button.addEventListener('click', () => {
      changedPreferences.add(guideLangKey);
      guidePreference = locale;
      renderLanguage();
      saveLanguage({ [guideLangKey]: locale });
    });
  }
} else {
  languageSelect.addEventListener('change', () => {
    changedPreferences.add(langKey);
    changedPreferences.add(guideLangKey);
    languagePreference = explicitLanguage(languageSelect.value) || 'system';
    guidePreference = undefined;
    renderLanguage();
    saveLanguage({ [langKey]: languagePreference, [guideLangKey]: null });
  });

  const saved = document.getElementById('open-saved');
  const live = document.getElementById('open-live');
  const open = async (target) => {
    if (saved.disabled) return;
    saved.disabled = true;
    live.disabled = true;
    try {
      await pendingLanguageSave;
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
