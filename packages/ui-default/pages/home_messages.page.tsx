import $ from 'jquery';
import React from 'react';
import { createRoot } from 'react-dom/client';
import VjNotification from 'vj/components/notification';
import selectUser from 'vj/components/selectUser';
import { ctx, Service } from 'vj/context';
import { NamedPage } from 'vj/misc/Page';
import { api, loadReactRedux, request } from 'vj/utils';
import { activateDialogue, messageDialogueId } from '../components/messagepad/helpers';

class MessagePadService extends Service {
  WebSocket: typeof import('../components/socket').default;
  store: any;

  constructor(c, s) {
    super(c, 'messagepad');
    this.WebSocket = s.WebSocket;
    this.store = s.store;
  }
}

declare module 'cordis' {
  interface Context {
    messagepad: MessagePadService;
  }
}

const page = new NamedPage('home_messages', () => {
  let reduxStore;

  function createDialog(user) {
    reduxStore.dispatch({
      type: 'DIALOGUES_CREATE',
      payload: {
        user,
      },
    });
    reduxStore.dispatch({
      type: 'DIALOGUES_SWITCH_TO',
      payload: user._id,
    });
  }

  async function mountComponent() {
    const { default: WebSocket } = await import('../components/socket');
    const { default: MessagePadApp } = await import('../components/messagepad');
    const { default: MessagePadReducer } = await import('../components/messagepad/reducers');
    const { Provider, store } = await loadReactRedux(MessagePadReducer);

    reduxStore = store;
    (window as any).store = reduxStore;
    ctx.plugin(MessagePadService, { store, WebSocket });

    const selected = new URL(window.location.href).searchParams.get('feedback');
    const initial = await request.get(window.location.pathname, { _: Date.now(), ...(selected ? { feedback: selected } : {}) });
    store.dispatch({ type: 'DIALOGUES_LOAD_DIALOGUES_FULFILLED', payload: initial });
    if (selected) store.dispatch({ type: 'DIALOGUES_SWITCH_TO', payload: `feedback:${selected}` });

    const sock = new WebSocket(`${UiContext.ws_prefix}websocket`);
    sock.onopen = () => {
      sock.send(JSON.stringify({
        operation: 'subscribe',
        request_id: Math.random().toString(16).substring(2),
        channels: ['message'],
      }));
    };
    sock.onmessage = (message) => {
      const msg = JSON.parse(message.data);
      if (msg.operation !== 'event') return;
      store.dispatch({
        type: 'DIALOGUES_MESSAGE_PUSH',
        payload: msg.payload,
      });
      const udoc = msg.payload.udoc;
      const notification = new VjNotification({
        title: udoc.uname,
        avatar: udoc.avatarUrl,
        message: msg.payload.mdoc.content,
        duration: 15000,
        action: () => {
          activateDialogue(store.dispatch, messageDialogueId(msg.payload.mdoc, UserContext._id));
          notification.hide();
        },
      });
      notification.show();
    };

    createRoot($('#messagePad').get(0)).render(
      <Provider store={store}>
        <MessagePadApp
          onAdd={async () => {
            if (!(store.getState() as any).canSendMessage) return;
            const user = await selectUser();
            if (user) createDialog(user);
          }}
        />
      </Provider>,
    );
  }

  /**
   * A target user id may be assigned in the query string.
   */
  async function loadSendTarget() {
    const target = new URL(window.location.href).searchParams.get('target');
    if (!target) return;
    const { dialogues, canSendMessage } = reduxStore.getState();
    if (Object.hasOwn(dialogues, target) && dialogues[target].kind !== 'feedback') {
      reduxStore.dispatch({ type: 'DIALOGUES_SWITCH_TO', payload: dialogues[target]._id });
      return;
    }
    if (!canSendMessage) return;
    const user = await api(
      'users', { search: target, exact: true },
      ['_id', 'uname', 'avatarUrl', 'mail'],
    );
    if (!user?.length) return;
    createDialog(user[0]);
  }

  async function init() {
    await mountComponent();
    await loadSendTarget();
  }

  init().catch((error) => VjNotification.error(error.message));
});

export default page;
