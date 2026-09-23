import Prism from 'prismjs'; // eslint-disable-line

import 'prismjs/plugins/toolbar/prism-toolbar';
import 'prismjs/plugins/toolbar/prism-toolbar.css';
import 'prismjs/plugins/line-numbers/prism-line-numbers';
import 'prismjs/plugins/line-numbers/prism-line-numbers.css';
import 'prismjs/plugins/line-highlight/prism-line-highlight';

import Clipboard from 'clipboard';
import $ from 'jquery';
import components from 'prismjs/components';
import getLoader from 'prismjs/dependencies';
import Notification from 'vj/components/notification/index';
import { getAvailableLangs, i18n, request } from 'vj/utils';
import { canUsePretest } from '../scratchpad/capabilities';
import languageMeta from './meta';

const files = require.context('prismjs/components/', true, /prism-[a-z0-9-]+\.js/);
const loadedLanguages = new Set();
function loadLanguages() {
  const languages = Object.keys(components.languages).filter((l) => l !== 'meta');
  const loaded = [...loadedLanguages, ...Object.keys(Prism.languages)];
  getLoader(components, languages, loaded).load((lang) => {
    files(`./prism-${lang}.js`);
    loadedLanguages.add(lang);
  });
}

const languageExtMap = {};
loadLanguages();
// Map possible language names to Prism language name
languageMeta.forEach((meta) => {
  for (let i = 0; i < meta.ext.length; ++i) {
    if (Prism.languages[meta.ext[i]] !== undefined) {
      meta.target = meta.ext[i];
      break;
    }
  }
  meta.ext.forEach((ext) => {
    languageExtMap[ext] = meta.target;
  });
});

// Copy to Clipboard
Prism.plugins.toolbar.registerButton('copy-to-clipboard', (env) => {
  const linkCopy = document.createElement('a');
  linkCopy.href = 'javascript:;';
  linkCopy.textContent = 'Copy';
  const clip = new Clipboard(linkCopy, { text: () => env.code });
  clip.on('success', () => {
    Notification.success(i18n('Content copied to clipboard!'), 1000);
  });
  clip.on('error', () => {
    Notification.error(i18n('Copy failed :('));
  });
  return linkCopy;
});

function getSampleInputCode(env) {
  const match = (env.element.className || '').match(/(?:^|\s)language-input([0-9]+)(?:\s|$)/);
  if (match && Number.isSafeInteger(+match[1])) return env.code;

  const pre = env.element.parentElement;
  const sampleBlock = pre?.parentElement?.classList.contains('code-toolbar') ? pre.parentElement : pre;
  const inputHeading = sampleBlock?.previousElementSibling;
  const outputHeading = sampleBlock?.nextElementSibling;
  const inputNumber = inputHeading?.textContent.trim().match(/^(?:输入|input|sample\s+input)\s*#?\s*(\d+)$/i)?.[1];
  const outputNumber = outputHeading?.textContent.trim().match(/^(?:输出|output|sample\s+output)\s*#?\s*(\d+)$/i)?.[1];
  const outputBlock = outputHeading?.nextElementSibling;
  const hasOutput = outputBlock?.tagName.toLowerCase() === 'pre'
    || (outputBlock?.classList.contains('code-toolbar') && outputBlock.querySelector('pre'));
  if (inputNumber && outputNumber === inputNumber && hasOutput) {
    return env.code;
  }
  return null;
}

function createSampleInputButton(env, className, label, onClick) {
  if (getSampleInputCode(env) === null) return null;
  const link = document.createElement('a');
  link.href = 'javascript:;';
  link.className = className;
  link.textContent = i18n(label);
  link.addEventListener('click', (event) => {
    event.preventDefault();
    onClick(env);
  });
  return link;
}

const scratchpadPretestButtons = new Set();
let observedScratchpadStore;

function getScratchpadLanguage() {
  const selected = window.store?.getState()?.editor?.lang;
  if (selected) return selected;
  const config = UiContext.pdoc?.config;
  if (!config) return '';
  const availableLangs = getAvailableLangs(config.langs);
  const keys = Object.keys(availableLangs);
  const cacheKey = `${UserContext._id}/${UiContext.pdoc.domainId}/${UiContext.pdoc.docId}${UiContext.tdoc?._id ? `@${UiContext.tdoc._id}` : ''}`;
  let language = UiContext.codeLang || '';
  try {
    language = localStorage.getItem(`${cacheKey}#lang`) || language;
  } catch (err) {
    // Use the configured language preference when local storage is unavailable.
  }
  if (availableLangs[language]) return language;
  const preferredPretestLang = language && keys.find((key) => {
    const pretestLang = availableLangs[key].pretest;
    return typeof pretestLang === 'string' && pretestLang.split('.')[0] === language.split('.')[0];
  });
  return preferredPretestLang || keys[0] || language;
}

function canRunSamplePretest() {
  const config = UiContext.pdoc?.config;
  const lang = getScratchpadLanguage();
  return !!config && canUsePretest(config, window.LANGS?.[lang]);
}

function updateScratchpadPretestButtons() {
  for (const button of scratchpadPretestButtons) {
    if (!button.isConnected) {
      scratchpadPretestButtons.delete(button);
      continue;
    }
    button.style.display = canRunSamplePretest() ? '' : 'none';
  }
}

function observeScratchpadStore() {
  const store = window.store;
  if (!store || observedScratchpadStore === store) return;
  observedScratchpadStore = store;
  store.subscribe(updateScratchpadPretestButtons);
  updateScratchpadPretestButtons();
}

document.addEventListener('hydro:scratchpad-store-ready', observeScratchpadStore);
if (window.store) observeScratchpadStore();

Prism.plugins.toolbar.registerButton('scratchpad-fill-pretest', (env) => createSampleInputButton(
  env,
  'scratchpad-fill-button',
  'Fill to Pretest',
  (sample) => {
    const store = window.store;
    if (!store) return;
    try {
      store.dispatch({
        type: 'SCRATCHPAD_PRETEST_DATA_CHANGE',
        payload: {
          type: 'input',
          value: getSampleInputCode(sample),
        },
      });
      Notification.success(i18n('Input filled to pretest!'), 2000);
    } catch (err) {
      Notification.error(i18n('Failed to fill input'));
    }
  },
));

Prism.plugins.toolbar.registerButton('scratchpad-run-pretest', (env) => {
  if (getSampleInputCode(env) === null) return null;
  const button = createSampleInputButton(
    env,
    'scratchpad-run-pretest-button',
    'Run Pretest',
    (sample) => {
      const store = window.store;
      if (!store || !canRunSamplePretest()) return;
      const state = store.getState();
      if (state.ui?.isPosting || state.pretest?.isRunning || state.ui?.pretestWaitSec > 0) return;
      try {
        const input = getSampleInputCode(sample);
        store.dispatch({
          type: 'SCRATCHPAD_PRETEST_DATA_CHANGE',
          payload: {
            type: 'input',
            value: input,
          },
        });
        store.dispatch({
          type: 'SCRATCHPAD_UI_SET_VISIBILITY',
          payload: {
            uiElement: 'pretest',
            visibility: true,
          },
        });
        const editorState = store.getState().editor;
        store.dispatch({
          type: 'SCRATCHPAD_POST_PRETEST',
          payload: request.post(UiContext.postSubmitUrl, {
            lang: editorState.lang,
            code: editorState.code,
            input: [input],
            pretest: true,
          }),
        });
      } catch (err) {
        Notification.error(i18n('Failed to run pretest'));
      }
    },
  );
  if (button) {
    button.style.display = canRunSamplePretest() ? '' : 'none';
    scratchpadPretestButtons.add(button);
  }
  return button;
});

const invisibles = {
  tab: /\t/,
  crlf: /\r\n/,
  lf: /\n/,
  cr: /\r/,
  space: / /,
};

function addInvisibles(grammar) {
  if (!grammar || grammar.tab) return;
  for (const name in invisibles) {
    if (Object.hasOwn(invisibles, name)) {
      grammar[name] = invisibles[name];
    }
  }
  for (const name in grammar) {
    if (Object.hasOwn(grammar, name) && !invisibles[name]) {
      if (name === 'rest') addInvisibles(grammar.rest);
      else handlerInvisiblesToken(grammar, name); // eslint-disable-line ts/no-use-before-define
    }
  }
}

function handlerInvisiblesToken(tokens, name) {
  const value = tokens[name];
  const type = Prism.util.type(value);
  if (type === 'RegExp') {
    const inside = {};
    tokens[name] = { pattern: value, inside };
    addInvisibles(inside);
  } else if (type === 'Array') {
    for (let i = 0, l = value.length; i < l; i++) handlerInvisiblesToken(value, i);
  } else {
    value.inside ||= {};
    addInvisibles(value.inside);
  }
}

Prism.hooks.add('before-highlight', (env) => {
  if (UserContext.showInvisibleChar) addInvisibles(env.grammar);
});

const prismjsApiWrap = {
  highlightBlocks: ($dom) => {
    $dom.find('pre code').get().forEach((code) => {
      if (code.closest('.md-editor-preview') || code.classList.contains('language-mermaid')) return;
      if ((code.textContent || '').length > 10000) return;
      const $code = $(code);
      const $pre = $code.parent();
      $pre.addClass('syntax-hl');
      const language = ($(code).attr('class') || '').trim();
      // try to map the language name
      const m = language.match(/language-([a-z]+)/);
      if (m && m[1]) {
        const languageName = m[1].toLowerCase();
        if (languageExtMap[languageName]) {
          $(code).attr('class', `language-${languageExtMap[languageName]}`);
        }
      }
      Prism.highlightElement(code);
    });
  },
  highlight: (text, grammar, language) => Prism.highlight(text, grammar, language),
  Prism,
};

export default prismjsApiWrap;
