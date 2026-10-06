import _ from 'lodash';
import Notification from 'vj/components/notification';
import { messageDialogueId } from '../helpers';

export default function reducer(state = {}, action: any = {}) {
  switch (action.type) {
    case 'DIALOGUES_LOAD_DIALOGUES_FULFILLED': {
      const dialogues = [...Object.values(action.payload.messages || {}), ...action.payload.feedbackThreads || []];
      return { ..._.fromPairs(dialogues.map((d: any) => [d._id, false])), ...state };
    }
    case 'DIALOGUES_CREATE': {
      const { user } = action.payload;
      return {
        ...state,
        [user._id]: state[user._id] ?? false,
      };
    }
    case 'DIALOGUES_POST_SEND_PENDING': {
      const id = action.meta.dialogueId;
      return {
        ...state,
        [id]: true,
      };
    }
    case 'DIALOGUES_POST_SEND_REJECTED': {
      Notification.error(action.payload.message);
      const id = action.meta.dialogueId;
      return {
        ...state,
        [id]: false,
      };
    }
    case 'DIALOGUES_POST_SEND_FULFILLED': {
      const id = action.meta.dialogueId;
      return {
        ...state,
        [id]: false,
      };
    }
    case 'DIALOGUES_MESSAGE_PUSH': {
      const id = messageDialogueId(action.payload.mdoc, UserContext._id);
      return {
        ...state,
        [id]: state[id] || false,
      };
    }
    default:
      return state;
  }
}
