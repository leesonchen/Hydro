import _ from 'lodash';
import { messageDialogueId } from '../helpers';

export default function reducer(state = {}, action = {}) {
  switch (action.type) {
    case 'DIALOGUES_LOAD_DIALOGUES_FULFILLED': {
      const dialogues = [...Object.values(action.payload.messages || {}), ...action.payload.feedbackThreads || []];
      return { ..._.fromPairs(dialogues.map((d) => [d._id, ''])), ...state };
    }
    case 'DIALOGUES_CREATE': {
      const { user } = action.payload;
      return {
        ...state,
        [user._id]: '',
      };
    }
    case 'DIALOGUES_INPUT_CHANGED': {
      const id = action.meta.dialogueId;
      return {
        ...state,
        [id]: action.payload,
      };
    }
    case 'DIALOGUES_POST_SEND_FULFILLED': {
      const id = action.meta.dialogueId;
      return {
        ...state,
        [id]: '',
      };
    }
    case 'DIALOGUES_MESSAGE_PUSH': {
      const id = messageDialogueId(action.payload.mdoc, UserContext._id);
      if (!(id in state)) {
        return {
          ...state,
          [id]: '',
        };
      }
      return state;
    }
    default:
      return state;
  }
}
