import type * as monaco from 'monaco-editor';
import React from 'react';
import { connect } from 'react-redux';
import { isMonacoUnsupportedError, load } from 'vj/components/monaco/loader';
import { ctx } from 'vj/context';

interface ScratchpadOptions {
  value?: string;
  language?: string;
  handleUpdateCode?: (str: string, event: monaco.editor.IModelContentChangedEvent) => void;
  settings?: any;
  pendingCommand?: string;
  commandDone?: () => void;
}

export default connect((state: any) => ({
  value: state.editor.code,
  language: window.LANGS[state.editor.lang]?.monaco,
  settings: state.ui.settings.config,
  pendingCommand: state.ui.pendingCommand,
}), (dispatch) => ({
  handleUpdateCode: (code: string) => {
    dispatch({
      type: 'SCRATCHPAD_EDITOR_UPDATE_CODE',
      payload: code,
    });
  },
  commandDone: () => {
    dispatch({
      type: 'SCRATCHPAD_TRIGGER_EDITOR_COMMAND',
      payload: { command: '' },
    });
  },
}))(class MonacoEditor extends React.PureComponent<ScratchpadOptions> {
  disposable: monaco.IDisposable[] = [];
  __prevent_trigger_change_event = false;
  model: monaco.editor.ITextModel;
  editor: monaco.editor.IStandaloneCodeEditor;
  containerElement: HTMLElement;
  plainTextarea: HTMLTextAreaElement;
  plainTextareaInputHandler: () => void;
  usingPlainTextarea = false;
  monacoTimer: ReturnType<typeof setTimeout>;
  unmounted = false;

  notifyEditorReady() {
    if (UiContext.monitoredExam && !this.unmounted) {
      document.dispatchEvent(new Event('hydro:monitored-editor-ready'));
    }
  }

  modelUri(language: string, monacoModule: typeof import('monaco-editor')) {
    const prefix = UiContext.monitoredExam
      ? `test/${UiContext.tdoc._id}/${UiContext.monitoredAttempt}/`
      : '';
    return monacoModule.Uri.parse(`hydro:${prefix}${UiContext.pdoc.pid || UiContext.pdoc.docId}.${language}`);
  }

  initPlainTextarea(value: string) {
    if (!this.containerElement) return;
    this.usingPlainTextarea = true;
    this.containerElement.innerHTML = '';
    const textarea = document.createElement('textarea');
    textarea.className = 'textbox ScratchpadPlainEditor';
    textarea.value = value;
    textarea.spellcheck = false;
    textarea.style.width = '100%';
    textarea.style.height = '100%';
    textarea.style.resize = 'none';
    textarea.style.boxSizing = 'border-box';
    textarea.style.fontFamily = UserContext.codeFontFamily;
    textarea.style.fontSize = '14px';
    textarea.style.tabSize = '4';
    textarea.placeholder = '基础编辑模式：请在这里编写代码';
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      if (event.shiftKey) {
        const begin = textarea.value.lastIndexOf('\n', start - 1) + 1;
        const count = (textarea.value.slice(begin, start).match(/^ {0,4}/) || [''])[0].length;
        if (typeof textarea.setRangeText === 'function') textarea.setRangeText('', begin, begin + count, 'start');
        else {
          textarea.value = textarea.value.slice(0, begin) + textarea.value.slice(begin + count);
          textarea.selectionStart = textarea.selectionEnd = Math.max(begin, start - count);
        }
      } else if (typeof textarea.setRangeText === 'function') {
        textarea.setRangeText('    ', start, end, 'end');
      } else {
        textarea.value = textarea.value.slice(0, start) + '    ' + textarea.value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = start + 4;
      }
      this.props.handleUpdateCode?.(textarea.value, undefined as any);
    });
    this.plainTextareaInputHandler = () => {
      this.props.handleUpdateCode?.(textarea.value, undefined as any);
    };
    textarea.addEventListener('input', this.plainTextareaInputHandler);
    this.plainTextarea = textarea;
    this.containerElement.appendChild(textarea);
    ctx.scratchpad.loadCallback?.();
    this.notifyEditorReady();
  }

  async componentDidMount() {
    const value = this.props.value || '';
    const { language } = this.props;
    try {
      // On monitored tests, failure of Monaco's asset requests is not a reason
      // to lose the code editor. The native textarea has no Monaco dependency.
      const loadedMonaco = UiContext.monitoredExam
        ? await Promise.race([
          load([language]),
          new Promise<never>((_, reject) => {
            this.monacoTimer = setTimeout(() => reject(new Error('Monaco loading timed out')), 12000);
          }),
        ])
        : await load([language]);
      if (this.unmounted) return;
      const { monaco, registerAction, customOptions } = loadedMonaco;
      const uri = this.modelUri(language, monaco);
      this.model = monaco.editor.getModel(uri) || monaco.editor.createModel(value, language, uri);
      if (this.containerElement) {
        const config: monaco.editor.IStandaloneEditorConstructionOptions = {
          theme: 'vs-light',
          fontFamily: UserContext.codeFontFamily,
          ...customOptions,
          lineNumbers: 'on',
          glyphMargin: true,
          lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.On },
          model: this.model,
          fontLigatures: '',
        };
        this.editor = monaco.editor.create(this.containerElement, config);
        registerAction(this.editor, this.model);
        this.disposable.push(
          this.editor.onDidChangeModelContent((event) => {
            if (!this.__prevent_trigger_change_event) {
              this.props.handleUpdateCode?.(this.editor.getValue({ lineEnding: '\n', preserveBOM: false }), event);
            }
          }),
        );
        (window as any).editor = this.editor;
        (window as any).monaco = monaco;
        ctx.scratchpad.init(this.editor, monaco);
        this.notifyEditorReady();
      }
    } catch (e) {
      if (!UiContext.monitoredExam && !isMonacoUnsupportedError(e)) throw e;
      console.warn('Monaco unavailable; switching to basic editing.', e);
      if (this.editor) this.editor.dispose();
      if (this.model) this.model.dispose();
      this.editor = undefined;
      this.model = undefined;
      if (!this.unmounted) {
        try {
          this.initPlainTextarea(this.props.value ?? value);
        } catch (fallbackError) {
          console.error('Basic editor fallback could not be mounted.', fallbackError);
          document.dispatchEvent(new Event('hydro:monitored-editor-failed'));
        }
      }
    } finally {
      if (this.monacoTimer) clearTimeout(this.monacoTimer);
    }
  }

  async componentDidUpdate(prevProps) {
    const {
      value, language,
    } = this.props;
    if (this.usingPlainTextarea) {
      if (this.plainTextarea && value != null && value !== this.plainTextarea.value) {
        this.plainTextarea.value = value;
      }
      if (this.props.pendingCommand) this.props.commandDone();
      return;
    }
    // Wait for the editor to mount before handling language changes.
    if (UiContext.monitoredExam && (!this.editor || !this.model)) return;
    const { monaco } = await load([language]);
    const { editor, model } = this;
    const { LF } = monaco.editor.EndOfLinePreference;
    if (model && editor && this.props.value != null && this.props.value !== model.getValue(LF, false)) {
      this.__prevent_trigger_change_event = true;
      editor.pushUndoStop();
      model.pushEditOperations(
        [],
        [
          {
            range: model.getFullModelRange(),
            text: value!,
          },
        ],
        () => null,
      );
      editor.pushUndoStop();
      this.__prevent_trigger_change_event = false;
    }
    if (model && editor && prevProps.language !== language) {
      const val = model.getValue(LF, false);
      model.dispose();
      const uri = this.modelUri(language, monaco);
      this.model = monaco.editor.getModel(uri) || monaco.editor.createModel(val, language, uri);
      editor.setModel(this.model);
    }
    if (editor && this.props.settings) {
      editor.updateOptions(this.props.settings);
    }
    if (this.props.pendingCommand) {
      editor.focus();
      editor.getAction(this.props.pendingCommand)?.run();
      this.props.commandDone();
    }
  }

  componentWillUnmount() {
    this.unmounted = true;
    if (this.monacoTimer) clearTimeout(this.monacoTimer);
    if (this.plainTextarea && this.plainTextareaInputHandler) {
      this.plainTextarea.removeEventListener('input', this.plainTextareaInputHandler);
    }
    if ((window as any).editor === this.editor) delete (window as any).editor;
    if (this.editor) this.editor.dispose();
    if (this.model) this.model.dispose();
    this.disposable.map((i) => i.dispose());
  }

  assignRef = (component) => {
    this.containerElement = component;
  };

  render() {
    const editor = (
      <div
        ref={this.assignRef}
        style={UiContext.monitoredExam
          ? { flex: 1, minHeight: 0, height: 'auto', width: '100%' }
          : { height: '100%', width: '100%' }}
        className="ScratchpadMonacoEditor"
      >
        <div className="loader-container"><div className="loader"></div></div>
      </div>
    );
    if (!UiContext.monitoredExam) return editor;
    const basicUrl = new URL(window.location.href);
    basicUrl.searchParams.set('editor', 'basic');
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
        <div style={{ textAlign: 'right', padding: '4px 10px', fontSize: 12 }}>
          <a href={basicUrl.toString()} data-no-instant={"true"}>编辑器无法使用？切换基础编辑模式</a>
        </div>
        {editor}
      </div>
    );
  }
});
