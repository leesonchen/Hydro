import { combineReducers } from 'redux';
import activeId from './activeId';
import canSendMessage from './canSendMessage';
import dialogues from './dialogues';
import inputs from './inputs';
import isPosting from './isPosting';

const combinedReducer = combineReducers({
  activeId,
  canSendMessage,
  dialogues,
  inputs,
  isPosting,
  loadRequestId: (state: number | null = null, action: any = {}) => (
    action.type === 'DIALOGUES_LOAD_DIALOGUES_PENDING' ? action.meta?.requestId ?? null : state
  ),
});

export default function reducer(state: ReturnType<typeof combinedReducer>, action: any = {}) {
  // An older response must not restore conversations or privileges removed by a newer refresh.
  if (state && (action.type === 'DIALOGUES_LOAD_DIALOGUES_FULFILLED' || action.type === 'DIALOGUES_LOAD_DIALOGUES_REJECTED')
    && action.meta?.requestId !== undefined && action.meta.requestId !== state?.loadRequestId) return state;
  return combinedReducer(state, action);
}
