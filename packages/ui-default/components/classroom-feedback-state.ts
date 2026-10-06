export interface FeedbackDraft {
  note: string;
  detail: string;
}
export interface FeedbackOperation {
  url: string;
  body: Record<string, any>;
  label: string;
  draftKey?: string;
  undo?: { eventId: string, action: string, version: number, resolutionId?: string };
}

// Page memory only. PJAX may replace a row, but must not replace an operation.
export function createFeedbackState() {
  let revision = 0;
  const listeners = new Set<() => void>();
  const state = {
    operatorUid: 0,
    drafts: new Map<string, FeedbackDraft>(),
    lessonSelections: new Map<string, string>(),
    pending: null as FeedbackOperation | null,
    busy: false,
    notice: '',
    tone: 'idle',
    undo: null as FeedbackOperation['undo'] | null,
    confirmed: 0,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => revision,
    notify() {
      revision++;
      listeners.forEach((listener) => listener());
    },
    draft(key: string) {
      return state.drafts.get(key) || { note: '', detail: '' };
    },
    edit(key: string, draft: FeedbackDraft) {
      state.drafts.set(key, draft);
      state.notify();
    },
    hasUnsaved() {
      return !!state.pending || [...state.drafts.values()].some((draft) => draft.note || draft.detail);
    },
    async send(operation: FeedbackOperation, fetcher = fetch, draftKey?: string) {
      if (state.busy || (state.pending && state.pending !== operation)) return;
      const retrying = !!state.pending;
      // Fix both the identifier and body before the first request.
      if (!retrying) operation = { ...operation, draftKey, body: JSON.parse(JSON.stringify(operation.body)) };
      state.pending = operation;
      state.busy = true;
      state.notice = '正在保存…';
      state.tone = 'saving';
      state.notify();
      try {
        const response = await fetcher(operation.url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(operation.body),
        });
        const receipt = await response.json();
        if ([400, 403, 409].includes(response.status) && !response.redirected) {
          // A denied replay after loss of permission cannot prove whether the
          // first request committed. Retain that exact operation for recovery.
          const unknown = retrying && response.status === 403;
          if (!unknown) state.pending = null;
          state.tone = unknown ? 'unknown' : 'error';
          state.notice = unknown
            ? '原操作状态仍待确认，请恢复授课权限后重试。'
            : receipt.error?.message || '操作被拒绝，请检查输入及授课权限。';
          return;
        }
        if (!response.ok || response.redirected || !receipt.eventId || !receipt.recordedAt) throw new Error('Unconfirmed');
        state.pending = null;
        state.tone = 'success';
        state.notice = operation.label;
        state.undo = operation.undo
          ? {
            ...operation.undo,
            eventId: operation.undo.eventId || receipt.eventId,
            resolutionId: operation.undo.action === 'undo-resolve' ? receipt.eventId : operation.undo.resolutionId,
          }
          : null;
        if (operation.draftKey) state.drafts.delete(operation.draftKey);
        state.confirmed++;
      } catch {
        state.tone = 'unknown';
        state.notice = '保存状态待确认。请用“重试本次操作”核实原操作。';
      } finally {
        state.busy = false;
        state.notify();
      }
    },
  };
  return state;
}

const states = new Map<string, ReturnType<typeof createFeedbackState>>();
export function feedbackState(endpoint: string) {
  if (!states.has(endpoint)) states.set(endpoint, createFeedbackState());
  return states.get(endpoint)!;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (![...states.values()].some((state) => state.hasUnsaved())) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
