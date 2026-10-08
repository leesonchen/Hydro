import _ from 'lodash';
import { mergeMessages, messageDialogueId } from '../helpers';

export default function reducer(state = {}, action = {}) {
  switch (action.type) {
    case 'DIALOGUES_LOAD_DIALOGUES_FULFILLED': {
      const { messages, feedbackThreads = [] } = action.payload;
      // Reconcile the request's snapshot, preserving feedback pushed while it was loading.
      const feedbackIds = new Set(action.meta?.feedbackIds ?? Object.keys(state));
      const next = _.omitBy(state, (dialogue, id) => dialogue.kind === 'feedback' && feedbackIds.has(id));
      for (const item of [...Object.values(messages || {}), ...feedbackThreads]) {
        next[item._id] = {
          ...state[item._id], ...item,
          authors: { ...state[item._id]?.authors, ...item.authors },
          messages: mergeMessages(state[item._id]?.messages, item.messages),
        };
      }
      return next;
    }
    case 'DIALOGUES_CREATE': {
      const { user } = action.payload;
      if (state[user._id]) return state;
      return {
        ...state,
        [user._id]: {
          _id: user._id,
          udoc: { ...user },
          messages: [],
        },
      };
    }
    case 'DIALOGUES_POST_SEND_FULFILLED': {
      const id = action.meta.dialogueId;
      const { mdoc } = action.payload;
      return {
        ...state,
        [id]: {
          ...state[id],
          messages: mergeMessages(state[id]?.messages, [mdoc]),
        },
      };
    }
    case 'DIALOGUES_MESSAGE_PUSH': {
      const { mdoc, udoc, feedbackThread } = action.payload;
      const to = messageDialogueId(mdoc, UserContext._id);
      if (mdoc.feedbackId && !feedbackThread && !state[to]) return state;
      return {
        ...state,
        [to]: {
          ...state[to],
          ...feedbackThread,
          udoc: feedbackThread?.udoc || (mdoc.feedbackId ? state[to]?.udoc : udoc),
          _id: to,
          ...(mdoc.feedbackId ? { authors: { ...state[to]?.authors, ...feedbackThread?.authors, [udoc._id]: udoc } } : {}),
          messages: mergeMessages(state[to]?.messages, feedbackThread?.messages, [mdoc]),
        },
      };
    }
    default:
      return state;
  }
}
