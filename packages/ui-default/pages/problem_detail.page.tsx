import $ from 'jquery';
import * as yaml from 'js-yaml';
import _ from 'lodash';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { confirm } from 'vj/components/dialog';
import Notification from 'vj/components/notification';
import { downloadProblemSet } from 'vj/components/zipDownloader';
import { NamedPage } from 'vj/misc/Page';
import {
  delay, i18n, loadReactRedux, pjax, request, tpl,
} from 'vj/utils';
import { openDB } from 'vj/utils/db';

// React failures after createRoot().render() do not propagate to the caller.
class MonitoredEditorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.warn('Monitored editor render failed.', error);
    document.dispatchEvent(new Event('hydro:monitored-editor-failed'));
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function waitForMonitoredEditorReady() {
  let cleanup = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    const ready = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error('Monitored editor failed to mount'));
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Monitored editor readiness timed out'));
    }, 18000);
    cleanup = () => {
      window.clearTimeout(timeout);
      document.removeEventListener('hydro:monitored-editor-ready', ready);
      document.removeEventListener('hydro:monitored-editor-failed', failed);
    };
    document.addEventListener('hydro:monitored-editor-ready', ready);
    document.addEventListener('hydro:monitored-editor-failed', failed);
  });
  return { promise, cancel: () => cleanup() };
}

// Only the active editor may persist the monitored draft. Keep a synchronous
// copy in the basic form so it can take over even when advanced rendering fails.
function createMonitoredDraftBridge(store, cacheKey: string) {
  const basic = document.getElementById('monitored-basic-editor');
  const code = basic?.querySelector<HTMLTextAreaElement>('textarea[name="code"]');
  const lang = basic?.querySelector<HTMLSelectElement>('select[name="lang"]');
  const save = () => {
    if (basic?.getAttribute('data-editor-owner') !== 'advanced') return;
    const editor = store.getState().editor;
    if (code) code.value = editor.code;
    if (lang) lang.value = editor.lang;
    try {
      localStorage.setItem(`hydro-monitor-draft:${cacheKey}`, JSON.stringify({ code: editor.code, lang: editor.lang }));
    } catch { /* The basic form still retains the current draft. */ }
  };
  const update = _.debounce(save, 150);
  window.addEventListener('pagehide', save);
  return {
    update,
    activate: () => {
      // Basic editing can continue while the advanced assets are loading, and
      // after a failed attempt. Hand those newer edits to the store first.
      if (basic?.getAttribute('data-draft-edited') === 'true') {
        store.dispatch({ type: 'SCRATCHPAD_EDITOR_HYDRATE', payload: { code: code?.value, lang: lang?.value } });
        basic.removeAttribute('data-draft-edited');
      }
      basic?.setAttribute('data-editor-owner', 'advanced');
      save();
    },
    restore: () => {
      update.cancel();
      // A mount failure can happen before activation, after an IDB draft was
      // hydrated. Preserve that draft unless the basic form has newer edits.
      if (basic?.getAttribute('data-draft-edited') !== 'true') basic?.setAttribute('data-editor-owner', 'advanced');
      save();
      basic?.removeAttribute('data-editor-owner');
    },
  };
}

class ProblemPageExtender {
  isExtended = false;
  inProgress = false;
  $content = $('.problem-content-container');
  $contentBound = this.$content.closest('.section');
  $scratchpadContainer = $('.scratchpad-container');

  async extend() {
    if (this.inProgress) return;
    if (this.isExtended) return;
    this.inProgress = true;

    const bound = this.$contentBound
      .get(0)
      .getBoundingClientRect();

    // @ts-ignore
    this.$content.transition({ opacity: 0 }, { duration: 100 });
    await delay(100);

    $('body').addClass('header--collapsed mode--scratchpad');
    await this.$scratchpadContainer
      .css({
        left: bound.left,
        top: bound.top,
        width: bound.width,
        height: bound.height,
      })
      .show()
      .transition({
        // @ts-ignore
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
      }, {
        duration: 500,
        easing: 'easeOutCubic',
      })
      .promise();

    $('.main > .row').hide();
    $('.footer').hide();
    $(window).scrollTop(0);
    window.document.body.style.overflow = 'hidden';

    this.inProgress = false;
    this.isExtended = true;
  }

  async collapse() {
    if (this.inProgress) return;
    if (!this.isExtended) return;
    this.inProgress = true;

    $(window).scrollTop(0);
    $('.main > .row').show();
    $('.footer').show();

    const bound = this.$contentBound
      .get(0)
      .getBoundingClientRect();

    $('body').removeClass('header--collapsed mode--scratchpad');

    await this.$scratchpadContainer
      .transition({
        // @ts-ignore
        left: bound.left,
        top: bound.top,
        width: bound.width,
        height: bound.height,
      }, {
        duration: 500,
        easing: 'easeOutCubic',
      })
      .promise();

    this.$scratchpadContainer.hide();
    // @ts-ignore
    this.$content.transition({ opacity: 1 }, { duration: 100 });
    window.document.body.style.overflow = 'scroll';

    this.inProgress = false;
    this.isExtended = false;
  }

  toggle() {
    if (this.isExtended) this.collapse();
    else this.extend();
  }
}

const page = new NamedPage(['problem_detail', 'contest_detail_problem', 'homework_detail_problem'], async () => {
  let reactLoaded = false;
  let renderReact = null;
  let unmountReact = null;
  let monitoredDraft: ReturnType<typeof createMonitoredDraftBridge> | null = null;
  const extender = new ProblemPageExtender();

  async function handleClickDownloadProblem() {
    await downloadProblemSet([UiContext.problemNumId], UiContext.pdoc.title);
  }

  async function scratchpadFadeIn() {
    await $('#scratchpad')
      // @ts-ignore
      .transition(
        { opacity: 1 },
        200,
        'easeOutCubic',
      )
      .promise();
  }

  async function scratchpadFadeOut() {
    await $('#scratchpad')
      // @ts-ignore
      .transition(
        { opacity: 0 },
        200,
        'easeOutCubic',
      )
      .promise();
  }

  async function loadReact() {
    if (reactLoaded) return;
    $('.loader-container').show();

    const { default: WebSocket } = await import('../components/socket');
    const { default: ScratchpadApp } = await import('../components/scratchpad');
    const { default: ScratchpadReducer } = await import('../components/scratchpad/reducers');
    const { Provider, store } = await loadReactRedux(ScratchpadReducer);
    let cacheKey = `${UserContext._id}/${UiContext.pdoc.domainId}/${UiContext.pdoc.docId}`;
    if (UiContext.tdoc?._id) cacheKey += `@${UiContext.tdoc._id}`;
    if (UiContext.monitoredExam) cacheKey += `@monitored:${UiContext.monitoredAttempt}`;
    let draft;
    // The server-rendered basic editor and the standard scratchpad share a draft.
    // Never hydrate an old, non-monitored draft into a monitored test.
    if (UiContext.monitoredExam) {
      try {
        draft = JSON.parse(localStorage.getItem(`hydro-monitor-draft:${cacheKey}`) || 'null');
      } catch { /* disabled local storage */ }
    }
    if (!draft) {
      try { draft = await (await openDB).get('scratchpad-drafts', cacheKey); } catch { /* IDB unsupported */ }
    }
    if (draft) {
      store.dispatch({
        type: 'SCRATCHPAD_EDITOR_HYDRATE',
        payload: {
          code: draft.code ?? (UiContext.monitoredExam ? '' : UiContext.codeTemplate),
          lang: draft.lang ?? UiContext.codeLang,
        },
      });
    }

    let previousEditorState = store.getState().editor;
    let write: Promise<any> = Promise.resolve();
    const saveDraft = _.debounce((code: string, lang: string) => {
      write = write
        .then(() => openDB.then((db) => db.put('scratchpad-drafts', { id: cacheKey, code, lang })))
        .catch(() => { });
    }, 400);
    if (UiContext.monitoredExam) monitoredDraft = createMonitoredDraftBridge(store, cacheKey);
    store.subscribe(() => {
      const editor = store.getState().editor;
      if (editor === previousEditorState) return;
      previousEditorState = editor;
      monitoredDraft?.update();
      saveDraft(editor.code, editor.lang);
    });

    // @ts-ignore
    window.store = store;
    document.dispatchEvent(new Event('hydro:scratchpad-store-ready'));
    const sock = new WebSocket(UiContext.ws_prefix + UiContext.pretestConnUrl);
    sock.onmessage = (message) => {
      const msg = JSON.parse(message.data);
      store.dispatch({
        type: UiContext.practiceConnUrl ? 'SCRATCHPAD_PRETEST_RECORD_PUSH' : 'SCRATCHPAD_RECORDS_PUSH',
        payload: msg,
      });
    };
    if (UiContext.practiceConnUrl) {
      const practiceSock = new WebSocket(UiContext.ws_prefix + UiContext.practiceConnUrl);
      let reload = 0;
      let updates: Map<string, any> = null;
      practiceSock.onmessage = (message) => {
        const msg = JSON.parse(message.data);
        if (!msg.rdoc) return;
        updates?.set(msg.rdoc._id, msg.rdoc);
        store.dispatch({ type: 'SCRATCHPAD_RECORDS_PUSH', payload: msg });
      };
      practiceSock.onopen = () => {
        const currentReload = ++reload;
        updates = new Map();
        Promise.resolve(store.dispatch({
          type: 'SCRATCHPAD_RECORDS_LOAD_SUBMISSIONS',
          payload: request.get(UiContext.getSubmissionsUrl).then((response) => {
            if (currentReload !== reload) {
              const { rows, items } = store.getState().records;
              return { rdocs: rows.map((rid) => items[rid]) };
            }
            return { ...response, rdocs: _.uniqBy([...updates.values(), ...response.rdocs], '_id') };
          }),
        })).finally(() => {
          if (currentReload === reload) updates = null;
        }).catch(() => {});
      };
    }

    renderReact = () => {
      const root = createRoot($('#scratchpad').get(0));
      root.render(
        <Provider store={store}>
          {UiContext.monitoredExam
            ? <MonitoredEditorBoundary><ScratchpadApp /></MonitoredEditorBoundary>
            : <ScratchpadApp />}
        </Provider>,
      );
      unmountReact = () => root.unmount();
    };
    reactLoaded = true;
    $('.loader-container').hide();
  }

  let progress = false;

  async function enterScratchpadMode() {
    if (progress) return;
    progress = true;
    const basic = UiContext.monitoredExam ? document.getElementById('monitored-basic-editor') : null;
    let readiness: ReturnType<typeof waitForMonitoredEditorReady> | null = null;
    try {
      await extender.extend();
      await loadReact();
      // In monitored mode the independent HTML editor must remain available
      // until Monaco (or the React textarea fallback) has actually mounted.
      if (UiContext.monitoredExam) readiness = waitForMonitoredEditorReady();
      renderReact();
      if (readiness) await readiness.promise;
      monitoredDraft?.activate();
      if (basic) basic.style.display = 'none';
      await scratchpadFadeIn();
    } catch (error) {
      if (!UiContext.monitoredExam) throw error;
      console.warn('Advanced editor failed; restoring independent basic editor.', error);
      monitoredDraft?.restore();
      $('.problem-content-container').append($('.problem-content'));
      try {
        if (unmountReact) unmountReact();
      } catch (e) { console.warn('Editor cleanup failed.', e); }
      unmountReact = null;
      if (extender.isExtended) {
        try {
          await extender.collapse();
        } catch (e) { console.warn('Editor layout cleanup failed.', e); }
      }
      // A failed transition can leave the expanded CSS active without setting isExtended.
      $('body').removeClass('header--collapsed mode--scratchpad');
      $('.main > .row').show();
      $('.footer').show();
      $('.scratchpad-container').hide();
      window.document.body.style.overflow = '';
      if (basic) {
        basic.style.display = 'block';
        basic.querySelector<HTMLTextAreaElement>('textarea[name="code"]')?.focus();
      }
      Notification.error('高级编辑器无法使用，已切换为基础编辑模式。');
    } finally {
      readiness?.cancel();
      progress = false;
    }
  }

  async function leaveScratchpadMode() {
    if (progress || !extender.isExtended) return;
    progress = true;
    try {
      monitoredDraft?.restore();
      await scratchpadFadeOut();
      $('.problem-content-container').append($('.problem-content'));
      await extender.collapse();
      unmountReact?.();
      unmountReact = null;
    } finally {
      const basic = UiContext.monitoredExam ? document.getElementById('monitored-basic-editor') : null;
      if (basic) {
        basic.style.display = 'block';
        basic.querySelector<HTMLTextAreaElement>('textarea[name="code"]')?.focus();
      }
      progress = false;
    }
  }

  async function loadObjective() {
    $('.outer-loader-container').show();
    const ans = {};
    const pids = [];
    let cnt = 0;
    const reg = /\{\{ (input|select|multiselect|textarea|dropdown)\(\d+(-\d+)?\)(?:\[([^\]]*)\])? \}\}/g;
    $('.problem-content .typo').children().each((i, e) => {
      if (e.tagName === 'PRE' && !e.children[0].className.includes('#input')) return;
      const questions = [];
      let q;
      while (q = reg.exec(e.textContent)) questions.push(q); // eslint-disable-line no-cond-assign
      for (const [info, type, , options] of questions) {
        cnt++;
        const id = info.replace(/\{\{ (input|select|multiselect|textarea|dropdown)\((\d+(-\d+)?)\)(?:\[([^\]]*)\])? \}\}/, '$2');
        pids.push(id);
        if (type === 'input') {
          $(e).html($(e).html().replace(info, tpl`
            <div class="objective_${id} medium-3" id="p${id}" style="display: inline-block;">
              <input type="text" name="${id}" class="textbox objective-input">
            </div>
          `));
        } else if (type === 'textarea') {
          $(e).html($(e).html().replace(info, tpl`
            <div class="objective_${id} medium-6" id="p${id}">
              <textarea name="${id}" class="textbox objective-input"></textarea>
            </div>
          `));
        } else if (type === 'dropdown') {
          const opts = (options || '').split(',').map((s) => s.trim()).filter(Boolean);
          $(e).html($(e).html().replace(info, tpl`
            <div class="objective_${id} medium-3 select-container" id="p${id}" style="display: inline-block;">
              <select name="${id}" class="objective-input select">
                <option value=""></option>
                ${{ templateRaw: true, html: opts.map((o) => tpl`<option value="${o}">${o}</option>`).join('') }}
              </select>
            </div>
          `));
        } else {
          if ($(e).next()[0]?.tagName !== 'UL') {
            cnt--;
            return;
          }
          $(e).html($(e).html().replace(info, ''));
          $(e).next('ul').children().each((j, ele) => {
            $(ele).after(tpl`
              <label class="objective_${id} radiobox" id="p${id}">
                <input type="${type === 'select' ? 'radio' : 'checkbox'}" name="${id}" class="objective-input" value="${String.fromCharCode(65 + j)}">
                ${String.fromCharCode(65 + j)}. ${{ templateRaw: true, html: ele.innerHTML }}
              </label>
            `);
            $(ele).remove();
          });
        }
      }
    });

    let cacheKey = `${UserContext._id}/${UiContext.pdoc.domainId}/${UiContext.pdoc.docId}`;
    if (UiContext.tdoc?._id && UiContext.tdoc.rule !== 'homework') cacheKey += `@${UiContext.tdoc._id}`;

    let setUpdate;
    const db = await openDB;
    async function saveAns() {
      await db.put('solutions', {
        id: `${cacheKey}#objective`,
        value: JSON.stringify(ans),
      });
    }
    async function clearAns() {
      if (!(await confirm(i18n('All changes will be lost. Are you sure to clear all answers?')))) return;
      await db.delete('solutions', `${cacheKey}#objective`);
      window.location.reload();
    }

    function ProblemNavigation() {
      [, setUpdate] = React.useState(0);
      const update = React.useCallback(() => { setUpdate?.((v) => v + 1); }, []);
      React.useEffect(() => {
        $(document).on('click', update);
        $(document).on('input', update);
        return () => {
          $(document).off('click', update);
          $(document).off('input', update);
        };
      }, [update]);
      return <>
        <div className="contest-problems" style={{ margin: '1em' }}>
          {pids.map((i) => <a href={`#p${i}`} key={i} className={ans[i] ? 'pending ' : ''}>
            <span className="id">{i}</span>
          </a>)}
        </div>
        <li className="menu__item">
          <button className="menu__link" onClick={clearAns}>
            <span className="icon icon-erase" /> {i18n('Clear answers')}
          </button>
        </li>
      </>;
    }

    async function loadAns() {
      const saved = await db.get('solutions', `${cacheKey}#objective`);
      if (typeof saved?.value !== 'string') return;
      const isValidOption = (v) => v.length === 1 && v.charCodeAt(0) >= 65 && v.charCodeAt(0) <= 90;
      Object.assign(ans, JSON.parse(saved?.value || '{}'));
      for (const [id, val] of Object.entries(ans)) {
        if (Array.isArray(val)) {
          for (const v of val) {
            if (isValidOption(v)) $(`.objective_${id} input[value="${v}"]`).prop('checked', true);
          }
        } else if (val) {
          $(`.objective_${id} input[type=text], .objective_${id} textarea, .objective_${id} select`).val(val.toString());
          if (isValidOption(val)) $(`.objective_${id}.radiobox [value="${val}"]`).prop('checked', true);
        }
      }
      setUpdate?.((v) => v + 1);
    }

    if (cnt) {
      await loadAns();
      $('.problem-content .typo').append(document.getElementsByClassName('nav__item--round').length
        ? `<input type="submit" disabled class="button rounded primary disabled" value="${i18n('Login to Submit')}" />`
        : `<input type="submit" class="button rounded primary" value="${i18n('Submit')}" />`);
      $('.objective-input[type!=checkbox]').on('input', (e: JQuery.TriggeredEvent<HTMLInputElement>) => {
        ans[e.target.name] = e.target.value;
        saveAns();
      });
      $('input.objective-input[type=checkbox]').on('input', (e: JQuery.TriggeredEvent<HTMLInputElement>) => {
        if (e.target.checked) {
          ans[e.target.name] ||= [];
          ans[e.target.name].push(e.target.value);
          ans[e.target.name] = [...new Set(ans[e.target.name])].sort((a: string, b: string) => a.charCodeAt(0) - b.charCodeAt(0));
        } else {
          ans[e.target.name] = ans[e.target.name].filter((v) => v !== e.target.value);
        }
        saveAns();
      });
      $('input[type="submit"]').on('click', (e) => {
        e.preventDefault();
        request
          .post(UiContext.postSubmitUrl, {
            lang: '_',
            code: yaml.dump(ans),
          })
          .then((res) => {
            window.location.href = res.url;
          })
          .catch((err) => {
            Notification.error(err.message);
          });
      });
    }
    if (!document.getElementById('problem-navigation')) {
      const ele = document.createElement('div');
      ele.id = 'problem-navigation';
      $('.section--problem-sidebar ol.menu').prepend(ele);
      createRoot(document.getElementById('problem-navigation')).render(<ProblemNavigation />);
    }
    $('.non-scratchpad--hide').hide();
    $('.scratchpad--hide').hide();
    $('.outer-loader-container').hide();
  }

  $(document).on('click', '[name="problem-sidebar__open-scratchpad"]', (ev) => {
    enterScratchpadMode();
    ev.preventDefault();
  });
  $(document).on('click', '[name="problem-sidebar__quit-scratchpad"]', (ev) => {
    leaveScratchpadMode();
    ev.preventDefault();
  });

  $(document).on('click', '[data-lang]', (ev) => {
    ev.preventDefault();
    const url = new URL(window.location.href);
    url.searchParams.set('lang', ev.currentTarget.dataset.lang);
    $('[data-lang]').removeClass('tab--active');
    pjax.request({ url: url.toString() });
    $(ev.currentTarget).addClass('tab--active');
  });
  $(document).on('click', '[name="show_tags"]', (ev) => {
    $(ev.currentTarget).hide();
    $('span.tags').css('display', 'inline-block');
  });
  $('[name="problem-sidebar__download"]').on('click', handleClickDownloadProblem);
  if (UiContext.monitoredExam && typeof URLSearchParams !== 'undefined'
    && new URLSearchParams(window.location.search).get('editor') === 'online') {
    enterScratchpadMode();
  }
  if (UiContext.pdoc.config?.type === 'objective') {
    loadObjective();
    $(document).on('vjContentNew', loadObjective);
  }
});

export default page;
