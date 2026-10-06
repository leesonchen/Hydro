import 'jquery.easing';

import $ from 'jquery';
import moment from 'moment';
import React from 'react';
import { connect } from 'react-redux';
import TimeAgo from 'timeago-react';
import { i18n, mongoId } from 'vj/utils';
import Message from './MessageComponent';

const mapStateToProps = (state) => ({
  activeId: state.activeId,
  item: state.activeId !== null
    ? state.dialogues[state.activeId]
    : null,
});

export default connect(mapStateToProps)(class MessagePadDialogueContentContainer extends React.PureComponent {
  contentRef = React.createRef();

  componentDidUpdate(prevProps) {
    const node = this.contentRef.current;
    if (!node) return;

    if (this.props.activeId !== prevProps.activeId) {
      this.scrollToBottom = true;
      this.scrollWithAnimation = false;
    } else if (Math.abs(node.scrollTop + node.offsetHeight - node.scrollHeight) < 200) {
      this.scrollToBottom = true;
      this.scrollWithAnimation = true;
    } else this.scrollToBottom = false;

    if (this.scrollToBottom) {
      const targetScrollTop = node.scrollHeight - node.offsetHeight;
      if (this.scrollWithAnimation) {
        $(node).stop().animate({ scrollTop: targetScrollTop }, 200, 'easeOutCubic');
      } else {
        node.scrollTop = targetScrollTop;
      }
    }
  }

  renderContent(msg) {
    if (msg.feedbackId) return msg.content;
    // TODO: FLAG_RICHTEXT
    if (msg.from === 1) {
      // Is system message
      try {
        const data = JSON.parse(msg.content);
        const str = i18n(data.message).replace(/\{([^{}]+)\}/g, (match, key) => `%placeholder%${key}%placeholder%`);
        const arr = str.split('%placeholder%');
        data.params ||= {};
        for (let i = 1; i < arr.length; i += 2) {
          if (arr[i].endsWith(':link')) {
            const link = data.params[arr[i].split(':link')[0]];
            if (!link) continue;
            arr[i] = <a style={{ color: 'wheat' }} href={link} key={i} target="_blank" rel="noreferrer">{link}</a>;
          } else {
            arr[i] = <span style={{ color: 'wheat' }} key={i}>{data.params[arr[i]]}</span>;
          }
        }
        return arr;
      } catch (e) { }
      return i18n(msg.content);
    }
    return msg.content;
  }

  renderInner() {
    if (!this.props.item) return [];
    const sorted = [...this.props.item.messages].sort((a, b) => String(a._id).localeCompare(String(b._id)));
    return sorted.map((msg) => (
      <Message
        key={msg._id}
        isSelf={msg.from === UserContext._id}
        faceUrl={
          msg.from === UserContext._id
            ? UserContext.avatarUrl
            : this.props.item.authors?.[msg.from]?.avatarUrl || this.props.item.udoc.avatarUrl
        }
      >
        {msg.feedbackId && <div className="messagepad__author">
          {this.props.item.authors?.[msg.from]?.uname || (msg.from === UserContext._id ? UserContext.uname : `UID ${msg.from}`)}
        </div>}
        <div>{this.renderContent(msg)}</div>
        <time data-tooltip={moment(mongoId(msg._id).timestamp * 1000).format('YYYY-MM-DD HH:mm:ss')}>
          <TimeAgo datetime={mongoId(msg._id).timestamp * 1000} locale={i18n('timeago_locale')} />
        </time>
      </Message>
    ));
  }

  render() {
    return (
      <>
        <div className="messagepad__header">
          {this.props.item?.kind === 'feedback' ? (
            <>
              <div>{i18n('Problem feedback')} · {this.props.item.domainId}</div>
              <a className="messagepad__content__header__title" href={this.props.item.source.url} target="_blank" rel="noreferrer">
                {this.props.item.source.title}
              </a>
            </>
          ) : this.props.item && (
            <a className="messagepad__content__header__title" href={`/user/${this.props.item.udoc._id}`}>
              {`${this.props.item.udoc.uname}(UID: ${this.props.item.udoc._id})`}
            </a>
          )}
        </div>
        <ol className="messagepad__content" style={{ overscrollBehavior: 'contain' }} ref={this.contentRef}>
          {this.props.item?.kind === 'feedback' && <li className="messagepad__feedback-source">
            <p>{i18n('Sent to the domain owner and copied to system administrators.')}</p>
            {this.props.item.quote && <blockquote>{this.props.item.quote}</blockquote>}
          </li>}
          {this.renderInner()}
        </ol>
      </>
    );
  }
});
