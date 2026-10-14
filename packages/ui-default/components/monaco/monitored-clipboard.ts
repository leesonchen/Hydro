import type { editor as MonacoEditor, IDisposable } from 'monaco-editor';
import * as clipboardCommands from 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard';

// Monaco exports this command at runtime but ships an empty declaration file.
const { PasteAction } = clipboardCommands as {
  PasteAction?: { addImplementation(priority: number, name: string, handler: () => boolean): IDisposable };
};

export function registerMonitoredClipboard(editor: MonacoEditor.IStandaloneCodeEditor) {
  // Monaco's default command can read the OS clipboard without a DOM paste event.
  // Consume it before that fallback and let the monitor apply its native-paste policy.
  const guard = PasteAction?.addImplementation(11000, 'hydro-monitored-editor', () => {
    if (!editor.hasTextFocus()) return false;
    document.dispatchEvent(new CustomEvent('hydro:monitored-paste', { detail: { editor } }));
    return true;
  });
  if (guard) editor.onDidDispose(() => guard.dispose());
}
