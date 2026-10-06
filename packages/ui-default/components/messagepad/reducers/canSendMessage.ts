export default function reducer(state = false, action: any = {}) {
  if (action.type === 'DIALOGUES_LOAD_DIALOGUES_FULFILLED') return !!action.payload.canSendMessage;
  return state;
}
