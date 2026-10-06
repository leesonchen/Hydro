import classNames from 'classnames';
import PropTypes from 'prop-types';
import React from 'react';
import { connect } from 'react-redux';
import Icon from 'vj/components/react/IconComponent';
import { i18n } from 'vj/utils';
import MessagePadDialogueContent from './MessagePadDialogueContentContainer';
import MessagePadDialogueList from './MessagePadDialogueListContainer';
import MessagePadInput from './MessagePadInputContainer';

const mapStateToProps = (state) => {
  const item = state.dialogues[state.activeId];
  return {
    canSendMessage: state.canSendMessage,
    isFeedback: item?.kind === 'feedback',
    canReply: item?.kind === 'feedback' ? item.canReply : state.canSendMessage,
  };
};

export default connect(mapStateToProps)(class MessagePadContainer extends React.PureComponent {
  static propTypes = {
    onAdd: PropTypes.func.isRequired,
  };

  render() {
    return (
      <div className={classNames('messagepad clearfix', {
        'messagepad--feedback': this.props.isFeedback,
        'messagepad--readonly': !this.props.canReply,
      })}>
        <div className="messagepad__sidebar">
          <div className="section__header">
            {this.props.canSendMessage ? <button
              onClick={() => this.props.onAdd()}
              className="primary rounded button"
            >
              <Icon name="add" />
              {' '}
              {i18n('New')}
            </button> : <span>{i18n('Messages')}</span>}
          </div>
          <MessagePadDialogueList />
        </div>
        <MessagePadDialogueContent />
        <MessagePadInput />
      </div>
    );
  }
});
