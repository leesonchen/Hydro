import Notification from 'vj/components/notification';
import { request } from 'vj/utils';

let nextLoadRequestId = 0;

export function messageDialogueId(message, uid: number) {
  if (message.feedbackId) return `feedback:${message.feedbackId}`;
  return message.from === uid ? (Array.isArray(message.to) ? message.to[0] : message.to) : message.from;
}

export function mergeMessages(...groups: any[][]) {
  const messages = new Map();
  for (const group of groups) {
    for (const message of group || []) messages.set(String(message._id), message);
  }
  return Array.from(messages.values()).sort((a, b) => String(a._id).localeCompare(String(b._id)));
}

export function activateDialogue(dispatch, id: number | string) {
  dispatch({ type: 'DIALOGUES_SWITCH_TO', payload: id });
  if (typeof id === 'string' && id.startsWith('feedback:')) {
    dispatch((dispatchLoad, getState) => {
      const { dialogues } = getState();
      const feedbackIds = Object.keys(dialogues).filter((key) => dialogues[key].kind === 'feedback');
      return dispatchLoad({
        type: 'DIALOGUES_LOAD_DIALOGUES',
        payload: request.get(window.location.pathname, { feedback: id.substring('feedback:'.length), _: Date.now() }),
        meta: { feedbackIds, requestId: ++nextLoadRequestId },
      });
    }).catch((error) => Notification.error(error.message));
  }
}
