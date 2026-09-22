import $ from 'jquery';
import { debounce } from 'lodash';
import { nanoid } from 'nanoid';
import React from 'react';
import ReactDOM from 'react-dom/client';
import DOMAttachedObject from 'vj/components/DOMAttachedObject';
import { isMonacoUnsupportedError } from 'vj/components/monaco/loader';
import { getTheme, i18n } from 'vj/utils';
import uploadFiles from '../upload';
import { AsyncPreview, editorPreviews } from './async-preview';

interface MonacoOptions {
  language?: string;
  onChange?: (val: string) => any;
  theme?: string;
  model?: string;
  autoResize?: boolean;
  autoLayout?: boolean;
  value?: string;
  hide?: string[];
  lineNumbers?: 'on' | 'off' | 'relative' | 'interval';
}
type Options = MonacoOptions;

export default class Editor extends DOMAttachedObject {
  static DOMAttachKey = 'vjEditorInstance';
  model: import('../monaco').default.editor.IModel;
  editor: import('../monaco').default.editor.IStandaloneCodeEditor;
  markdownEditor: any;
  valueCache?: string;
  setMarkdownEditorValue?: (v: string) => void;
  reactRoot?: ReactDOM.Root;
  isValid: boolean;

  constructor($dom, public options: Options = {}) {
    super($dom);
    if (UserContext.preferredEditorType === 'monaco') this.initMonacoWithFallback();
    else if (options.language && options.language !== 'markdown') this.initMonacoWithFallback();
    else this.initMarkdownEditor();
  }

  async initMonacoWithFallback() {
    try {
      await this.initMonaco();
    } catch (e) {
      if (!isMonacoUnsupportedError(e)) throw e;
      console.warn('Monaco editor failed to load in this browser, falling back to a compatible editor.', e);
      if ((this.options.language || 'markdown') === 'markdown') await this.initMarkdownEditor();
      else {
        this.$dom.show();
        this.valueCache = String(this.$dom.val() ?? '');
        this.isValid = true;
      }
    }
  }

  async initMonaco() {
    const { load } = await import('vj/components/monaco/loader');
    const {
      onChange, language = 'markdown',
      theme = `vs-${getTheme()}`,
      model = `file://model-${Math.random().toString(16)}`,
      autoResize = true, autoLayout = true,
      hide = [], lineNumbers = 'on',
    } = this.options;
    const { monaco, registerAction } = await load([language]);
    const { $dom } = this;
    const hasFocus = $dom.is(':focus') || $dom.hasClass('autofocus');
    const origin = $dom.get(0);
    const ele = document.createElement('div');
    $(ele).width('100%').addClass('textbox');
    if (!autoResize && $dom.height()) $(ele).height($dom.height());
    $dom.hide();
    origin.parentElement.appendChild(ele);
    const value = this.options.value || $dom.val();
    this.model = typeof model === 'string'
      ? monaco.editor.getModel(monaco.Uri.parse(model))
      || monaco.editor.createModel(value, language === 'auto' ? undefined : language, monaco.Uri.parse(model))
      : model;
    if (!this.options.model) this.model.setValue(value);
    const cfg: import('../monaco').default.editor.IStandaloneEditorConstructionOptions = {
      theme,
      lineNumbers,
      glyphMargin: true,
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.On },
      model: this.model,
      minimap: { enabled: false },
      hideCursorInOverviewRuler: true,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      fontFamily: UserContext.codeFontFamily,
      fontLigatures: '',
      unicodeHighlight: {
        ambiguousCharacters: language !== 'markdown',
      },
    };
    if (autoLayout) cfg.automaticLayout = true;
    let prevHeight = 0;
    const updateEditorHeight = () => {
      const editorElement = this.editor.getDomNode();
      if (!editorElement) return;
      const lineHeight = this.editor.getOption(monaco.editor.EditorOption.lineHeight);
      const lineCount = this.editor.getModel()?.getLineCount() || 1;
      let height = this.editor.getTopForLineNumber(lineCount + 1) + lineHeight;
      if (prevHeight !== height) {
        if (window.innerHeight * 1.5 < height) {
          height = window.innerHeight;
          this.editor.updateOptions({
            scrollbar: {
              vertical: 'auto',
              horizontal: 'auto',
              handleMouseWheel: true,
            },
          });
        } else {
          this.editor.updateOptions({
            scrollbar: {
              vertical: 'hidden',
              horizontal: 'hidden',
              handleMouseWheel: false,
            },
          });
        }
        prevHeight = height;
        editorElement.style.height = `${height}px`;
        this.editor.layout();
      }
    };
    if (autoResize) {
      cfg.wordWrap = 'bounded';
      cfg.scrollBeyondLastLine = false;
    }
    this.editor = monaco.editor.create(ele, cfg);
    if (hide.length) {
      const ranges = [];
      for (const text of hide) {
        const found = this.model.findMatches(text, true, false, true, '', true);
        ranges.push(...found.map((i) => i.range));
      }
      this.editor.deltaDecorations([], ranges.map((range) => ({ range, options: { inlineClassName: 'decoration-hide' } })));
    }
    registerAction(this.editor, this.model, this.$dom);
    if (autoResize) {
      this.editor.onDidChangeModelDecorations(() => {
        updateEditorHeight(); // typing
        requestAnimationFrame(updateEditorHeight); // folding
      });
    }
    this.editor.onDidChangeModelContent(() => {
      const val = this.editor.getValue({ lineEnding: '\n', preserveBOM: false });
      $dom.val(val);
      $dom.text(val);
      if (onChange) onChange(val);
    });
    this.isValid = true;
    if (hasFocus) this.focus();
    if (autoResize) updateEditorHeight();
    // @ts-ignore
    window.model = this.model;
    // @ts-ignore
    window.editor = this.editor;
  }

  async initMarkdownEditor() {
    const pagename = document.documentElement.getAttribute('data-page');
    const pageUploadConfig: Record<string, { endpoint: string, type?: string }> = {
      problem_edit: { endpoint: './files', type: 'additional_file' },
      homework_edit: { endpoint: './file' },
      contest_edit: { endpoint: './management', type: 'public' },
    };
    const uploadCfg = pageUploadConfig[pagename];
    const useFileProtocol = !!uploadCfg || ['problem_create', 'homework_create', 'contest_create'].includes(pagename);
    const that = this;
    const { $dom } = this;
    const hasFocus = $dom.is(':focus') || $dom.hasClass('autofocus');
    const origin = $dom.get(0);
    const ele = document.createElement('div');
    const value = $dom.val();
    const { onChange } = this.options;
    const { MdEditor } = await import('./mdeditor');
    const editorId = `hydro-markdown-${nanoid()}`;
    const lecture = origin.getAttribute('name') === 'lecture';
    const preview = new AsyncPreview(
      () => new Worker(new URL('./markdown.worker.ts', import.meta.url)),
      () => this.markdownEditor?.rerender(),
      {
        lecture,
        filePrefix: lecture ? '../file/' : ({
          problem_edit: './file/', homework_edit: './file/public/', contest_edit: './file/public/',
        }[pagename] || (useFileProtocol ? `/file/${UserContext._id}/` : undefined)),
        errorHtml: `<p role="status">${i18n('Preview could not be rendered. You can continue editing and saving.')}</p>`,
      },
    );
    editorPreviews.set(editorId, preview);

    const debouncedTrigger = debounce(() => {
      $(ele).find('.md-editor-preview').trigger('vjContentNew');
    }, 200, { trailing: true });
    const renderCallback = (ref) => {
      this.markdownEditor = ref;
      if (ref) debouncedTrigger();
    };

    const FastPreviewRenderer: React.FC<{ html: string, id: string, className: string }> = React.memo(
      ({ html, id, className }) => (
        <div
          id={id}
          className={className}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ),
    );

    function EditorComponent() {
      const [val, setVal] = React.useState(value);
      that.setMarkdownEditorValue = setVal;
      React.useEffect(() => () => {
        debouncedTrigger.cancel();
        preview.dispose();
        editorPreviews.delete(editorId);
      }, []);

      return <MdEditor
        id={editorId}
        className="textbox"
        autoFocus={hasFocus}
        codeTheme="github"
        codeStyleReverse={false}
        ref={renderCallback}
        value={val}
        previewComponent={FastPreviewRenderer}
        theme={getTheme()}
        language={UserContext.viewLang === 'zh' ? 'zh-CN' : UserContext.viewLang?.replace('_', '-')}
        noMermaid
        noPrettier
        noKatex
        noHighlight
        noEcharts
        scrollAuto={false}
        autoDetectCode
        toolbarsExclude={[
          // 'bold',
          // 'underline',
          // 'italic',
          // '-',
          // 'strikeThrough',
          // 'title',
          'sub',
          'sup',
          // 'quote',
          // 'unorderedList',
          // 'orderedList',
          // 'task',
          // '-',
          // 'codeRow',
          // 'code',
          // 'link',
          // 'image',
          // 'table',
          'mermaid',
          // 'katex',
          // '-',
          // 'revoke',
          // 'next',
          'save',
          // '=',
          'pageFullscreen',
          'fullscreen',
          // 'preview',
          'previewOnly',
          'htmlPreview',
          // 'catalog',
          'github',
        ]}
        onChange={(v) => {
          that.valueCache = v;
          $dom.val(v);
          onChange?.(v);
          // Update the controlled input immediately; debounce only the preview.
          setVal(v);
        }}
        onHtmlChanged={() => {
          debouncedTrigger();
        }}
        onUploadImg={async (files, callback) => {
          let ext: string;
          const matches = files[0].type.match(/^image\/(png|jpg|jpeg|gif)$/i);
          if (matches) {
            [, ext] = matches;
          } else if (files[0].type === 'application/x-zip-compressed') {
            ext = 'zip';
          }
          if (!ext) return i18n('No Supported file type.');
          const filename = `${nanoid()}.${ext}`;
          await uploadFiles(uploadCfg?.endpoint || '/file', [files[0]], {
            type: uploadCfg?.type,
            filenameCallback: () => filename,
          }).then(() => {
            callback([`${useFileProtocol ? 'file://' : `/file/${UserContext._id}/`}${filename}`]);
          }).catch(() => {
            callback([]);
          });
          return null;
        }}
      />;
    }

    this.valueCache = value;

    this.reactRoot = ReactDOM.createRoot(ele);
    this.reactRoot.render(<EditorComponent />);
    $dom.hide();
    origin.parentElement.appendChild(ele);
    this.isValid = true;
    if (hasFocus) this.focus();
  }

  destroy() {
    this.detach();
    if (this.reactRoot) this.reactRoot.unmount();
    else if (this.editor?.dispose) this.editor.dispose();
  }

  ensureValid() {
    if (!this.isValid) throw new Error('Editor is not loaded');
  }

  value(val?: string) {
    this.ensureValid();
    if (typeof val === 'string') {
      this.valueCache = val;
      this.$dom.val(val);
      this.$dom.text(val);
      if (this.editor) return this.editor.setValue(val);
      this.setMarkdownEditorValue?.(val);
      this.markdownEditor?.resetHistory?.();
    }
    if (this.editor) return this.editor.getValue({ lineEnding: '\n', preserveBOM: false });
    return this.valueCache ?? this.$dom.val();
  }

  focus() {
    this.ensureValid();
    if (!this.editor || !this.model) return;
    this.editor.focus();
    const range = this.model.getFullModelRange();
    this.editor.setPosition({ lineNumber: range.endLineNumber, column: range.endColumn });
  }
}
