import classNames from 'classnames';
import PropTypes from 'prop-types';
import React from 'react';
import { connect } from 'react-redux';
import Icon from 'vj/components/react/IconComponent';
import { i18n, request } from 'vj/utils';

const mapStateToProps = (state) => ({
  activeId: state.activeId,
  item: state.dialogues[state.activeId],
  canReply: state.dialogues[state.activeId]?.kind === 'feedback'
    ? state.dialogues[state.activeId].canReply : state.canSendMessage,
  isPosting: state.activeId !== null
    ? state.isPosting[state.activeId]
    : false,
  inputValue: state.activeId !== null
    ? state.inputs[state.activeId] || ''
    : '',
});

const mapDispatchToProps = (dispatch) => ({
  handleChange(id, value) {
    if (id === null) return;
    dispatch({
      type: 'DIALOGUES_INPUT_CHANGED',
      payload: value,
      meta: {
        dialogueId: id,
      },
    });
  },
  postSend(item, value) {
    const req = request.post('', {
      ...(item.kind === 'feedback'
        ? { operation: 'feedback_reply', feedbackId: item.feedbackId }
        : { operation: 'send', uid: item._id }),
      content: value,
    });
    return dispatch({
      type: 'DIALOGUES_POST_SEND',
      payload: req,
      meta: {
        dialogueId: item._id,
      },
    }).catch(() => {
      // The rejected action reports the error and retains the draft for retry.
    });
  },
});

export default connect(mapStateToProps, mapDispatchToProps)(class MessagePadInputContainer extends React.PureComponent {
  inputRef = React.createRef();

  static contextTypes = {
    store: PropTypes.object,
  };

  componentDidUpdate(prevProps) {
    this.focusInput = (
      this.props.activeId !== prevProps.activeId
      || (prevProps.isPosting !== this.props.isPosting && this.props.isPosting === false)
    );
    if (this.focusInput) {
      const { scrollX, scrollY } = window;
      this.inputRef.current?.focus();
      window.scrollTo(scrollX, scrollY);
    }
  }

  handleKeyDown(ev) {
    if (ev.keyCode === 13 && (ev.ctrlKey || ev.metaKey)) {
      this.submit();
    }
  }

  submit() {
    if (!this.props.canReply || !this.props.item || this.props.isPosting || !this.props.inputValue.trim()) return;
    this.props.postSend(
      this.props.item,
      this.props.inputValue,
    );
  }

  render() {
    if (!this.props.canReply) return null;
    const cn = classNames('messagepad__input', {
      visible: this.props.activeId !== null,
    });
    return (
      <div className={cn}>
        <div className="messagepad__textarea-container">
          <textarea
            ref={this.inputRef}
            data-markdown={this.props.item?.kind === 'feedback' ? undefined : true}
            maxLength={this.props.item?.kind === 'feedback' ? 2000 : undefined}
            placeholder={this.props.item?.kind === 'feedback' ? i18n('Add information about this feedback') : ''}
            disabled={this.props.isPosting}
            value={this.props.inputValue}
            onKeyDown={(ev) => this.handleKeyDown(ev)}
            onChange={(ev) => this.props.handleChange(this.props.activeId, ev.target.value)}
          />
        </div>
        <button
          disabled={!this.props.inputValue.trim().length || this.props.isPosting}
          onClick={() => this.submit()}
        >
          <Icon name="send" />
        </button>
      </div>
    );
  }
});
